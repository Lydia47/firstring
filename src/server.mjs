// FirstRing server: browser <-> WebSocket bridge <-> Gemini Live, plus the REST API for AI agents.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import {
  LIVE_TOOLS, runTool, onTicket, allTickets, detectEmergency, logEmergency, EMERGENCY_MESSAGE,
} from './tools.mjs';
import { apiRouter } from './api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const MAX_CALL_MS = 5 * 60 * 1000;
const IDLE_MS = 60 * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_CALLS || 4);

if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set'); process.exit(1); }
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1beta' } });

export const SYSTEM_PROMPT = `You are FirstRing, the NYC 311 voice agent. Speak naturally and briefly, one question at a time.
You need exactly four things: what the problem is, the street address or intersection, the borough, and the caller's yes to your read-back. Never ask for apartment numbers, names, phone numbers, or whether to stay anonymous; this hotline files anonymously. Infer the descriptor yourself.
As soon as you have the problem, address and borough, read back immediately.
Goal: turn the caller's description into a complete, correctly classified service request.
1. Understand the problem. If unsure of the official type, call find_complaint_type.
2. If the candidates fall in a confusable group, ask that group's clarifying question before choosing, unless the caller already answered it. Ask at most one clarifying question per topic.
3. Get a precise location: street address or intersection, plus borough. Ask only for what is missing.
4. Read back the type in plain words and the full address in one sentence, for example "I'll file a residential noise complaint at 245 East 86th Street, Manhattan. Is that right?" Only after the caller confirms, call create_service_request with confirmed_by_caller=true.
5. Tell the caller the request number and the agency exactly as returned by the tool. Never name an agency, number or status that the tool did not return.
6. Always reply in the caller's language. Ticket fields stay in English.
7. Emergencies (fire, gas smell, crime in progress, medical): tell them to hang up and call 911.
8. If the caller asks for a real person, or the problem is not one of the official 311 types, or you are still unsure after clarifying twice, call transfer_to_human with a short summary, then say "I'm connecting you to a 311 specialist; they'll already have your details."
9. If the caller says they are an AI assistant calling for a resident, serve them the same way, still read back and get a yes, and pass the resident's name as on_behalf_of.
Do not use parentheses, lists or examples in speech.
Opening line: "NYC 311, this is FirstRing. What can I help you with today?"`;

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.use('/audio', express.static(path.join(ROOT, 'data', 'audio')));
app.get('/ops', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'ops.html')));
// Read-only feed for the call screen and the ops view. In production this sits behind the city's SSO.
app.get('/api/ops/tickets', (_req, res) => res.json(allTickets()));
app.use('/api/v1', apiRouter);
try {
  const { mountMcp } = await import('./mcp.mjs');
  mountMcp(app);
} catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') console.error('MCP not mounted:', e.message);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/call' });
let active = 0;

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  if (active >= MAX_CONCURRENT) { send({ type: 'error', message: 'All lines are busy, try again shortly.' }); ws.close(); return; }
  active++;
  const ctx = {
    call_id: crypto.randomUUID().slice(0, 8),
    call_started_at: new Date().toISOString(),
    channel: url.searchParams.get('channel') === 'ai-agent' ? 'ai-agent' : 'phone',
    source: url.searchParams.get('source') || 'demo',
    language: url.searchParams.get('lang') || undefined,
  };
  const t0 = Date.now();
  let closed = false;
  let lastActivity = Date.now();
  let callerText = '';
  let emergencyRaised = false;

  const log = (...a) => console.log(`[${ctx.call_id} ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
  let session, setupSeen = false, kicked = false;
  const kickoff = () => {
    if (kicked) return; kicked = true;
    log('setup complete, opening');
    send({ type: 'ready', call_id: ctx.call_id });
    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '(call connected)' }] }], turnComplete: true });
  };
  const end = (why) => {
    if (closed) return; closed = true; active--;
    log('end', why);
    send({ type: 'ended', reason: why });
    try { session?.close(); } catch { /* already closed */ }
    try { ws.close(); } catch { /* already closed */ }
  };
  const callTimer = setTimeout(() => end('max call length'), MAX_CALL_MS);
  const idleTimer = setInterval(() => { if (Date.now() - lastActivity > IDLE_MS) end('idle'); }, 5000);
  ws.on('close', () => { clearTimeout(callTimer); clearInterval(idleTimer); end('client closed'); });

  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: SYSTEM_PROMPT,
        tools: LIVE_TOOLS,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onerror: (e) => { log('live error', e?.message); send({ type: 'error', message: 'voice service error' }); },
        onclose: (e) => { log('live close', e?.code, e?.reason || ''); send({ type: 'live-closed', code: e?.code, reason: e?.reason || '' }); end('live closed'); },
        onmessage: (m) => onLive(m),
      },
    });
  } catch (e) {
    log('connect failed', e?.message);
    send({ type: 'error', message: 'could not reach the voice service' });
    end('connect failed');
    return;
  }
  if (setupSeen) kickoff();

  function onLive(m) {
    lastActivity = Date.now();
    if (m.setupComplete) { setupSeen = true; if (session) kickoff(); }
    const sc = m.serverContent;
    if (sc) {
      for (const p of sc.modelTurn?.parts || []) {
        if (p.inlineData?.data && ws.readyState === 1) ws.send(Buffer.from(p.inlineData.data, 'base64'));
      }
      if (sc.inputTranscription?.text) {
        callerText += sc.inputTranscription.text;
        send({ type: 'caller', text: sc.inputTranscription.text });
        const hit = !emergencyRaised && detectEmergency(callerText);
        if (hit) {
          emergencyRaised = true;
          logEmergency({ channel: ctx.channel, keyword: hit, where: 'voice', call_id: ctx.call_id });
          send({ type: 'emergency', keyword: hit, message: EMERGENCY_MESSAGE });
          session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: `(system: emergency detected. Say exactly: "${EMERGENCY_MESSAGE}" and nothing else.)` }] }], turnComplete: true });
        }
      }
      if (sc.outputTranscription?.text) send({ type: 'agent', text: sc.outputTranscription.text });
      if (sc.interrupted) send({ type: 'interrupted' });
      if (sc.turnComplete) { send({ type: 'turn-complete' }); log('turn complete'); }
    }
    for (const fc of m.toolCall?.functionCalls || []) {
      if (!session) continue;
      const args = fc.args || {};
      log('tool', fc.name, JSON.stringify(args));
      let response;
      try { response = runTool(fc.name, args, ctx); } catch (e) { response = { error: e.message }; }
      log(' ->', JSON.stringify(response).slice(0, 300));
      send({ type: 'tool', name: fc.name, args, response, t: (Date.now() - t0) / 1000 });
      session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response }] });
    }
    if (m.goAway) log('goAway', JSON.stringify(m.goAway));
  }

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      lastActivity = Date.now();
      session.sendRealtimeInput({ audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
      return;
    }
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'hangup') end('caller hung up');
  });
});

// Push every new ticket to every open call screen.
onTicket((record) => {
  const payload = JSON.stringify({ type: 'ticket', record });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
});

server.listen(PORT, () => console.log(`FirstRing on http://localhost:${PORT}  (model ${MODEL})`));
