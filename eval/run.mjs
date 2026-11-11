// Eval runner for the FirstRing NYC 311 voice agent.
// Spawns its own server on port 8081, plays synthetic caller audio over the /call WebSocket,
// and classifies each call into one of five buckets.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const PORT = 8081;
const CHUNK = 3200; // 100 ms of 16 kHz PCM16 mono
const CALL_TIMEOUT_MS = 60_000;
const GRACE_MS = 1500;
const GAP_MS = 2000;
const BUCKETS = ['filed_correct', 'filed_wrong', 'asked_clarification', 'handed_off', 'network_error'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- CLI ----------
function parseArgs(argv) {
  const a = { set: 'dev', ids: null, limit: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--set') { a.set = v; i++; }
    else if (k === '--ids') { a.ids = v.split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (k === '--limit') { a.limit = Number(v); i++; }
    else if (k === '--out') { a.out = v; i++; }
  }
  if (!['dev', 'test'].includes(a.set)) throw new Error('--set must be dev or test');
  a.out = path.resolve(a.out || path.join(ROOT, 'eval', `results-${a.set}.json`));
  return a;
}

// ---------- audio ----------
function readWavPcm(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`not a WAV: ${file}`);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const ch = buf.readUInt16LE(off + 10), rate = buf.readUInt32LE(off + 12), bits = buf.readUInt16LE(off + 22);
      if (ch !== 1 || rate !== 16000 || bits !== 16) console.warn(`  warn: ${path.basename(file)} is ${ch}ch ${rate}Hz ${bits}bit`);
    }
    if (id === 'data') return buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk: ${file}`);
}

const voiceKey = (v) => String(v || 'samantha').split(/\s+/)[0].toLowerCase();

// ---------- server ----------
async function portInUse(port) {
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; }
}

async function startServer() {
  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use; stop that process first`);
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), TICKETS_FILE: path.join(DATA, 'tickets.jsonl') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = fs.createWriteStream(path.join(ROOT, 'eval', 'server.log'), { flags: 'a' });
  child.stdout.pipe(logFile); child.stderr.pipe(logFile);
  const model = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start within 15 s')), 15_000);
    child.stdout.on('data', (d) => {
      const m = String(d).match(/FirstRing on .*\(model ([^)]+)\)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with code ${code}; see eval/server.log`)); });
  });
  return { child, model };
}

// ---------- one call ----------
function runCall(item, source) {
  return new Promise((resolve) => {
    const utterancePcm = readWavPcm(path.join(DATA, item.audio));
    const confirmPcm = readWavPcm(path.join(DATA, 'eval_audio_nyc', 'confirm', `${voiceKey(item.tts_voice)}.wav`));
    const streetNums = (item.utterance.match(/\b\d+\b/g) || []);

    const transcript = []; // [{role, text}]
    const push = (role, text) => {
      const last = transcript[transcript.length - 1];
      if (last && last.role === role) last.text += text; else transcript.push({ role, text });
    };

    let phase = 'opening'; // opening -> streaming -> listening
    let agentTextSinceCaller = '';
    let actedSinceCaller = false;
    let confirmSent = false;
    let decideTimer = null;
    let pendingDecision = false;
    let done = false;
    let streamAbort = false;
    const t0 = Date.now();

    const result = {
      id: item.id,
      expected: { complaint_type: item.expected_complaint_type, descriptor: item.expected_descriptor, agency: item.expected_agency },
      got: { complaint_type: null, descriptor: null, agency: null },
      bucket: null, agency_match: null, descriptor_match: null, clarification: null,
      transcript, seconds_to_ticket: null, note: null,
    };

    let ws;
    const finish = (bucket, note) => {
      if (done) return; done = true; streamAbort = true;
      clearTimeout(timeout); clearTimeout(decideTimer);
      result.bucket = bucket;
      if (note) result.note = note;
      result.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hangup' })); } catch { /* closing */ }
      try { ws.close(); } catch { /* closed */ }
      resolve(result);
    };
    const timeout = setTimeout(() => finish('network_error', 'timeout 60s'), CALL_TIMEOUT_MS);

    async function stream(pcm) {
      phase = 'streaming';
      agentTextSinceCaller = '';
      actedSinceCaller = false;
      pendingDecision = false;
      for (let i = 0; i < pcm.length && !streamAbort; i += CHUNK) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(pcm.subarray(i, i + CHUNK));
        await sleep(100);
      }
      const zero = Buffer.alloc(CHUNK);
      for (let i = 0; i < 15 && !streamAbort; i++) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(zero);
        await sleep(100);
      }
      if (done) return;
      phase = 'listening';
      if (pendingDecision) scheduleDecision();
    }

    function scheduleDecision() {
      clearTimeout(decideTimer);
      decideTimer = setTimeout(decide, GRACE_MS);
    }

    function decide() {
      if (done || actedSinceCaller || !agentTextSinceCaller.trim()) return;
      const text = agentTextSinceCaller.trim();
      const isReadBack = /\b(right|correct)\?/i.test(text) || streetNums.some((n) => new RegExp(`\\b${n}\\b`).test(text));
      if (isReadBack && !confirmSent) {
        confirmSent = true;
        stream(confirmPcm);
        return;
      }
      result.clarification = text;
      finish('asked_clarification', isReadBack ? 'read-back repeated after confirmation' : undefined);
    }

    try {
      ws = new WebSocket(`ws://localhost:${PORT}/call?source=${encodeURIComponent(source)}`);
    } catch (e) {
      finish('network_error', `connect: ${e.message}`);
      return;
    }
    ws.on('error', (e) => finish('network_error', `ws error: ${e.message}`));
    ws.on('close', () => finish('network_error', 'socket closed before outcome'));
    ws.on('message', (data, isBinary) => {
      if (isBinary || done) return;
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      switch (m.type) {
        case 'agent':
          push('agent', m.text);
          agentTextSinceCaller += m.text;
          break;
        case 'caller':
          push('caller', m.text);
          break;
        case 'turn-complete':
          if (phase === 'opening') {
            if (agentTextSinceCaller.trim()) setTimeout(() => { if (!done) stream(utterancePcm); }, 500);
            return;
          }
          if (actedSinceCaller || !agentTextSinceCaller.trim()) return;
          if (phase === 'streaming') { pendingDecision = true; return; }
          scheduleDecision();
          break;
        case 'tool': {
          transcript.push({ role: 'tool', text: `${m.name} ${JSON.stringify(m.args)} -> ${JSON.stringify(m.response)}` });
          if (m.name === 'create_service_request' && m.response && !m.response.error) {
            actedSinceCaller = true;
            const r = m.response;
            result.got = { complaint_type: r.complaint_type ?? m.args?.complaint_type, descriptor: r.descriptor ?? m.args?.descriptor, agency: r.agency ?? null };
            result.agency_match = result.got.agency === item.expected_agency;
            result.descriptor_match = String(result.got.descriptor || '').toLowerCase() === String(item.expected_descriptor || '').toLowerCase();
            result.seconds_to_ticket = m.t;
            finish(result.got.complaint_type === item.expected_complaint_type ? 'filed_correct' : 'filed_wrong');
          } else if (m.name === 'transfer_to_human') {
            actedSinceCaller = true;
            result.got.complaint_type = m.args?.complaint_type || null;
            result.seconds_to_ticket = m.t;
            finish('handed_off');
          } else {
            // Any other tool call means the agent is still working; wait for its next turn.
            clearTimeout(decideTimer);
          }
          break;
        }
        case 'error':
          finish('network_error', `server error: ${m.message}`);
          break;
        case 'live-closed':
          finish('network_error', `live closed ${m.code} ${m.reason || ''}`.trim());
          break;
        case 'ended':
          finish('network_error', `ended: ${m.reason}`);
          break;
        default:
          break;
      }
    });
  });
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  let items = JSON.parse(fs.readFileSync(path.join(DATA, `eval_${args.set === 'dev' ? 'dev30' : 'test20'}.json`), 'utf8'));
  if (args.ids) items = items.filter((x) => args.ids.includes(x.id));
  if (args.limit) items = items.slice(0, args.limit);
  if (!items.length) throw new Error('no calls selected');

  const { child, model } = await startServer();
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; try { child.kill('SIGTERM'); } catch { /* gone */ } } };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('exit', stop);

  const out = {
    set: args.set, model, started_at: new Date().toISOString(), finished_at: null,
    counts: Object.fromEntries([...BUCKETS.map((b) => [b, 0]), ['total', 0]]),
    agency_correct: 0, calls: [],
  };
  const write = () => {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
  };
  write();

  console.log(`set=${args.set} model=${model} calls=${items.length} -> ${path.relative(ROOT, args.out)}`);
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let r;
      try { r = await runCall(item, `eval-${args.set}`); }
      catch (e) { r = { id: item.id, bucket: 'network_error', note: e.message, transcript: [] }; }
      out.calls.push(r);
      out.counts[r.bucket]++; out.counts.total++;
      if (r.agency_match) out.agency_correct++;
      write();
      const detail = r.bucket.startsWith('filed')
        ? `got="${r.got.complaint_type}" exp="${item.expected_complaint_type}" agency=${r.agency_match ? 'ok' : 'x'} desc=${r.descriptor_match ? 'ok' : 'x'} t=${r.seconds_to_ticket}s`
        : r.bucket === 'asked_clarification' ? `q="${(r.clarification || '').slice(0, 100)}"`
          : r.note || '';
      console.log(`[${i + 1}/${items.length}] ${item.id.padEnd(8)} ${r.bucket.padEnd(19)} ${detail}`);
      if (i < items.length - 1) await sleep(GAP_MS);
    }
  } finally {
    out.finished_at = new Date().toISOString();
    write();
    stop();
  }
  const c = out.counts;
  console.log(`\nSummary (${c.total}): filed_correct=${c.filed_correct} filed_wrong=${c.filed_wrong} asked_clarification=${c.asked_clarification} handed_off=${c.handed_off} network_error=${c.network_error} | agency_correct=${out.agency_correct}`);
}

main().catch((e) => { console.error('eval failed:', e.message); process.exitCode = 1; });
