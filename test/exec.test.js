'use strict';
// run() and ToolError. Uses the Node binary itself as the "command", so it works on any OS
// and never touches real Mac tools or data.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { run, ToolError } = require('../server/lib/exec');

const NODE = process.execPath;

test('run: success gives code 0 and stdout', async () => {
  const r = await run(NODE, ['-e', 'process.stdout.write("hello\\n")']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hello\n');
  assert.equal(r.stderr, '');
  assert.equal(r.error, null);
  assert.equal(r.timedOut, false);
  assert.equal(r.missing, false);
});

test('run: non-zero exit keeps stdout and stderr and never rejects', async () => {
  const r = await run(NODE, ['-e', 'console.log("partial"); console.error("oops"); process.exit(3)']);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, 'partial\n');
  assert.equal(r.stderr, 'oops\n');
  assert.ok(r.error);
  assert.equal(r.timedOut, false);
  assert.equal(r.missing, false);
});

test('run: a missing command is reported as missing, not thrown', async () => {
  const r = await run(path.join(__dirname, 'fixtures', 'no-such-command'), []);
  assert.equal(r.missing, true);
  assert.equal(r.code, -1);
  assert.equal(r.stdout, '');
  assert.equal(r.timedOut, false);
});

test('run: a command that hangs is killed after the timeout', async () => {
  const start = Date.now();
  const r = await run(NODE, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
  assert.equal(r.missing, false);
  assert.ok(Date.now() - start < 10000, 'did not wait for the command');
});

test('run: uses the given environment only (no shell, no inherited variables)', async () => {
  const r = await run(NODE, ['-e', 'process.stdout.write(String(process.env.MH_TEST_VAR) + "|" + String(process.env.MH_OTHER))'],
    { env: { MH_TEST_VAR: 'demo' } });
  assert.equal(r.stdout, 'demo|undefined');
  const shell = await run(NODE, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected); ls'], {});
  assert.equal(shell.stdout, '$(echo injected); ls', 'arguments are passed as-is, never through a shell');
});

test('ToolError defaults and options', () => {
  const plain = new ToolError('x');
  assert.equal(plain.name, 'ToolError');
  assert.equal(plain.code, 'tool_failed');
  assert.equal(plain.hint, null);
  assert.ok(plain instanceof Error);
  const full = new ToolError('y', { code: 'unsupported', hint: 'Use a Mac.' });
  assert.equal(full.code, 'unsupported');
  assert.equal(full.hint, 'Use a Mac.');
});
