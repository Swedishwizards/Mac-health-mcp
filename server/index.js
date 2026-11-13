#!/usr/bin/env node
'use strict';
/**
 * Mac Health MCP server.
 *
 * A dependency-free Model Context Protocol server (stdio transport) that lets
 * Claude and other MCP clients check the health of a Mac.
 * Everything runs locally and read-only: no network requests, no telemetry, no admin password.
 */

const pkg = require('../package.json');
const { ToolError } = require('./lib/exec');
const { collectOverview } = require('./lib/collect');
const { buildOverview, summarizeOverview } = require('./lib/overview');
const { scrub, localContext } = require('./lib/privacy');

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------- tools ----------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'get_mac_overview',
    title: 'Mac health overview',
    description:
      'Health check of this Mac: model, macOS version, uptime, CPU load, memory pressure (incl. swap), '
      + 'free disk space on the startup disk, battery (charge, health, cycles) and thermal throttling. '
      + 'Each part gets a grade: "Bra" (good), "Okej" (ok) or "Behöver åtgärd" (needs attention), plus advice. '
      + 'Use it when the user asks how their Mac is doing or why it is slow. Read-only, local, no admin password.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Mac health overview', ...READ_ONLY },
    handler: overviewTool,
  },
];

function checkArgs(args, schema) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolError('Arguments must be an object.', { code: 'invalid_arguments' });
  for (const k of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, k)) throw new ToolError(`Unknown argument: ${k}`, { code: 'invalid_arguments' });
  }
  return args;
}

async function overviewTool() {
  if (process.platform !== 'darwin') {
    throw new ToolError(`Mac Health only works on macOS (this is ${process.platform}).`, { code: 'unsupported' });
  }
  const { raw, failures } = await collectOverview();
  return buildOverview(raw, { failures });
}

const SUMMARIES = { get_mac_overview: summarizeOverview };

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req) || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    // JSON-RPC 2.0: an invalid request object gets -32600, with its id if it has a usable one.
    const rid = req && typeof req === 'object' && (typeof req.id === 'string' || typeof req.id === 'number') ? req.id : null;
    return replyError(rid, -32600, 'Invalid Request');
  }
  const { id, method, params } = req;
  const isRequest = id !== undefined && id !== null;
  if (!isRequest) return; // notifications (initialized, cancelled, ...) need no answer

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mac-health', title: 'Mac Health', version: pkg.version },
        instructions: 'Use get_mac_overview for a graded health check of this Mac (uptime, CPU, memory, disk, battery, heat). All tools are read-only and local.',
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ handler, ...t }) => t) });
    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return replyError(id, -32602, `Unknown tool: ${name}`);
      try {
        const args = checkArgs(params.arguments, tool.inputSchema);
        // Privacy: strip serials, UUIDs, hardware IDs, user names and home paths before anything leaves.
        const ctx = localContext();
        const data = scrub(await tool.handler(args), ctx);
        const text = scrub(SUMMARIES[name](data), ctx);
        return reply(id, {
          content: [
            { type: 'text', text },
            { type: 'text', text: JSON.stringify(data, null, 2) },
          ],
          structuredContent: data,
          isError: false,
        });
      } catch (e) {
        const err = e instanceof ToolError ? e : new ToolError(`Unexpected error: ${e && e.message ? e.message : e}`, { code: 'internal_error' });
        const payload = scrub({ error: err.message, code: err.code, hint: err.hint, platform: process.platform }, localContext());
        return reply(id, {
          content: [{ type: 'text', text: payload.hint ? `${payload.error}\nHow to fix: ${payload.hint}` : payload.error }],
          structuredContent: payload,
          isError: true,
        });
      }
    }
    case 'resources/list': return reply(id, { resources: [] });
    case 'prompts/list': return reply(id, { prompts: [] });
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      if (Array.isArray(msg) && msg.length === 0) {
        replyError(null, -32600, 'Invalid Request');
        continue;
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      for (const m of batch) {
        handle(m).catch((e) => {
          if (m && m.id != null) replyError(m.id, -32603, String(e && e.message ? e.message : e));
        });
      }
    }
  });
  // When the client closes stdin, Node exits on its own once in-flight calls have replied.
  process.stdin.resume();
}

if (require.main === module) main();

module.exports = { handle, TOOLS };
