// Simulates a resident's AI assistant filing a 311 request through FirstRing.
// Usage: FIRSTRING_API_TOKEN=... [FIRSTRING_URL=http://localhost:8080] node scripts/agent-demo.mjs [--rest]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.env.FIRSTRING_URL || 'http://localhost:8080').replace(/\/$/, '');
const TOKEN = process.env.FIRSTRING_API_TOKEN;
if (!TOKEN) { console.error('Set FIRSTRING_API_TOKEN.'); process.exit(1); }
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const QUERY = 'streetlight out on my block';
const REQUEST = {
  complaint_type: 'Street Light Condition',
  descriptor: 'Street Light Out',
  location: '540 West 165th Street',
  borough: 'MANHATTAN',
  details: 'The streetlight in front of the building has been out for three nights.',
  on_behalf_of: 'Maria Lopez',
  confirmed_by_resident: true,
};
const say = (who, msg) => console.log(`${who.padEnd(10)} ${msg}`);

function pickType(found) {
  const top = found.candidates?.[0];
  if (!top) throw new Error('No complaint type matched.');
  // Prefer the intended type if it is among the candidates, otherwise the top one.
  return found.candidates.find((c) => c.complaint_type === REQUEST.complaint_type) || top;
}

async function viaMcp() {
  const client = new Client({ name: 'resident-assistant-demo', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: AUTH } }));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const out = JSON.parse(r.content?.[0]?.text || '{}');
    if (r.isError) throw new Error(`${name}: ${out.error || 'error'}`);
    return out;
  };
  const { tools } = await client.listTools();
  say('assistant', `connected to ${BASE}/mcp, tools: ${tools.map((t) => t.name).join(', ')}`);
  say('resident', `"The ${QUERY}."`);
  const found = await call('find_complaint_type', { query: QUERY });
  const pick = pickType(found);
  say('assistant', `top candidates: ${found.candidates.map((c) => c.complaint_type).join(' | ')}`);
  say('assistant', `"I'll report a ${pick.complaint_type.toLowerCase()} at ${REQUEST.location}, ${REQUEST.borough}. OK?"  resident: "Yes."`);
  const filed = await call('create_service_request', { ...REQUEST, complaint_type: pick.complaint_type });
  say('firstring', `filed ${filed.request_id}, routed to ${filed.agency}`);
  const status = await call('lookup_request_status', { request_id: filed.request_id });
  say('firstring', `status of ${status.request_id}: ${status.status} (${status.agency})`);
  await client.close();
  return filed;
}

async function viaRest() {
  const api = async (method, p, body) => {
    const res = await fetch(`${BASE}/api/v1${p}`, {
      method, headers: { ...AUTH, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${out.error}`);
    return out;
  };
  say('assistant', `using REST at ${BASE}/api/v1`);
  const found = await api('GET', `/complaint-types?q=${encodeURIComponent(QUERY)}`);
  const pick = pickType(found);
  say('assistant', `top candidates: ${found.candidates.map((c) => c.complaint_type).join(' | ')}`);
  const filed = await api('POST', '/requests', { ...REQUEST, complaint_type: pick.complaint_type });
  say('firstring', `filed ${filed.request_id}, routed to ${filed.agency}`);
  const status = await api('GET', `/requests/${encodeURIComponent(filed.request_id)}`);
  say('firstring', `status of ${status.request_id}: ${status.status} (${status.agency})`);
  return filed;
}

try {
  const filed = process.argv.includes('--rest') ? await viaRest() : await viaMcp();
  console.log(`\nrequest_id=${filed.request_id} agency=${filed.agency}`);
} catch (e) {
  console.error('Demo failed:', e.message);
  process.exit(1);
}
