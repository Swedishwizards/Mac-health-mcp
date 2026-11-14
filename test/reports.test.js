'use strict';
// Parsers and report builders for top_processes, memory_report and disk_report, tested against
// made-up output in the same format as macOS prints it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const p = require('../server/lib/parse');
const r = require('../server/lib/reports');
const { explainProcess } = require('../server/lib/explain');
const { scrub } = require('../server/lib/privacy');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const HOME = '/Users/testuser';

test('parseTop uses the second sample', () => {
  const t = p.parseTop(fx('top.txt'));
  assert.ok(t.processes.length > 100);
  const first = t.processes[0];
  assert.equal(first.pid, 3120);
  assert.ok(first.cpu_percent > 100, 'second sample has real CPU numbers');
  assert.equal(first.mem_bytes, 8640 * 1024);
  const kernel = t.processes.find((x) => x.pid === 0);
  assert.equal(kernel.mem_bytes, 132 * 1024 ** 2);
  assert.deepEqual(Object.keys(t.cpu_usage), ['user_percent', 'sys_percent', 'idle_percent']);
  assert.equal(p.parseTop(null), null);
  assert.equal(p.parseTop('garbage'), null);
});

test('parseTop handles +/- suffixes and G units', () => {
  const t = p.parseTop('CPU usage: 10.0% user, 5.0% sys, 85.0% idle\nPID    %CPU  MEM\n1  2.5  1112M-\n2  0.0  2G+\n');
  assert.deepEqual(t.processes, [
    { pid: 1, cpu_percent: 2.5, mem_bytes: 1112 * 1024 ** 2 },
    { pid: 2, cpu_percent: 0, mem_bytes: 2 * 1024 ** 3 },
  ]);
  assert.equal(t.cpu_usage.idle_percent, 85);
});

test('parsePs keeps only base name and app bundle, never the path', () => {
  const m = p.parsePs(fx('ps.txt'));
  assert.equal(m.get(158).name, 'WindowServer');
  assert.equal(m.get(158).app, null);
  assert.deepEqual(m.get(5288), { name: 'DemoBrowser Helper (Renderer)', app: 'DemoBrowser', cpu_percent: null });
  const user = m.get(8433); // lives under /Users/testuser/...
  assert.equal(user.name, 'demotool');
  assert.doesNotMatch(JSON.stringify([...m.values()]), /\/|testuser/);
});

test('parsePs reads the optional %cpu column (pid=,%cpu=,comm=)', () => {
  const m = p.parsePs('    1   0.3 /sbin/launchd\n  500 164.6 /usr/local/Exempel/bin/Exempeld\n  501   2,5 /Applications/Demo.app/Contents/MacOS/Demo Helper\n');
  assert.deepEqual(m.get(1), { name: 'launchd', app: null, cpu_percent: 0.3 });
  assert.deepEqual(m.get(500), { name: 'Exempeld', app: null, cpu_percent: 164.6 });
  assert.deepEqual(m.get(501), { name: 'Demo Helper', app: 'Demo', cpu_percent: 2.5 });
});

test('parseDu turns paths into ~/..., counts protected folders and finds the total', () => {
  const d = p.parseDu(fx('du.txt'), fx('du-stderr.txt'), HOME);
  assert.equal(d.folders[0].path, '~/Library');
  assert.equal(d.folders[1].path, '~/Desktop');
  assert.equal(d.total_bytes, 45253264 * 1024);
  assert.equal(d.denied, 12);
  assert.equal(d.other_errors, 0);
  assert.doesNotMatch(JSON.stringify(d), /testuser|\/Users/);
  // Trailing slash on home and odd stderr lines.
  const d2 = p.parseDu(`4\t${HOME}/a\n8\t${HOME}\n`, 'du: something odd\n', `${HOME}/`);
  assert.deepEqual(d2.folders, [{ path: '~/a', bytes: 4096 }]);
  assert.equal(d2.other_errors, 1);
});

test('explainProcess knows the common macOS processes', () => {
  assert.equal(explainProcess('mds_stores').label, 'Spotlight');
  assert.equal(explainProcess('mdworker_shared').label, 'Spotlight');
  assert.equal(explainProcess('kernel_task').label, 'macOS-kärnan');
  assert.equal(explainProcess('WindowServer').label, 'Skärmritning');
  assert.equal(explainProcess('photoanalysisd').label, 'Bilder analyserar');
  assert.equal(explainProcess('bird').label, 'iCloud');
  assert.equal(explainProcess('cloudd').label, 'iCloud');
  assert.equal(explainProcess('backupd').label, 'Time Machine');
  assert.equal(explainProcess('Google Chrome Helper (Renderer)', 'Google Chrome').label, 'Chrome');
  assert.equal(explainProcess('something-unknown'), null);
});

test('buildTopProcesses: names, explanations, grouping and limit', () => {
  const t = r.buildTopProcesses({ top: fx('top.txt'), ps: fx('ps.txt') }, { limit: 5 });
  assert.equal(t.by_cpu.length, 5);
  assert.equal(t.by_memory.length, 5);
  assert.equal(t.by_cpu[0].name, 'DemoAntivirusScanner');
  const kernel = t.by_cpu.find((x) => x.name === 'kernel_task');
  assert.equal(kernel.label, 'macOS-kärnan');
  assert.ok(t.by_cpu.every((x) => x.name !== 'top'), 'our own top run is hidden');
  assert.ok(t.apps.some((a) => a.name === 'DemoBrowser' && a.processes > 1));
  assert.ok(['Bra', 'Okej', 'Behöver åtgärd'].includes(t.grade));
  assert.equal(typeof t.cpu_busy_percent, 'number');
  const text = r.summarizeTopProcesses(t);
  assert.match(text, /^Processer: \[/);
  assert.match(text, /macOS-kärnan: /);
  assert.doesNotMatch(JSON.stringify(t) + text, /\/Users|testuser|\/Applications/);
});

test('buildTopProcesses without top output is "Okänd", not a crash', () => {
  const t = r.buildTopProcesses({ top: null, ps: fx('ps.txt') }, { failures: { top: 'saknas på den här datorn' } });
  assert.equal(t.grade, 'Okänd');
  assert.deepEqual(t.by_cpu, []);
  assert.ok(t.notes.some((n) => /top/.test(n)));
  // Unknown pid in ps falls back to "Okänd".
  const u = r.buildTopProcesses({ top: 'CPU usage: 1.0% user, 1.0% sys, 98.0% idle\nPID %CPU MEM\n99999 5.0 10M\n', ps: '' });
  assert.equal(u.by_cpu[0].name, 'Okänd');
  assert.equal(u.grade, 'Bra');
});

test('buildMemoryReport grades and explains swap, compression and pressure', () => {
  const m = r.buildMemoryReport({ sysctl: fx('sysctl.txt'), memory_pressure: fx('memory_pressure.txt'), vm_stat: fx('vm_stat.txt') });
  assert.ok(['Bra', 'Okej', 'Behöver åtgärd'].includes(m.grade));
  assert.ok(m.explanations.some((e) => /komprimerat/.test(e)));
  assert.ok(m.explanations.some((e) => /swap/.test(e)));
  assert.match(r.summarizeMemoryReport(m), /^Minne: \[/);
  const none = r.buildMemoryReport({}, { failures: { vm_stat: 'misslyckades' } });
  assert.equal(none.grade, 'Okänd');
  assert.deepEqual(none.explanations, []);
  assert.equal(none.notes.length, 1);
});

test('buildDiskReport: free space, largest folders as ~/..., protected folders noted', () => {
  const d = r.buildDiskReport({ df: fx('df.txt'), du_stdout: fx('du.txt'), du_stderr: fx('du-stderr.txt'), home: HOME });
  assert.equal(d.grade, 'Bra');
  assert.equal(d.largest_home_folders[0].path, '~/Library');
  assert.equal(d.largest_home_folders.length, 10);
  assert.equal(d.home_scan_complete, true);
  assert.equal(typeof d.home_total_gb, 'number');
  assert.ok(d.notes.some((n) => /12 mappar kunde inte läsas/.test(n)));
  const text = r.summarizeDiskReport(d);
  assert.match(text, /~\/Library: \d/);
  assert.match(text, /raderar aldrig/);
  assert.doesNotMatch(JSON.stringify(d) + text, /\/Users|testuser/);
});

test('buildDiskReport after a du timeout answers with what it has', () => {
  const partial = fx('du.txt').split('\n').slice(0, 5).join('\n');
  const d = r.buildDiskReport({ df: fx('df.txt'), du_stdout: partial, du_stderr: '', home: HOME }, { duTimedOut: true });
  assert.equal(d.home_scan_complete, false);
  assert.equal(d.home_total_gb, null);
  assert.ok(d.largest_home_folders.length > 0);
  assert.ok(d.notes.some((n) => /tog för lång tid/.test(n)));
  const nothing = r.buildDiskReport({ df: null, du_stdout: '', du_stderr: '', home: HOME }, { failures: { df: 'misslyckades', du: 'tog för lång tid' } });
  assert.equal(nothing.grade, 'Okänd');
  assert.deepEqual(nothing.largest_home_folders, []);
});

test('disk warning thresholds: under 10 % is "Behöver åtgärd"', () => {
  const df = (availK, totalK) => `Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s1s1 ${totalK} 1000 ${availK} 90% 1 2 1% /\n`;
  assert.equal(r.buildDiskReport({ df: df(5, 100) }).grade, 'Behöver åtgärd');
  assert.equal(r.buildDiskReport({ df: df(15, 100) }).grade, 'Okej');
});

test('a user-named folder is scrubbed by the privacy filter', () => {
  const d = r.buildDiskReport({ df: fx('df.txt'), du_stdout: `10\t${HOME}/testuser-stuff\n`, du_stderr: '', home: HOME });
  const out = JSON.stringify(scrub(d, { usernames: ['testuser'] }));
  assert.doesNotMatch(out, /testuser/);
});
