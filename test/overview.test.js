'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildOverview, summarizeOverview, GRADE, formatDuration } = require('../server/lib/overview');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const RAW = {
  sysctl: fx('sysctl.txt'), sw_vers: fx('sw_vers.txt'), uptime: fx('uptime.txt'),
  memory_pressure: fx('memory_pressure.txt'), vm_stat: fx('vm_stat.txt'), df: fx('df.txt'),
  pmset_batt: fx('pmset-batt.txt'), pmset_therm: fx('pmset-therm.txt'), ioreg_battery: fx('ioreg-battery.txt'),
};
const BOOT = 1765194600 * 1000;
const NOW = BOOT + (38 * 86400 + 21 * 3600 + 10 * 60) * 1000; // when the fixtures were captured

test('overview from the fixtures', () => {
  const o = buildOverview(RAW, { now: NOW });
  assert.equal(o.model.model_identifier, 'Mac14,2');
  assert.equal(o.model.chip, 'Apple M2');
  assert.equal(o.model.memory_gb, 8);
  assert.equal(o.macos.version, '26.1');
  assert.equal(o.uptime.uptime_days, 38.9);
  assert.equal(o.uptime.grade, GRADE.BAD);
  assert.equal(o.cpu.load_per_core, 0.73);
  assert.equal(o.cpu.grade, GRADE.OK);
  assert.equal(o.memory.pressure_level, 'varning');
  assert.equal(o.memory.free_percent, 27);
  assert.equal(o.memory.grade, GRADE.OK);
  assert.equal(o.memory.swap_used_gb, 3.2);
  assert.equal(o.disk.free_percent, 24);
  assert.equal(o.disk.total_gb, 460.4);
  assert.equal(o.disk.grade, GRADE.GOOD);
  assert.equal(o.battery.present, true);
  assert.equal(o.battery.charge_percent, 64);
  assert.equal(o.battery.health_percent, 92);
  assert.equal(o.battery.grade, GRADE.GOOD);
  assert.equal(o.thermal.grade, GRADE.GOOD);
  assert.equal(o.overall_grade, GRADE.BAD);
  assert.deepEqual(o.needs_attention, ['uptime']);
  assert.deepEqual(o.could_be_better, ['cpu', 'memory']);
  assert.deepEqual(o.notes, []);
  const text = summarizeOverview(o);
  assert.match(text, /Drifttid: \[Behöver åtgärd\] Igång i 38 dagar 21 h/);
  assert.match(text, /laddar ur/);
});

test('uptime falls back to the uptime command when sysctl is missing', () => {
  const o = buildOverview({ ...RAW, sysctl: null }, { now: NOW, failures: { sysctl: 'saknas på den här datorn' } });
  assert.equal(o.uptime.source, 'uptime');
  assert.equal(o.uptime.uptime_seconds, 38 * 86400 + 21 * 3600 + 10 * 60);
  assert.deepEqual(o.cpu.load_average_1_5_15, [5.84, 5.21, 4.77]);
  assert.equal(o.cpu.grade, GRADE.UNKNOWN); // no core count without sysctl
  assert.equal(o.model.grade, GRADE.UNKNOWN);
  assert.ok(o.notes.some((n) => /sysctl/.test(n)));
});

test('every command missing gives "Okänd" instead of crashing', () => {
  const o = buildOverview({}, { now: NOW });
  for (const k of ['model', 'macos', 'uptime', 'cpu', 'memory', 'disk', 'battery', 'thermal']) {
    assert.equal(o[k].grade, GRADE.UNKNOWN, k);
    assert.ok(o[k].summary);
  }
  assert.equal(o.overall_grade, GRADE.UNKNOWN);
  assert.doesNotThrow(() => summarizeOverview(o));
});

test('grades: healthy Mac', () => {
  const o = buildOverview({
    sysctl: 'hw.ncpu: 8\nhw.memsize: 17179869184\nkern.boottime: { sec = 1000, usec = 0 } x\nvm.loadavg: { 1.00 1.00 1.00 }\nvm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\nkern.memorystatus_vm_pressure_level: 1\n',
    memory_pressure: 'System-wide memory free percentage: 60%\n',
    df: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1s1 1000000 100000 600000 15% /\n',
    pmset_batt: "Now drawing from 'AC Power'\n",
    pmset_therm: 'Note: No thermal warning level has been recorded\n',
  }, { now: (1000 + 86400) * 1000 });
  assert.equal(o.uptime.grade, GRADE.GOOD);
  assert.equal(o.cpu.grade, GRADE.GOOD);
  assert.equal(o.memory.grade, GRADE.GOOD);
  assert.equal(o.disk.grade, GRADE.GOOD);
  assert.equal(o.battery.present, false);
  assert.equal(o.battery.grade, null); // desktop: not graded
  assert.equal(o.thermal.grade, GRADE.GOOD);
  assert.equal(o.overall_grade, GRADE.GOOD);
});

test('grades: struggling Mac', () => {
  const o = buildOverview({
    sysctl: 'hw.ncpu: 4\nvm.loadavg: { 6.00 5.00 4.00 }\nkern.memorystatus_vm_pressure_level: 4\n',
    memory_pressure: 'System-wide memory free percentage: 5%\n',
    df: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1s1 1000000 100000 50000 15% /\n',
    pmset_batt: "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t20%; discharging; 0:40 remaining present: true\n",
    ioreg_battery: '+-o AppleSmartBattery  <class AppleSmartBattery>\n  {\n    "DesignCapacity" = 5000\n    "AppleRawMaxCapacity" = 3500\n    "CycleCount" = 900\n  }\n',
    pmset_therm: 'Note: Thermal warning level set to 2\nCPU_Speed_Limit \t= 60\n',
  }, { now: Date.now() });
  assert.equal(o.cpu.grade, GRADE.BAD);
  assert.equal(o.memory.grade, GRADE.BAD);
  assert.equal(o.disk.grade, GRADE.BAD);
  assert.equal(o.battery.health_percent, 70);
  assert.equal(o.battery.grade, GRADE.BAD);
  assert.equal(o.thermal.grade, GRADE.BAD);
  assert.equal(o.thermal.cpu_speed_limit_percent, 60);
  assert.ok(o.disk.advice && o.memory.advice && o.thermal.advice);
});

test('formatDuration', () => {
  assert.equal(formatDuration(60 * 5), '5 min');
  assert.equal(formatDuration(3600 * 2 + 60), '2 h 1 min');
  assert.equal(formatDuration(86400 + 3600), '1 dag 1 h');
});

test('battery: unreadable pmset and no ioreg gives Okänd, not "no battery"', () => {
  const garbled = buildOverview({ pmset_batt: 'something unexpected\n', ioreg_battery: null }, { now: NOW });
  assert.equal(garbled.battery.grade, GRADE.UNKNOWN);
  assert.doesNotMatch(garbled.battery.summary, /Inget batteri/);
  const desktop = buildOverview({ pmset_batt: "Now drawing from 'AC Power'\n", ioreg_battery: null }, { now: NOW });
  assert.equal(desktop.battery.present, false);
  assert.match(desktop.battery.summary, /Inget batteri/);
});

test('thermal: unreadable pmset -g therm gives Okänd with a readable text', () => {
  const o = buildOverview({ pmset_therm: 'garbled output\n' }, { now: NOW });
  assert.equal(o.thermal.grade, GRADE.UNKNOWN);
  assert.match(o.thermal.summary, /Kunde inte tolka värmestatus/);
  assert.doesNotMatch(o.thermal.summary, /\?/);
  const warn = buildOverview({ pmset_therm: 'Note: Thermal warning level set to 1\n' }, { now: NOW });
  assert.equal(warn.thermal.grade, GRADE.OK);
  assert.equal(warn.thermal.summary, 'Värmevarningsnivå 1');
});

test('uptime: exactly 14 days is not "Behöver åtgärd", over 14 days is (plan: "> 14 dagar")', () => {
  const at = (days) => buildOverview({ sysctl: 'kern.boottime: { sec = 1000, usec = 0 } x\n' }, { now: (1000 + Math.round(days * 86400)) * 1000 });
  assert.equal(at(14).uptime.uptime_days, 14);
  assert.equal(at(14).uptime.grade, GRADE.OK);
  assert.equal(at(14.1).uptime.grade, GRADE.BAD);
});
