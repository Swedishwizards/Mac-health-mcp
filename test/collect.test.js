'use strict';
// collectDisk with a fake runner: no real commands are run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectDisk, collectProcesses, collectDiagnose } = require('../server/lib/collect');

const HOME = '/Users/testuser';
const dirent = (name, dir = true) => ({ name, isDirectory: () => dir, isSymbolicLink: () => false });

function fakeRunner(sizes, { slow = [] } = {}) {
  const calls = [];
  const runner = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === '/bin/df') return { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1s1 100 50 50 50% /\n', stderr: '' };
    const dir = args[args.length - 1];
    const name = dir.split('/').pop();
    if (slow.includes(name)) return { code: -1, stdout: '', stderr: '', timedOut: true };
    if (name === 'Locked') return { code: 1, stdout: `0\t${dir}\n`, stderr: `du: ${dir}/x: Operation not permitted\n` };
    return { code: 0, stdout: `${sizes[name] || 1}\t${dir}\n`, stderr: '' };
  };
  return { runner, calls };
}

test('collectDisk measures each home folder read-only and adds a total', async () => {
  const { runner, calls } = fakeRunner({ Library: 1000, Downloads: 500 });
  const listDir = () => [dirent('Library'), dirent('Downloads'), dirent('Locked'), dirent('notes.txt', false)];
  const r = await collectDisk({ runner, home: HOME, listDir });
  assert.equal(r.du_timed_out, false);
  const du = calls.filter((c) => c.file === '/usr/bin/du');
  assert.equal(du.length, 3, 'files are skipped');
  for (const c of du) assert.deepEqual(c.args.slice(0, 3), ['-s', '-k', '-x']);
  assert.match(r.raw.du_stdout, new RegExp(`^1500\\t${HOME}$`, 'm'));
  assert.match(r.raw.du_stderr, /Operation not permitted/);
  assert.deepEqual(r.raw.du_unfinished, []);
});

test('collectDisk keeps finished folders when some time out', async () => {
  const { runner } = fakeRunner({ Downloads: 500 }, { slow: ['Library'] });
  const listDir = () => [dirent('Library'), dirent('Downloads')];
  const r = await collectDisk({ runner, home: HOME, listDir });
  assert.equal(r.du_timed_out, true);
  assert.match(r.raw.du_stdout, /Downloads/);
  assert.doesNotMatch(r.raw.du_stdout, new RegExp(`\\t${HOME}\\n`), 'no total when incomplete');
  assert.deepEqual(r.raw.du_unfinished, ['~/Library']);
});

test('collectDisk handles an unreadable home folder', async () => {
  const { runner } = fakeRunner({});
  const listDir = () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; };
  const r = await collectDisk({ runner, home: HOME, listDir });
  assert.equal(r.failures.du, 'nekades åtkomst till hemkatalogen');
  assert.match(r.raw.du_stderr, /Operation not permitted/);
});

test('collectProcesses runs top twice-sampled and ps without a shell', async () => {
  const calls = [];
  const runner = async (file, args) => { calls.push([file, args]); return { code: 0, stdout: 'x\n', stderr: '' }; };
  await collectProcesses({ runner });
  const top = calls.find(([f]) => f === '/usr/bin/top');
  assert.deepEqual(top[1].slice(0, 2), ['-l', '2']);
  assert.ok(calls.some(([f]) => f === '/bin/ps'));
});

test('collectDisk reports "saknas" when du itself is missing', async () => {
  const runner = async (file) => (file === '/usr/bin/du'
    ? { code: -1, stdout: '', stderr: '', missing: true }
    : { code: 0, stdout: 'x\n', stderr: '' });
  const r = await collectDisk({ runner, home: HOME, listDir: () => [dirent('A')] });
  assert.equal(r.failures.du, 'saknas på den här datorn');
});

test('collectDiagnose runs each command once and du only when the disk is nearly full', async () => {
  const disk = fakeRunner({ Library: 1000 });
  const calls = [];
  const runner = async (file, args, opts) => {
    if (file === '/bin/df' || file === '/usr/bin/du') return disk.runner(file, args, opts).then((r) => { calls.push({ file }); return r; });
    calls.push({ file });
    return { code: 0, stdout: `${file} ok\n`, stderr: '' };
  };
  const listDir = () => [dirent('Library')];
  const count = (file) => calls.filter((c) => c.file === file).length;

  const readdir = (d) => (d.endsWith('/Library/LaunchAgents') ? ['com.exampleco.helper.plist'] : []);
  const calm = await collectDiagnose({ runner, home: HOME, listDir, readdir, needFolders: () => false });
  assert.equal(count('/usr/bin/top'), 1, 'top -l 2 only once');
  assert.equal(count('/bin/ps'), 1);
  assert.equal(count('/bin/df'), 1);
  assert.equal(count('/usr/bin/du'), 0, 'no slow du when the disk is fine');
  assert.ok('top' in calm.raw && 'sysctl' in calm.raw);
  assert.equal(calm.raw.du_stdout, undefined);
  assert.equal(calm.raw.startup.dirs.length, 3, 'startup folders are listed (readdir only, no command)');
  assert.ok(calm.raw.startup.dirs.every((d) => !d.dir.includes('testuser')), 'home path replaced by ~');

  calls.length = 0;
  const full = await collectDiagnose({ runner, home: HOME, listDir, readdir, needFolders: () => true });
  assert.equal(count('/bin/df'), 1, 'df is reused for du, not run twice');
  assert.equal(count('/usr/bin/du'), 1);
  assert.match(full.raw.du_stdout, /Library/);
  assert.equal(full.du_timed_out, false);
});

for (const [what, answer, reason] of [
  ['missing', { code: -1, stdout: '', stderr: '', missing: true }, 'saknas på den här datorn'],
  ['timed out', { code: -1, stdout: '', stderr: '', timedOut: true }, 'tog för lång tid'],
]) {
  test(`collectDiagnose + buildDiagnosis when every command is ${what}: no "ser bra ut"`, async () => {
    const { buildDiagnosis, summarizeDiagnosis } = require('../server/lib/diagnose');
    const runner = async () => answer;
    const readdir = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
    const r = await collectDiagnose({ runner, readdir, needFolders: () => true });
    assert.ok(Object.keys(r.failures).length > 0);
    for (const why of Object.values(r.failures)) assert.equal(why, reason);
    const d = buildDiagnosis(r.raw, { failures: r.failures, duTimedOut: r.du_timed_out });
    assert.equal(d.found, 0);
    for (const c of d.checks) assert.equal(c.status, 'okänd', c.check);
    assert.match(d.summary, /gick inte att undersöka just nu/);
    const text = summarizeDiagnosis(d);
    assert.doesNotMatch(text, /ser bra ut/i);
    assert.match(text, new RegExp(reason));
  });
}
