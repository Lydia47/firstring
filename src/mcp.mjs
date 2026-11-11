// MCP server for AI agents (Streamable HTTP, stateless). Same handlers and checks as the REST API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  findComplaintType, createServiceRequest, lookupRequestStatus, TYPES, BOROUGHS,
  detectEmergency, logEmergency, EMERGENCY_MESSAGE,
} from './tools.mjs';
import { requireToken } from './api.mjs';

const result = (out) => ({
  content: [{ type: 'text', text: JSON.stringify(out) }],
  ...(out && out.error ? { isError: true } : {}),
});

function buildServer() {
  const server = new McpServer({ name: 'firstring-311', version: '0.1.0' });

  server.registerTool('find_complaint_type', {
    description: 'Search the official NYC 311 complaint types. Returns up to 5 candidates with definitions and agency, plus a clarifying question when candidates are easily confused.',
    inputSchema: { query: z.string().describe('The problem in the resident\'s words, in English.') },
  }, async ({ query }) => result(findComplaintType({ query })));

  server.registerTool('create_service_request', {
    description: 'File a NYC 311 service request. Only call after reading back the type and full address to the resident and getting an explicit yes.',
    inputSchema: {
      complaint_type: z.enum(TYPES),
      descriptor: z.string().describe('Sub-type, one of the descriptors for that complaint type.'),
      location: z.string().describe('Street address or intersection, in English.'),
      borough: z.enum(BOROUGHS),
      details: z.string().optional().describe('One short English sentence describing the problem.'),
      on_behalf_of: z.string().optional().describe('The resident\'s name, when an AI assistant files for them.'),
      confirmed_by_resident: z.boolean().describe('True only after the resident confirmed the read-back.'),
    },
  }, async (args) => {
    const hit = detectEmergency(`${args.details || ''} ${args.descriptor || ''}`);
    if (hit) {
      logEmergency({ channel: 'api', keyword: hit, where: 'mcp create_service_request' });
      return result({ error: EMERGENCY_MESSAGE, emergency: true });
    }
    return result(createServiceRequest(args, { channel: 'api', source: 'demo' }));
  });

  server.registerTool('lookup_request_status', {
    description: 'Look up the status of an existing 311 request by its number.',
    inputSchema: { request_id: z.string() },
  }, async ({ request_id }) => result(lookupRequestStatus({ request_id })));

  return server;
}

export function mountMcp(app) {
  app.post('/mcp', requireToken, async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP error:', e.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  // Stateless mode: no server-initiated streams or sessions to delete.
  const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', requireToken, notAllowed);
  app.delete('/mcp', requireToken, notAllowed);
}
