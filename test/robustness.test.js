'use strict';
// Every builder + summarizer must survive empty, broken and cut-off command output:
// no crash, no "undefined"/"NaN" in the answer, and missing data reported as unknown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const r = require('../server/lib/reports');
const o = require('../server/lib/overview');
const d = require('../server/lib/diagnose');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const FILES = {
  sysctl: 'sysctl.txt', sw_vers: 'sw_vers.txt', uptime: 'uptime.txt', memory_pressure: 'memory_pressure.txt', vm_stat: 'vm_stat.txt',
  df: 'df.txt', pmset_batt: 'pmset-batt.txt', pmset_therm: 'pmset-therm.txt', ioreg_battery: 'ioreg-battery.txt',
  top: 'top.txt', ps: 'ps-cpu.txt', du_stdout: 'du.txt', du_stderr: 'du-stderr.txt',
};
const BUILDERS = [
  ['top_processes', r.buildTopProcesses, r.summarizeTopProcesses],
  ['memory_report', r.buildMemoryReport, r.summarizeMemoryReport],
  ['disk_report', r.buildDiskReport, r.summarizeDiskReport],
  ['battery_report', r.buildBatteryReport, r.summarizeBatteryReport],
  ['thermal_status', r.buildThermalStatus, r.summarizeThermalStatus],
  ['get_mac_overview', o.buildOverview, o.summarizeOverview],
  ['diagnose_slowness', d.buildDiagnosis, d.summarizeDiagnosis],
];
const BAD_TEXT = /undefined|NaN|Infinity|\[object Object\]/;

function check(label, raw) {
  for (const [name, build, summarize] of BUILDERS) {
    let data;
    let text;
    assert.doesNotThrow(() => { data = build(raw, { failures: {} }); text = summarize(data); }, `${name} / ${label}`);
    assert.equal(typeof text, 'string', `${name} / ${label}`);
    assert.doesNotMatch(text, BAD_TEXT, `${name} / ${label}: ${text}`);
  }
}

for (const [label, value] of [['null', null], ['empty', ''], ['whitespace', '  \n\t\n'], ['garbage', 'garbage\n%%%\n\t\t:::\nPID COMMAND\nabc def\n'], ['binary', '\u0000\u0001\u0002']]) {
  test(`all builders survive ${label} output from every command`, () => {
    const raw = { home: '/Users/testuser', startup: { dirs: [] } };
    for (const k of Object.keys(FILES)) raw[k] = value;
    check(label, raw);
  });
}

test('all builders survive each fixture cut off half-way', () => {
  for (const key of Object.keys(FILES)) {
    for (const frac of [0.25, 0.5, 0.75]) {
      const raw = { home: '/Users/testuser', startup: JSON.parse(fx('startup.json')) };
      for (const [k, f] of Object.entries(FILES)) raw[k] = fx(f);
      raw[key] = raw[key].slice(0, Math.floor(raw[key].length * frac));
      check(`${key} cut at ${frac}`, raw);
    }
  }
});

test('empty output gives "Okänd" grades, never a made-up good grade', () => {
  const raw = {};
  for (const k of Object.keys(FILES)) raw[k] = '';
  assert.equal(r.buildTopProcesses(raw).grade, 'Okänd');
  assert.equal(r.buildMemoryReport(raw).grade, 'Okänd');
  assert.equal(r.buildDiskReport(raw).grade, 'Okänd');
  assert.equal(r.buildThermalStatus(raw).grade, 'Okänd');
  const ov = o.buildOverview(raw);
  for (const k of ['uptime', 'cpu', 'memory', 'disk', 'thermal']) assert.equal(ov[k].grade, 'Okänd', k);
});

test('buildStartupItems survives missing or odd input', () => {
  for (const raw of [undefined, null, {}, { dirs: null }, { dirs: [{ dir: '/Library/LaunchAgents', files: null, error: 'strange' }] }]) {
    const s = r.buildStartupItems(raw);
    assert.equal(typeof r.summarizeStartupItems(s), 'string');
    assert.equal(s.total, 0);
  }
});
