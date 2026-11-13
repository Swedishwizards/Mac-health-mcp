'use strict';
// battery_report, thermal_status and startup_items: builders, collector and fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const r = require('../server/lib/reports');
const { collectStartup, collectBattery } = require('../server/lib/collect');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('buildBatteryReport: health, cycles, tips and no serial numbers', () => {
  const b = r.buildBatteryReport({ pmset_batt: fx('pmset-batt.txt'), ioreg_battery: fx('ioreg-battery.txt') });
  assert.equal(b.present, true);
  assert.equal(b.cycle_count, 112);
  assert.equal(typeof b.health_percent, 'number');
  assert.ok(b.tips.length >= 2);
  const text = r.summarizeBatteryReport(b);
  assert.match(text, /^Batteri: \[/);
  assert.doesNotMatch(JSON.stringify(b) + text, /serial|FAKESERIAL|XX0000/i);
});

test('buildBatteryReport on a Mac without battery is calm', () => {
  const b = r.buildBatteryReport({ pmset_batt: "Now drawing from 'AC Power'\n", ioreg_battery: null });
  assert.equal(b.present, false);
  assert.equal(b.grade, null);
  assert.deepEqual(b.tips, []);
  assert.match(r.summarizeBatteryReport(b), /inget batteri/);
  assert.equal(r.buildBatteryReport({}).grade, 'Okänd');
});

test('buildThermalStatus: grade, throttled flag and explanation', () => {
  const t = r.buildThermalStatus({ pmset_therm: fx('pmset-therm.txt'), ioreg_battery: fx('ioreg-battery.txt') });
  assert.ok(['Bra', 'Okej', 'Behöver åtgärd'].includes(t.grade));
  assert.match(t.explanation, /strypning/);
  const hot = r.buildThermalStatus({ pmset_therm: 'CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 60\n' });
  assert.equal(hot.grade, 'Behöver åtgärd');
  assert.equal(hot.throttled, true);
  assert.match(r.summarizeThermalStatus(hot), /60 %/);
  const none = r.buildThermalStatus({ pmset_therm: null }, { failures: { pmset_therm: 'saknas på den här datorn' } });
  assert.equal(none.grade, 'Okänd');
  assert.equal(none.notes.length, 1);
});

test('buildStartupItems marks Apple vs third party and handles missing folders', () => {
  const s = r.buildStartupItems({ dirs: [
    { dir: '~/Library/LaunchAgents', files: ['com.example.helper.plist', '.DS_Store', 'notes.txt'], error: null },
    { dir: '/Library/LaunchAgents', files: null, error: 'missing' },
    { dir: '/Library/LaunchDaemons', files: ['com.apple.thing.plist'], error: null },
  ] });
  assert.equal(s.total, 2);
  assert.equal(s.third_party, 1);
  assert.equal(s.apple, 1);
  assert.deepEqual(s.items.map((i) => [i.label, i.maker]), [['com.example.helper', 'tredjepart'], ['com.apple.thing', 'Apple']]);
  assert.equal(s.folders[1].count, null);
  assert.deepEqual(s.notes, [], 'a missing folder is normal, no note');
  assert.match(s.advice, /Inloggningsobjekt/);
  const text = r.summarizeStartupItems(s);
  assert.match(text, /ändrar eller raderar aldrig/);
  assert.doesNotMatch(text + s.advice, /\b(rm|radera dem|ta bort dem)\b/i);
});

test('buildStartupItems with real fixture and unreadable folders', () => {
  const s = r.buildStartupItems(JSON.parse(fx('startup.json')));
  assert.ok(s.total > 0);
  assert.ok(s.items.every((i) => !/\/Users\//.test(JSON.stringify(i))));
  const denied = r.buildStartupItems({ dirs: [{ dir: '/Library/LaunchDaemons', files: null, error: 'denied' }] });
  assert.equal(denied.summary, 'Kunde inte läsa startmapparna.');
  assert.ok(denied.notes[0].includes('nekade'));
});

test('collectStartup uses readdir only and shows ~ instead of the home folder', async () => {
  const seen = [];
  const readdir = (d) => {
    seen.push(d);
    if (d === '/Library/LaunchDaemons') { const e = new Error('x'); e.code = 'EACCES'; throw e; }
    if (d === '/Library/LaunchAgents') { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
    return ['com.example.a.plist'];
  };
  const res = await collectStartup({ home: '/Users/testuser', readdir });
  assert.equal(seen[0], '/Users/testuser/Library/LaunchAgents');
  assert.deepEqual(res.dirs.map((d) => [d.dir, d.error]), [
    ['~/Library/LaunchAgents', null], ['/Library/LaunchAgents', 'missing'], ['/Library/LaunchDaemons', 'denied'],
  ]);
  assert.doesNotMatch(JSON.stringify(res), /testuser/);
});

test('collectBattery: empty ioreg (no battery) is not reported as a failure', async () => {
  const runner = async (file) => (file === '/usr/sbin/ioreg'
    ? { code: 0, stdout: '', stderr: '' }
    : { code: 0, stdout: "Now drawing from 'AC Power'\n", stderr: '' });
  const res = await collectBattery({ runner });
  assert.deepEqual(res.failures, {});
});
