'use strict';
// collectDisk with a fake runner: no real commands are run.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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

// ---------- reserve and error cases with fake runners (no real commands) ----------

const { collectOverview, collectMemory, collectBattery, collectThermal, collectStartup, COMMANDS, MEMORY_COMMANDS } = require('../server/lib/collect');

test('collectOverview: keeps stdout from a failing command, explains empty and missing ones', async () => {
  const runner = async (file, args, opts) => {
    assert.equal(opts.env.LC_ALL, 'C', 'commands run with a fixed C locale');
    assert.ok(path.isAbsolute(file), `${file} is an absolute path`);
    if (file === '/usr/sbin/sysctl') return { code: 1, stdout: 'hw.model: Mac14,2\n', stderr: 'unknown oid' };
    if (file === '/usr/bin/sw_vers') return { code: 0, stdout: '   \n', stderr: '' };
    if (file === '/usr/bin/uptime') return { code: 1, stdout: '', stderr: 'broken' };
    if (file === '/usr/bin/vm_stat') return { code: -1, stdout: '', stderr: '', timedOut: true };
    if (file === '/usr/sbin/ioreg') return { code: 0, stdout: '', stderr: '' };
    return { code: -1, stdout: '', stderr: '', missing: true };
  };
  const { raw, failures } = await collectOverview({ runner });
  assert.equal(raw.sysctl, 'hw.model: Mac14,2\n');
  assert.equal(failures.sysctl, undefined);
  assert.equal(raw.sw_vers, null);
  assert.equal(failures.sw_vers, 'misslyckades', 'whitespace only counts as no output');
  assert.equal(failures.uptime, 'misslyckades');
  assert.equal(failures.vm_stat, 'tog för lång tid');
  assert.equal(failures.df, 'saknas på den här datorn');
  assert.equal(raw.ioreg_battery, null);
  assert.equal(failures.ioreg_battery, undefined, 'no battery (empty ioreg, exit 0) is not a failure');
  assert.deepEqual(Object.keys(raw).sort(), Object.keys(COMMANDS).sort());
});

test('collectOverview: ioreg that really fails is reported', async () => {
  const runner = async (file) => (file === '/usr/sbin/ioreg' ? { code: -1, stdout: '', stderr: '', missing: true } : { code: 0, stdout: 'x\n', stderr: '' });
  const { failures } = await collectOverview({ runner });
  assert.deepEqual(failures, { ioreg_battery: 'saknas på den här datorn' });
});

test('collectMemory runs exactly the memory commands and records failures', async () => {
  const seen = [];
  const runner = async (file, args) => {
    seen.push([file, args]);
    return file === '/usr/bin/memory_pressure' ? { code: -1, stdout: '', stderr: '', timedOut: true } : { code: 0, stdout: 'ok\n', stderr: '' };
  };
  const { raw, failures } = await collectMemory({ runner });
  assert.deepEqual(seen.map(([f]) => f).sort(), Object.values(MEMORY_COMMANDS).map(([f]) => f).sort());
  assert.equal(raw.memory_pressure, null);
  assert.deepEqual(failures, { memory_pressure: 'tog för lång tid' });
  assert.equal(raw.vm_stat, 'ok\n');
});

test('collectBattery and collectThermal: missing pmset is reported, an empty ioreg is not', async () => {
  const runner = async (file) => (file === '/usr/bin/pmset'
    ? { code: -1, stdout: '', stderr: '', missing: true }
    : { code: 1, stdout: '', stderr: '' });
  const bat = await collectBattery({ runner });
  assert.deepEqual(bat.failures, { pmset_batt: 'saknas på den här datorn' });
  const th = await collectThermal({ runner });
  assert.deepEqual(th.failures, { pmset_therm: 'saknas på den här datorn' });
  assert.equal(th.raw.pmset_therm, null);
});

test('collectThermal: a timed-out ioreg is still reported', async () => {
  const runner = async (file) => (file === '/usr/sbin/ioreg'
    ? { code: -1, stdout: '', stderr: '', timedOut: true }
    : { code: 0, stdout: 'CPU_Speed_Limit = 100\n', stderr: '' });
  const th = await collectThermal({ runner });
  assert.deepEqual(th.failures, { ioreg_battery: 'tog för lång tid' });
});

test('collectDisk: missing home, other read errors and an empty home folder', async () => {
  const { runner } = fakeRunner({});
  const enoent = await collectDisk({ runner, home: HOME, listDir: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  assert.equal(enoent.failures.du, 'hittade ingen hemkatalog');
  assert.equal(enoent.raw.du_stderr, '');
  const other = await collectDisk({ runner, home: HOME, listDir: () => { throw new Error('weird'); } });
  assert.equal(other.failures.du, 'misslyckades');
  const empty = await collectDisk({ runner, home: HOME, listDir: () => [] });
  assert.equal(empty.failures.du, undefined, 'an empty home folder is not a failure');
  assert.equal(empty.raw.du_stdout, '');
  assert.equal(empty.du_timed_out, false);
});

test('collectDisk: deadline already passed marks every folder unmeasured', async () => {
  const { runner, calls } = fakeRunner({});
  const r = await collectDisk({ runner, home: HOME, listDir: () => [dirent('A'), dirent('B')], duTimeoutMs: 0 });
  assert.equal(r.du_timed_out, true);
  assert.equal(r.failures.du, 'tog för lång tid');
  assert.deepEqual(r.raw.du_unfinished, ['~/A', '~/B']);
  assert.equal(calls.filter((c) => c.file === '/usr/bin/du').length, 0);
  assert.doesNotMatch(JSON.stringify(r.raw.du_unfinished), /testuser/);
});

test('collectDisk: du that fails without output gives its reason; symlinks are skipped', async () => {
  const runner = async (file) => (file === '/usr/bin/du' ? { code: 1, stdout: '', stderr: 'du: denied\n' } : { code: 0, stdout: 'df\n', stderr: '' });
  const link = { name: 'Link', isDirectory: () => true, isSymbolicLink: () => true };
  const r = await collectDisk({ runner, home: HOME, listDir: () => [dirent('A'), link] });
  assert.equal(r.failures.du, 'misslyckades');
  assert.match(r.raw.du_stderr, /denied/);
});

test('collectStartup: an unknown read error is "failed", never thrown', async () => {
  const res = await collectStartup({ home: HOME, readdir: () => { throw new Error('strange'); } });
  assert.deepEqual(res.dirs.map((d) => d.error), ['failed', 'failed', 'failed']);
  assert.ok(res.dirs.every((d) => d.files === null));
});
