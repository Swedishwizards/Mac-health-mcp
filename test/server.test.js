'use strict';
// End-to-end protocol test: starts the real server over stdio with a fake backend (fixtures).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const FAKE = path.join(__dirname, 'fake-backend.js');

function startServer(env = {}) {
  const child = spawn(process.execPath, ['-r', FAKE, SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let next = 1;
  const call = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { child, call, notify };
}

test('MCP handshake, tools/list and get_mac_overview', async () => {
  const { child, call, notify } = startServer();
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'mac-health');
    assert.equal(init.result.serverInfo.version, require('../package.json').version);
    notify('notifications/initialized');

    const list = await call('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['get_mac_overview', 'top_processes', 'memory_report', 'disk_report']);
    for (const t of list.result.tools) {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.openWorldHint, false);
      assert.equal(t.handler, undefined);
    }

    const res = await call('tools/call', { name: 'get_mac_overview', arguments: {} });
    assert.equal(res.result.isError, false);
    const o = res.result.structuredContent;
    assert.equal(o.model.model_identifier, 'Mac14,2');
    assert.equal(o.macos.version, '26.1');
    assert.equal(o.uptime.grade, 'Behöver åtgärd');
    assert.equal(o.disk.grade, 'Bra');
    assert.equal(o.battery.cycle_count, 112);
    for (const k of ['uptime', 'cpu', 'memory', 'disk', 'battery', 'thermal']) {
      assert.ok(['Bra', 'Okej', 'Behöver åtgärd'].includes(o[k].grade), `${k}: ${o[k].grade}`);
    }
    assert.match(res.result.content[0].text, /^Mac-hälsa: Behöver åtgärd/);

    // Privacy: nothing identifying from the fixtures may reach the client.
    const everything = JSON.stringify(res.result);
    assert.doesNotMatch(everything, /FAKESERIAL|XX0000|id=0000000|"serial|uuid|\/Users\//i);

    const bad = await call('tools/call', { name: 'get_mac_overview', arguments: { banana: 1 } });
    assert.equal(bad.result.isError, true);

    const unknown = await call('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);

    const ping = await call('ping', {});
    assert.deepEqual(ping.result, {});

    const missing = await call('nope/method', {});
    assert.equal(missing.error.code, -32601);
  } finally {
    child.kill();
  }
});

test('missing commands give "Okänd" parts, not a crash', async () => {
  const { child, call } = startServer({ FAKE_MISSING: 'pmset_batt,ioreg_battery,pmset_therm,df' });
  try {
    await call('initialize', { protocolVersion: '2024-11-05' });
    const res = await call('tools/call', { name: 'get_mac_overview', arguments: {} });
    assert.equal(res.result.isError, false);
    const o = res.result.structuredContent;
    assert.equal(o.battery.grade, 'Okänd');
    assert.equal(o.thermal.grade, 'Okänd');
    assert.equal(o.disk.grade, 'Okänd');
    assert.equal(o.macos.version, '26.1');
    assert.ok(o.notes.some((n) => /pmset_batt/.test(n)));
  } finally {
    child.kill();
  }
});

function rawExchange(lines, expected) {
  const child = spawn(process.execPath, ['-r', FAKE, SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const msgs = buf.split('\n').filter(Boolean);
      if (msgs.length >= expected) { child.kill(); resolve(msgs.map((l) => JSON.parse(l))); }
    });
    for (const l of lines) child.stdin.write(l + '\n');
  });
}

test('arguments named __proto__ or constructor are rejected', async () => {
  const { child, call } = startServer();
  try {
    for (const k of ['__proto__', 'constructor', 'toString']) {
      const res = await call('tools/call', { name: 'get_mac_overview', arguments: JSON.parse(`{"${k}": 1}`) });
      assert.equal(res.result.isError, true, k);
      assert.equal(res.result.structuredContent.code, 'invalid_arguments', k);
    }
  } finally {
    child.kill();
  }
});

test('invalid requests and an empty batch get -32600 Invalid Request', async () => {
  const out = await rawExchange([
    JSON.stringify({ id: 7, method: 'ping' }), // no jsonrpc
    JSON.stringify({ jsonrpc: '1.0', id: 8, method: 'ping' }),
    '[]',
  ], 3);
  const byId = (id) => out.find((m) => m.id === id);
  assert.equal(byId(7).error.code, -32600);
  assert.equal(byId(8).error.code, -32600);
  const empty = out.find((m) => m.id === null);
  assert.equal(empty.error.code, -32600);
  assert.equal(empty.jsonrpc, '2.0');
});

test('top_processes, memory_report and disk_report over stdio', async () => {
  const { child, call } = startServer();
  try {
    await call('initialize', { protocolVersion: '2025-06-18' });

    const top = await call('tools/call', { name: 'top_processes', arguments: { limit: 3 } });
    assert.equal(top.result.isError, false);
    assert.equal(top.result.structuredContent.by_cpu.length, 3);
    assert.equal(top.result.structuredContent.by_cpu[0].name, 'DemoAntivirusScanner');
    assert.match(top.result.content[0].text, /^Processer: \[/);

    const badLimit = await call('tools/call', { name: 'top_processes', arguments: { limit: 0 } });
    assert.equal(badLimit.result.isError, true);
    assert.equal(badLimit.result.structuredContent.code, 'invalid_arguments');

    const mem = await call('tools/call', { name: 'memory_report', arguments: {} });
    assert.equal(mem.result.isError, false);
    assert.ok(mem.result.structuredContent.explanations.length >= 2);
    assert.match(mem.result.content[0].text, /^Minne: \[/);

    const disk = await call('tools/call', { name: 'disk_report', arguments: {} });
    assert.equal(disk.result.isError, false);
    assert.equal(disk.result.structuredContent.largest_home_folders[0].path, '~/Library');
    assert.match(disk.result.content[0].text, /~\/Downloads/);

    const everything = JSON.stringify([top.result, mem.result, disk.result]);
    assert.doesNotMatch(everything, /\/Users\/|testuser|\/Applications\/|00000000-0000/);
  } finally {
    child.kill();
  }
});

test('disk_report after a du timeout and top_processes without top still answer', async () => {
  const { child, call } = startServer({ FAKE_DU_TIMEOUT: '1', FAKE_MISSING: 'top' });
  try {
    await call('initialize', { protocolVersion: '2024-11-05' });
    const disk = await call('tools/call', { name: 'disk_report', arguments: {} });
    assert.equal(disk.result.isError, false);
    assert.equal(disk.result.structuredContent.home_scan_complete, false);
    assert.ok(disk.result.structuredContent.largest_home_folders.length > 0);
    assert.match(disk.result.content[0].text, /tog för lång tid/);
    assert.deepEqual(disk.result.structuredContent.unmeasured_folders, ['~/Library']);

    const top = await call('tools/call', { name: 'top_processes', arguments: {} });
    assert.equal(top.result.isError, false);
    assert.equal(top.result.structuredContent.grade, 'Okänd');
  } finally {
    child.kill();
  }
});

test('manifest.json lists exactly the tools the server offers', () => {
  const manifest = require('../manifest.json');
  const { TOOLS } = require('../server/index.js');
  assert.deepEqual(manifest.tools.map((t) => t.name), TOOLS.map((t) => t.name));
});
