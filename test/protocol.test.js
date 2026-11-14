'use strict';
// MCP/JSON-RPC edge cases and error paths over stdio, with fake backends (no real Mac data).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const FAKE = path.join(__dirname, 'fake-backend.js');
const FAKE_LINUX = path.join(__dirname, 'fake-linux.js');
const TOOL_NAMES = ['diagnose_slowness', 'get_mac_overview', 'top_processes', 'memory_report', 'disk_report', 'battery_report', 'thermal_status', 'startup_items'];

/** Sends raw lines and collects every reply until `expected` replies arrived (or a short timeout). */
function exchange(lines, expected, { env = {}, preload = FAKE, waitMs = 3000 } = {}) {
  const child = spawn(process.execPath, ['-r', preload, SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const complete = () => buf.split('\n').slice(0, -1).filter(Boolean);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      // Only complete lines (ending in a newline) are parsed: a reply split across chunks is not read half-way.
      resolve(complete().map((l) => JSON.parse(l)));
    };
    const timer = setTimeout(finish, waitMs);
    child.stdout.on('data', (d) => {
      buf += d;
      if (complete().length >= expected) finish();
    });
    for (const l of lines) child.stdin.write(l + '\n');
  });
}

const req = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const callTool = (id, name, args) => req(id, 'tools/call', { name, arguments: args });
const byId = (msgs, id) => msgs.find((m) => m.id === id);

test('broken JSON gets -32700 and the server keeps answering', async () => {
  const out = await exchange(['{not json', req(2, 'ping', {})], 2);
  const parseErr = out.find((m) => m.error && m.error.code === -32700);
  assert.ok(parseErr);
  assert.equal(parseErr.id, null);
  assert.deepEqual(byId(out, 2).result, {});
});

test('notifications get no reply; string ids are echoed back', async () => {
  const out = await exchange([
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }),
    req('abc', 'ping', {}),
  ], 2, { waitMs: 800 });
  assert.equal(out.length, 1, 'only the request with a real id is answered');
  assert.equal(out[0].id, 'abc');
});

test('initialize with an unknown protocol version answers with the newest supported one', async () => {
  const out = await exchange([req(1, 'initialize', { protocolVersion: '1999-01-01' }), req(2, 'initialize', {})], 2);
  assert.equal(byId(out, 1).result.protocolVersion, '2025-11-25');
  assert.equal(byId(out, 2).result.protocolVersion, '2025-11-25');
  assert.deepEqual(byId(out, 1).result.capabilities, { tools: { listChanged: false } });
  assert.match(byId(out, 1).result.instructions, /diagnose_slowness/);
});

test('resources/list and prompts/list are empty; a batch is answered per request', async () => {
  const out = await exchange([
    req(1, 'resources/list', {}),
    req(2, 'prompts/list', {}),
    JSON.stringify([{ jsonrpc: '2.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', id: 4, method: 'nope' }, 5]),
  ], 5);
  assert.deepEqual(byId(out, 1).result, { resources: [] });
  assert.deepEqual(byId(out, 2).result, { prompts: [] });
  assert.deepEqual(byId(out, 3).result, {});
  assert.equal(byId(out, 4).error.code, -32601);
  assert.ok(out.some((m) => m.id === null && m.error.code === -32600), 'a non-object batch item is invalid');
});

test('tools/call without params or name, and with an unknown tool, gives -32602', async () => {
  const out = await exchange([
    req(1, 'tools/call'),
    req(2, 'tools/call', {}),
    callTool(3, 'delete_everything', {}),
    callTool(4, '__proto__', {}),
  ], 4);
  for (const id of [1, 2, 3, 4]) assert.equal(byId(out, id).error.code, -32602, `id ${id}`);
  assert.match(byId(out, 3).error.message, /Unknown tool: delete_everything/);
});

test('invalid arguments are rejected with invalid_arguments, missing arguments are fine', async () => {
  const out = await exchange([
    callTool(1, 'memory_report', [1, 2]),
    callTool(2, 'memory_report', 'text'),
    callTool(3, 'memory_report', 42),
    callTool(4, 'top_processes', { limit: 1.5 }),
    callTool(5, 'top_processes', { limit: 26 }),
    callTool(6, 'top_processes', { limit: '3' }),
    callTool(7, 'top_processes', { limit: 3, extra: true }),
    callTool(8, 'memory_report', null),
    req(9, 'tools/call', { name: 'memory_report' }),
    callTool(10, 'top_processes', { limit: 25 }),
    callTool(11, 'top_processes', { limit: 1 }),
  ], 11);
  for (const id of [1, 2, 3, 4, 5, 6, 7]) {
    const r = byId(out, id).result;
    assert.equal(r.isError, true, `id ${id}`);
    assert.equal(r.structuredContent.code, 'invalid_arguments', `id ${id}`);
    assert.ok(r.content[0].text.length > 0);
  }
  for (const id of [8, 9, 10, 11]) assert.equal(byId(out, id).result.isError, false, `id ${id}`);
  assert.equal(byId(out, 11).result.structuredContent.by_cpu.length, 1);
});

test('an unexpected error becomes internal_error with identifiers filtered out', async () => {
  const lines = TOOL_NAMES.map((n, i) => callTool(i + 1, n, {}));
  const out = await exchange(lines, TOOL_NAMES.length, { env: { FAKE_THROW: 'error', USER: 'testuser' } });
  assert.equal(out.length, TOOL_NAMES.length);
  for (const m of out) {
    assert.equal(m.result.isError, true);
    assert.equal(m.result.structuredContent.code, 'internal_error');
    assert.match(m.result.content[0].text, /^Unexpected error: boom/);
  }
  assert.doesNotMatch(JSON.stringify(out), /testuser|FAKESERIAL|\/Users\/|00000000-1111|aa:bb:cc/i);
});

test('a ToolError keeps its code and hint ("How to fix"), filtered', async () => {
  const out = await exchange([callTool(1, 'disk_report', {})], 1, { env: { FAKE_THROW: 'toolerror', USER: 'testuser' } });
  const r = out[0].result;
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'demo_failed');
  assert.match(r.content[0].text, /\nHow to fix: Open ~\/DemoApp and try again\./);
  assert.doesNotMatch(JSON.stringify(r), /testuser|FAKESERIAL|\/Users\//i);
});

test('off macOS every tool answers "unsupported" without running any command', async () => {
  const lines = TOOL_NAMES.map((n, i) => callTool(i + 1, n, {}));
  const out = await exchange(lines, TOOL_NAMES.length, { preload: FAKE_LINUX });
  assert.equal(out.length, TOOL_NAMES.length);
  for (const m of out) {
    assert.equal(m.result.isError, true);
    assert.equal(m.result.structuredContent.code, 'unsupported');
    assert.equal(m.result.structuredContent.platform, 'linux');
    assert.match(m.result.content[0].text, /only works on macOS \(this is linux\)/);
  }
});

test('privacy filter: no serial, UUID, MAC address, user name or home path leaves any of the 8 tools', async () => {
  const lines = [req(1, 'initialize', { protocolVersion: '2025-06-18' }), ...TOOL_NAMES.map((n, i) => callTool(i + 10, n, {}))];
  const out = await exchange(lines, lines.length, { env: { FAKE_LEAK: '1', USER: 'testuser' } });
  for (const [i, name] of TOOL_NAMES.entries()) {
    const m = byId(out, i + 10);
    assert.ok(m, name);
    const r = m.result;
    assert.equal(r.isError, false, name);
    const all = JSON.stringify(r);
    assert.doesNotMatch(all, /testuser|FAKESERIAL|\/Users\/|00000000-1111|aa:bb:cc|DemoApp-Mac/i, name);
    for (const k of ['serial_number', 'hardware_uuid', 'username', 'home', 'device_name']) {
      assert.equal(Object.hasOwn(r.structuredContent, k), false, `${name}: ${k}`);
    }
    // The leak text is still there, only with the identifiers replaced – the filter redacts, it does not drop text.
    assert.match(r.structuredContent.leak_note, /~\/DemoApp\/data\.db/, name);
    assert.match(all, /\[borttaget\]/, name);
    // Text summary and JSON copy are filtered the same way.
    assert.deepEqual(JSON.parse(r.content[1].text), r.structuredContent, name);
    assert.doesNotMatch(r.content[0].text, /testuser|FAKESERIAL|\/Users\//i, name);
  }
});
