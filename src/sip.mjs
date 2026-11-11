// Minimal SIP softphone front door for FirstRing (demo only).
// Direct SIP over UDP, G.711 PCMU 8 kHz, no auth, no TLS/SRTP, no SBC, no PSTN.
// Each call becomes a WebSocket client of the existing /call bridge, so tools,
// validation, tickets and the ops feed are shared with browser calls.
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

// ---------- G.711 mu-law ----------
const BIAS = 0x84, CLIP = 32635;
function ulawEncode(s) {
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
const ULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0f;
  let s = (((mant << 3) + BIAS) << exp) - BIAS;
  ULAW_DECODE[i] = sign ? -s : s;
}

// 8 kHz mu-law payload -> 16 kHz PCM16 LE (linear interpolation).
function ulaw8kTo16k(payload, state) {
  const out = Buffer.alloc(payload.length * 4);
  let prev = state.last;
  for (let i = 0; i < payload.length; i++) {
    const cur = ULAW_DECODE[payload[i]];
    out.writeInt16LE((prev + cur) >> 1, i * 4);
    out.writeInt16LE(cur, i * 4 + 2);
    prev = cur;
  }
  state.last = prev;
  return out;
}

// 24 kHz PCM16 LE -> 8 kHz samples (average of every 3), carrying leftovers.
function pcm24kTo8k(buf, state) {
  const all = state.rest.length ? Buffer.concat([state.rest, buf]) : buf;
  const n = Math.floor(all.length / 6);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    out[i] = Math.round((all.readInt16LE(o) + all.readInt16LE(o + 2) + all.readInt16LE(o + 4)) / 3);
  }
  state.rest = all.subarray(n * 6);
  return out;
}

// ---------- SIP helpers ----------
function parseSip(text) {
  const [head, ...bodyParts] = text.split('\r\n\r\n');
  const lines = head.split('\r\n');
  const start = lines.shift();
  const headers = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    let k = l.slice(0, i).trim().toLowerCase();
    const short = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type' };
    k = short[k] || k;
    (headers[k] ||= []).push(l.slice(i + 1).trim());
  }
  return { start, headers, body: bodyParts.join('\r\n\r\n') };
}
const h1 = (msg, k) => msg.headers[k]?.[0] || '';
const uriOf = (v) => (v.match(/<([^>]+)>/) || [null, v.split(';')[0]])[1];

function buildResponse(req, code, reason, { toTag, extra = [], body = '' } = {}) {
  let to = h1(req, 'to');
  if (toTag && !/;tag=/.test(to)) to += `;tag=${toTag}`;
  const lines = [
    `SIP/2.0 ${code} ${reason}`,
    ...(req.headers.via || []).map((v) => `Via: ${v}`),
    `From: ${h1(req, 'from')}`,
    `To: ${to}`,
    `Call-ID: ${h1(req, 'call-id')}`,
    `CSeq: ${h1(req, 'cseq')}`,
    'Server: FirstRing-SIP-demo',
    ...extra,
    `Content-Length: ${Buffer.byteLength(body)}`,
    '', body,
  ];
  return lines.join('\r\n');
}

function parseSdp(body) {
  const c = body.match(/^c=IN IP4 (\S+)/m);
  const m = body.match(/^m=audio (\d+) RTP\/AVP ([\d ]+)/m);
  if (!c || !m) return null;
  return { ip: c[1], port: Number(m[1]), pts: m[2].trim().split(/\s+/).map(Number) };
}

export function startSip({ bridgePort, sipPort = Number(process.env.SIP_PORT || 5060) }) {
  const sock = dgram.createSocket('udp4');
  const calls = new Map(); // call-id -> call

  const sendTo = (text, port, addr) => sock.send(Buffer.from(text), port, addr);

  sock.on('message', (buf, rinfo) => {
    const msg = parseSip(buf.toString('utf8'));
    if (!msg.start) return;
    if (msg.start.startsWith('SIP/2.0')) return; // responses to our BYE; nothing to do
    const method = msg.start.split(' ')[0];
    const callId = h1(msg, 'call-id');
    const reply = (code, reason, opts) => sendTo(buildResponse(msg, code, reason, opts), rinfo.port, rinfo.address);

    if (method !== 'ACK') console.log(`[sip] ${method} from ${rinfo.address}:${rinfo.port}`);
    // Softphones register before they let you dial; accept any registration (demo: no auth).
    if (method === 'REGISTER') {
      const contact = h1(msg, 'contact');
      return reply(200, 'OK', { toTag: crypto.randomBytes(4).toString('hex'), extra: [...(contact ? [`Contact: ${contact};expires=3600`] : []), 'Expires: 3600'] });
    }
    if (method === 'OPTIONS') return reply(200, 'OK', { extra: ['Allow: INVITE, ACK, BYE, CANCEL, OPTIONS', 'Accept: application/sdp'] });
    if (method === 'ACK') return;
    if (method === 'BYE') {
      reply(200, 'OK');
      calls.get(callId)?.hangup('caller hung up (BYE)', false);
      return;
    }
    if (method === 'CANCEL') {
      reply(200, 'OK');
      const call = calls.get(callId);
      if (call && !call.answered) {
        sendTo(buildResponse(call.invite, 487, 'Request Terminated', { toTag: call.tag }), rinfo.port, rinfo.address);
        call.hangup('caller cancelled', false);
      }
      return;
    }
    if (method !== 'INVITE') return reply(405, 'Method Not Allowed');

    const existing = calls.get(callId);
    if (existing) { if (existing.okText) sendTo(existing.okText, rinfo.port, rinfo.address); return; } // retransmit or re-INVITE
    const sdp = parseSdp(msg.body);
    if (!sdp || !sdp.pts.includes(0)) return reply(488, 'Not Acceptable Here');
    newCall(msg, sdp, rinfo, reply);
  });

  function newCall(invite, sdp, rinfo, reply) {
    const callId = h1(invite, 'call-id');
    const tag = crypto.randomBytes(4).toString('hex');
    const id = crypto.randomBytes(3).toString('hex');
    const log = (...a) => console.log(`[sip ${id}]`, ...a);
    // Our address as the caller reached it (request-URI host), unless overridden.
    const reqHost = invite.start.split(' ')[1].replace(/^sips?:/, '').split(';')[0].split('@').pop().split(':')[0];
    const localIp = process.env.SIP_PUBLIC_IP || (/^\d+\.\d+\.\d+\.\d+$/.test(reqHost) ? reqHost : '127.0.0.1');
    const call = { invite, tag, answered: false, okText: null, closed: false };
    calls.set(callId, call);
    log('INVITE from', h1(invite, 'from'), 'rtp ->', `${sdp.ip}:${sdp.port}`);
    reply(100, 'Trying');
    reply(180, 'Ringing', { toTag: tag });

    let remote = { address: sdp.ip === '0.0.0.0' ? rinfo.address : sdp.ip, port: sdp.port };
    const rtp = dgram.createSocket('udp4');
    const ssrc = crypto.randomBytes(4).readUInt32BE(0);
    let seq = crypto.randomInt(0, 65535), ts = crypto.randomInt(0, 2 ** 31);
    const upState = { last: 0 }, downState = { rest: Buffer.alloc(0) };
    let outQ = new Int16Array(0);
    const said = { caller: '', agent: '' };
    let ready = false, latched = false, pktsIn = 0, timer = null, ws = null;

    rtp.on('message', (pkt, rr) => {
      if (pkt.length < 12 || (pkt[0] >> 6) !== 2) return;
      if (!latched) { latched = true; remote = { address: rr.address, port: rr.port }; } // symmetric RTP
      if ((pkt[1] & 0x7f) !== 0) return; // only PCMU
      let off = 12 + (pkt[0] & 0x0f) * 4;
      if (pkt[0] & 0x10) off += 4 + pkt.readUInt16BE(off + 2) * 4;
      const payload = pkt.subarray(off);
      if (++pktsIn === 1) log('first RTP packet in');
      if (ready && ws?.readyState === 1) ws.send(ulaw8kTo16k(payload, upState));
    });

    const sendBye = () => {
      const contact = uriOf(h1(invite, 'contact') || h1(invite, 'from'));
      const bye = [
        `BYE ${contact} SIP/2.0`,
        `Via: SIP/2.0/UDP ${localIp}:${sipPort};branch=z9hG4bK${crypto.randomBytes(6).toString('hex')};rport`,
        'Max-Forwards: 70',
        `From: ${h1(invite, 'to')};tag=${tag}`,
        `To: ${h1(invite, 'from')}`,
        `Call-ID: ${callId}`,
        'CSeq: 1 BYE',
        'Content-Length: 0', '', '',
      ].join('\r\n');
      sendTo(bye, rinfo.port, rinfo.address);
    };

    call.hangup = (why, byeToCaller) => {
      if (call.closed) return; call.closed = true;
      log('hangup:', why);
      clearInterval(timer);
      try { rtp.close(); } catch { /* closed */ }
      if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'hangup' })); ws.close(); }
      if (byeToCaller && call.answered) sendBye();
      setTimeout(() => calls.delete(callId), 30000);
    };

    rtp.bind(0, () => {
      const rtpPort = rtp.address().port;
      const body = [
        'v=0', `o=firstring ${Date.now()} 1 IN IP4 ${localIp}`, 's=FirstRing', `c=IN IP4 ${localIp}`, 't=0 0',
        `m=audio ${rtpPort} RTP/AVP 0`, 'a=rtpmap:0 PCMU/8000', 'a=ptime:20', 'a=sendrecv', '',
      ].join('\r\n');
      call.okText = buildResponse(invite, 200, 'OK', {
        toTag: tag,
        extra: [`Contact: <sip:311@${localIp}:${sipPort}>`, 'Content-Type: application/sdp', 'Allow: INVITE, ACK, BYE, CANCEL, OPTIONS'],
        body,
      });
      sendTo(call.okText, rinfo.port, rinfo.address);
      call.answered = true;
      log('answered, local rtp', `${localIp}:${rtpPort}`);

      // 20 ms paced sender: agent audio if queued, otherwise silence.
      const startT = Date.now(); let sent = 0;
      timer = setInterval(() => {
        const due = Math.floor((Date.now() - startT) / 20) - sent;
        for (let k = 0; k < Math.min(due, 5); k++) {
          const pkt = Buffer.alloc(172);
          pkt[0] = 0x80; pkt[1] = 0; pkt.writeUInt16BE(seq, 2); pkt.writeUInt32BE(ts >>> 0, 4); pkt.writeUInt32BE(ssrc, 8);
          for (let i = 0; i < 160; i++) pkt[12 + i] = i < outQ.length ? ulawEncode(outQ[i]) : 0xff;
          outQ = outQ.length > 160 ? outQ.subarray(160) : new Int16Array(0);
          rtp.send(pkt, remote.port, remote.address);
          seq = (seq + 1) & 0xffff; ts = (ts + 160) >>> 0;
        }
        sent += due;
      }, 10);

      ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/call?channel=phone&source=sip`);
      ws.binaryType = 'nodebuffer';
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const s = pcm24kTo8k(data, downState);
          const merged = new Int16Array(outQ.length + s.length); merged.set(outQ); merged.set(s, outQ.length);
          outQ = merged;
          return;
        }
        let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
        if (ev.type === 'ready') { ready = true; log('bridge ready, call', ev.call_id); }
        else if (ev.type === 'caller') said.caller += ev.text;
        else if (ev.type === 'agent') said.agent += ev.text;
        else if (ev.type === 'turn-complete') {
          if (said.caller.trim()) log('caller:', said.caller.trim());
          if (said.agent.trim()) log('agent:', said.agent.trim());
          said.caller = ''; said.agent = '';
        }
        else if (ev.type === 'interrupted') outQ = new Int16Array(0);
        else if (ev.type === 'ticket') log('ticket', ev.record?.request_id || ev.record?.id || '', ev.record?.complaint_type || '');
        else if (ev.type === 'tool') log('tool', ev.name);
        else if (ev.type === 'ended' || ev.type === 'error') log(ev.type, ev.reason || ev.message || '');
      });
      ws.on('close', () => { if (!call.closed) setTimeout(() => call.hangup('bridge closed', true), 2500); }); // let the last words play
      ws.on('error', (e) => log('bridge ws error', e.message));
    });
  }

  sock.bind(sipPort, '0.0.0.0', () => console.log(`SIP softphone demo listening on udp/${sipPort} (dial sip:311@<this-host>:${sipPort})`));
  return sock;
}
