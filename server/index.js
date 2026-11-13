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
const { collectDiagnose, collectOverview, collectProcesses, collectMemory, collectDisk, collectBattery, collectThermal, collectStartup } = require('./lib/collect');
const reports = require('./lib/reports');
const { buildOverview, summarizeOverview } = require('./lib/overview');
const { buildDiagnosis, summarizeDiagnosis, needsDiskFolders } = require('./lib/diagnose');
const { scrub, localContext } = require('./lib/privacy');

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------- tools ----------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'diagnose_slowness',
    title: 'Why is my Mac slow?',
    description:
      'Finds the likely reasons why this Mac feels slow and ranks them, most likely first. Checks uptime (over 14 days), '
      + 'memory pressure and swap (over 2 GB, naming the apps using most memory), free disk (under 10 %, naming the largest home folders), '
      + 'single processes over 80 % CPU in two measurements (named and explained), Spotlight indexing, heat throttling (kernel_task) '
      + 'and battery health (under 80 %). Each cause has a plain-Swedish explanation, the number behind it and what the user can do. '
      + 'Use it first when the user asks why their Mac is slow. Takes a few seconds (longer only if the disk is nearly full). Read-only, local.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Why is my Mac slow?', ...READ_ONLY },
    handler: diagnoseTool,
  },
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
  {
    name: 'top_processes',
    title: 'Top processes',
    description:
      'The apps and processes using the most CPU and memory right now (measured over about a second), '
      + 'with plain-language explanations of cryptic macOS names (e.g. mds_stores = Spotlight indexing, '
      + 'kernel_task, WindowServer, bird/cloudd = iCloud, backupd = Time Machine). Helpers are also grouped per app. '
      + 'Only process names are returned, never user names or full paths. Use it when the Mac is slow, hot or the fan is loud. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many processes per list (default 10).' } },
      additionalProperties: false,
    },
    annotations: { title: 'Top processes', ...READ_ONLY },
    handler: topProcessesTool,
  },
  {
    name: 'memory_report',
    title: 'Memory report',
    description:
      'Memory pressure, swap, compressed memory and file cache, explained in plain Swedish with a grade '
      + '("Bra", "Okej", "Behöver åtgärd"). Use it when the user wonders if their Mac has enough RAM or why it is sluggish. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Memory report', ...READ_ONLY },
    handler: memoryTool,
  },
  {
    name: 'disk_report',
    title: 'Disk report',
    description:
      'Free space on the startup disk with a grade and warning when it gets low, plus the largest folders in the home folder '
      + '(shown as ~/Library, ~/Downloads …). Only reads sizes, never deletes anything. Measuring the home folder can take up to about 20 seconds; '
      + 'if it takes longer the tool answers with what it has. Folders protected by macOS are skipped and reported.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Disk report', ...READ_ONLY },
    handler: diskTool,
  },
  {
    name: 'battery_report',
    title: 'Battery report',
    description:
      'Battery health (capacity compared to new), charge cycles, charge state, temperature and tips, with a grade. '
      + 'Desktop Macs without a battery get a calm "no battery" answer. Serial numbers are never returned. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Battery report', ...READ_ONLY },
    handler: batteryTool,
  },
  {
    name: 'thermal_status',
    title: 'Thermal status',
    description:
      'Whether macOS is slowing the processor down because the Mac is too hot (thermal throttling), with a grade and advice. '
      + 'Use it when the Mac is hot, the fan is loud or it suddenly feels slow. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Thermal status', ...READ_ONLY },
    handler: thermalTool,
  },
  {
    name: 'startup_items',
    title: 'Startup items',
    description:
      'What starts automatically: launch agents and daemons in ~/Library/LaunchAgents, /Library/LaunchAgents and /Library/LaunchDaemons, '
      + 'each marked as Apple or third party. Only lists folder contents; never changes or deletes anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Startup items', ...READ_ONLY },
    handler: startupTool,
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

function requireMac() {
  if (process.platform !== 'darwin') {
    throw new ToolError(`Mac Health only works on macOS (this is ${process.platform}).`, { code: 'unsupported' });
  }
}

async function topProcessesTool(args) {
  requireMac();
  let limit = 10;
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 25) {
      throw new ToolError('limit must be a whole number from 1 to 25.', { code: 'invalid_arguments' });
    }
    limit = args.limit;
  }
  const { raw, failures } = await collectProcesses();
  return reports.buildTopProcesses(raw, { limit, failures });
}

async function memoryTool() {
  requireMac();
  const { raw, failures } = await collectMemory();
  return reports.buildMemoryReport(raw, { failures });
}

async function diskTool() {
  requireMac();
  const { raw, failures, du_timed_out: duTimedOut } = await collectDisk();
  return reports.buildDiskReport(raw, { failures, duTimedOut });
}

async function batteryTool() {
  requireMac();
  const { raw, failures } = await collectBattery();
  return reports.buildBatteryReport(raw, { failures });
}

async function thermalTool() {
  requireMac();
  const { raw, failures } = await collectThermal();
  return reports.buildThermalStatus(raw, { failures });
}

async function diagnoseTool() {
  requireMac();
  const { raw, failures, du_timed_out: duTimedOut } = await collectDiagnose({ needFolders: needsDiskFolders });
  return buildDiagnosis(raw, { failures, duTimedOut });
}

async function startupTool() {
  requireMac();
  return reports.buildStartupItems(await collectStartup());
}

const SUMMARIES = {
  diagnose_slowness: summarizeDiagnosis,
  battery_report: reports.summarizeBatteryReport,
  thermal_status: reports.summarizeThermalStatus,
  startup_items: reports.summarizeStartupItems,
  get_mac_overview: summarizeOverview,
  top_processes: reports.summarizeTopProcesses,
  memory_report: reports.summarizeMemoryReport,
  disk_report: reports.summarizeDiskReport,
};

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
        instructions: 'When the user asks why their Mac is slow, start with diagnose_slowness (ranked likely causes with the numbers behind them). Use get_mac_overview for a graded health check of this Mac (uptime, CPU, memory, disk, battery, heat). Dig deeper with top_processes (what is using CPU/memory), memory_report (pressure, swap, compression) disk_report (free space, largest home folders), battery_report, thermal_status and startup_items (what starts automatically). All tools are read-only and local.',
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
