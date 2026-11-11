// Tool handlers shared by every entry point: the voice agent, the REST API and the MCP server.
// The model never decides the agency or the request number: this module does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
export const TICKETS_FILE = process.env.TICKETS_FILE || path.join(DATA, 'tickets.jsonl');
const EMERGENCY_LOG = path.join(DATA, 'emergencies.jsonl');

export const TAXONOMY = JSON.parse(fs.readFileSync(path.join(DATA, 'nyc_taxonomy.json'), 'utf8'));
export const CONFUSABLES = JSON.parse(fs.readFileSync(path.join(DATA, 'nyc_confusables.json'), 'utf8'));
export const TYPES = TAXONOMY.map((t) => t.complaint_type);
export const BOROUGHS = ['MANHATTAN', 'BROOKLYN', 'QUEENS', 'BRONX', 'STATEN ISLAND'];
const BY_TYPE = new Map(TAXONOMY.map((t) => [t.complaint_type, t]));
const GROUP_OF = new Map(CONFUSABLES.flatMap((g) => g.types.map((t) => [t, g])));

// ---------- emergency screen (server-side, not a prompt instruction) ----------
const EMERGENCY_RE = /\b(on fire|house fire|building fire|apartment fire|there'?s a fire|smell(s|ing)? (of )?gas|gas leak|not breathing|can'?t breathe|unconscious|has a gun|with a gun|gunshots?|shots fired|being shot|stabbed|stabbing|overdos\w*|heart attack|carbon monoxide|incendio|fuga de gas|no respira)\b/i;
export const EMERGENCY_MESSAGE = 'This sounds like an emergency. Please hang up and call 911 now.';

export function detectEmergency(text) {
  const m = typeof text === 'string' ? text.match(EMERGENCY_RE) : null;
  return m ? m[0] : null;
}

export function logEmergency(entry) {
  fs.appendFileSync(EMERGENCY_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// ---------- ticket store (append-only JSONL; no call audio is ever stored) ----------
const tickets = [];
if (fs.existsSync(TICKETS_FILE)) {
  for (const line of fs.readFileSync(TICKETS_FILE, 'utf8').split('\n')) {
    if (line.trim()) try { tickets.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
}
const listeners = new Set();
export const onTicket = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const allTickets = () => tickets.slice();

function save(record) {
  tickets.push(record);
  fs.appendFileSync(TICKETS_FILE, JSON.stringify(record) + '\n');
  for (const fn of listeners) try { fn(record); } catch { /* listener errors never block filing */ }
  return record;
}

function newId(prefix) {
  let id;
  do id = `${prefix}-${String(Math.floor(10000 + Math.random() * 90000))}`;
  while (tickets.some((t) => t.request_id === id));
  return id;
}

// ---------- find_complaint_type ----------
const STOP = new Set('a an the of in on at to is it my there and or for with from be are was has have i me we our this that its not no'.split(' '));
const SYNONYMS = { streetlight: 'street light', streetlights: 'street light', lamppost: 'street light lamppost', potholes: 'pothole', pothole: 'pothole street condition', rats: 'rodent', mice: 'rodent', roaches: 'pest', trash: 'garbage collection', heater: 'heat', radiator: 'heat' };
const expand = (s) => (s || '').toLowerCase().replace(/[a-z]+/g, (w) => SYNONYMS[w] || SYNONYMS[w.replace(/s$/, '')] || w);
const words = (s) => expand(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');
const INDEX = TAXONOMY.map((t) => ({
  t,
  name: new Set(words(t.complaint_type).map(stem)),
  body: new Set(words(`${t.definition} ${t.top_descriptors.join(' ')}`).map(stem)),
}));

export function findComplaintType({ query } = {}) {
  const q = words(query).map(stem);
  if (!q.length) return { error: 'Describe the problem in a few words, e.g. "loud music next door".' };
  const scored = INDEX.map(({ t, name, body }) => {
    let s = 0;
    for (const w of q) { if (name.has(w)) s += 3; if (body.has(w)) s += 1; }
    return { t, s: s + Math.log10(t.count_6mo + 10) / 10 };
  }).filter((x) => x.s >= 1).sort((a, b) => b.s - a.s).slice(0, 5);
  const candidates = scored.map(({ t }) => ({ complaint_type: t.complaint_type, definition: t.definition, agency: t.agency, descriptors: t.top_descriptors }));
  const groups = [...new Set(candidates.map((c) => GROUP_OF.get(c.complaint_type)).filter(Boolean))];
  const out = { candidates };
  if (groups.length) out.clarify = groups.map((g) => ({ group: g.group, types: g.types, ask_caller: g.ask, rule: g.rule }));
  if (!candidates.length) out.note = 'No official type matched. If the problem is not a 311 complaint type, transfer to a human.';
  return out;
}

// ---------- create_service_request ----------
export function createServiceRequest(args = {}, ctx = {}) {
  const { complaint_type, descriptor, location, borough, details, on_behalf_of } = args;
  const confirmed = args.confirmed_by_caller ?? args.confirmed_by_resident;
  const t = BY_TYPE.get(complaint_type);
  if (!t) return { error: `"${complaint_type}" is not an official NYC 311 complaint type. Call find_complaint_type and pick one of its candidates.` };
  if (confirmed !== true) return { error: 'Not filed. Read back the type and the full address and get an explicit yes first.' };
  if (!location || String(location).trim().length < 4) return { error: 'Not filed. A street address or intersection is required.' };
  const b = String(borough || '').toUpperCase();
  if (!BOROUGHS.includes(b)) return { error: `Not filed. Borough must be one of ${BOROUGHS.join(', ')}.` };
  const hit = detectEmergency(`${details || ''} ${descriptor || ''}`);
  if (hit) {
    logEmergency({ channel: ctx.channel, keyword: hit, where: 'create_service_request' });
    return { error: EMERGENCY_MESSAGE, emergency: true };
  }
  // One call files one request per problem: a repeated call (echo, retries) returns the ticket already filed.
  if (ctx.call_id) {
    const dup = tickets.find((x) => x.kind === 'request' && x.call_id === ctx.call_id && x.complaint_type === t.complaint_type);
    if (dup) return { request_id: dup.request_id, agency: dup.agency, status: dup.status, complaint_type: dup.complaint_type, descriptor: dup.descriptor, note: 'Already filed on this call; do not file again.' };
  }
  const known = t.top_descriptors.find((d) => d.toLowerCase() === String(descriptor || '').toLowerCase());
  const record = save({
    kind: 'request',
    request_id: newId('311'),
    created_at: new Date().toISOString(),
    status: 'Open',
    complaint_type: t.complaint_type,
    descriptor: known || descriptor || '',
    descriptor_unverified: !known,
    agency: t.agency,
    location: String(location).trim(),
    borough: b,
    details: details || '',
    channel: ctx.channel || 'phone',
    on_behalf_of: on_behalf_of || undefined,
    language: ctx.language || undefined,
    source: ctx.source || 'demo',
    call_id: ctx.call_id,
    call_started_at: ctx.call_started_at,
  });
  return { request_id: record.request_id, agency: record.agency, status: record.status, complaint_type: record.complaint_type, descriptor: record.descriptor };
}

// ---------- lookup_request_status ----------
export function lookupRequestStatus({ request_id } = {}) {
  const id = String(request_id || '').trim().toUpperCase().replace(/^(311)(\d)/, '$1-$2');
  const r = tickets.find((x) => x.request_id.toUpperCase() === id);
  if (!r) return { error: `No request found with number ${request_id}.` };
  return { request_id: r.request_id, status: r.status, agency: r.agency, complaint_type: r.complaint_type, last_update: r.created_at };
}

// ---------- transfer_to_human ----------
export function transferToHuman(args = {}, ctx = {}) {
  const record = save({
    kind: 'handoff',
    request_id: newId('HO'),
    created_at: new Date().toISOString(),
    status: 'handed off',
    reason: args.reason || 'caller asked for a person',
    summary: args.summary || '',
    collected: {
      complaint_type: args.complaint_type || undefined,
      location: args.location || undefined,
      borough: args.borough || undefined,
    },
    channel: ctx.channel || 'phone',
    language: ctx.language || undefined,
    source: ctx.source || 'demo',
    call_id: ctx.call_id,
    call_started_at: ctx.call_started_at,
  });
  return { transferred: true, queue: '311 specialists', handoff_id: record.request_id };
}

// ---------- Live API tool declarations ----------
export const LIVE_TOOLS = [{
  functionDeclarations: [
    {
      name: 'find_complaint_type',
      description: 'Search the official NYC 311 complaint types. Returns up to 5 candidates with definitions and agency, plus a clarifying question when candidates are easily confused.',
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'The problem in the caller\'s words, in English.' } }, required: ['query'] },
    },
    {
      name: 'create_service_request',
      description: 'File a NYC 311 service request. Only call after reading back the type in plain words and the full address, and the caller said yes.',
      parameters: {
        type: 'OBJECT',
        properties: {
          complaint_type: { type: 'STRING', enum: TYPES },
          descriptor: { type: 'STRING', description: 'Sub-type, one of the descriptors for that complaint type.' },
          location: { type: 'STRING', description: 'Street address or intersection, in English.' },
          borough: { type: 'STRING', enum: BOROUGHS },
          details: { type: 'STRING', description: 'One short English sentence describing the problem.' },
          on_behalf_of: { type: 'STRING', description: 'Only when an AI assistant calls for a resident: the resident\'s name.' },
          confirmed_by_caller: { type: 'BOOLEAN', description: 'True only after the caller confirmed your read-back.' },
        },
        required: ['complaint_type', 'descriptor', 'location', 'borough', 'confirmed_by_caller'],
      },
    },
    {
      name: 'lookup_request_status',
      description: 'Look up the status of an existing 311 request by its number.',
      parameters: { type: 'OBJECT', properties: { request_id: { type: 'STRING' } }, required: ['request_id'] },
    },
    {
      name: 'transfer_to_human',
      description: 'Hand the call to a 311 specialist. Use when the caller asks for a person, the issue is not an official 311 type, or you are still unsure after clarifying twice.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: { type: 'STRING' },
          summary: { type: 'STRING', description: 'Two sentences for the specialist: what the caller needs and what you already know.' },
          complaint_type: { type: 'STRING', description: 'Best guess, if any.' },
          location: { type: 'STRING' },
          borough: { type: 'STRING' },
        },
        required: ['reason', 'summary'],
      },
    },
  ],
}];

export function runTool(name, args, ctx) {
  switch (name) {
    case 'find_complaint_type': return findComplaintType(args);
    case 'create_service_request': return createServiceRequest(args, ctx);
    case 'lookup_request_status': return lookupRequestStatus(args);
    case 'transfer_to_human': return transferToHuman(args, ctx);
    default: return { error: `Unknown tool ${name}` };
  }
}
