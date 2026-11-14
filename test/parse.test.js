'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const p = require('../server/lib/parse');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('sysctl: keys, boottime, loadavg, swap', () => {
  const s = p.parseSysctl(fx('sysctl.txt'));
  assert.equal(s['hw.model'], 'Mac14,2');
  assert.equal(s['hw.ncpu'], '8');
  assert.equal(s['hw.memsize'], '8589934592');
  assert.equal(s['machdep.cpu.brand_string'], 'Apple M2');
  assert.equal(s['kern.memorystatus_vm_pressure_level'], '2');
  assert.equal(p.parseBoottime(s['kern.boottime']), 1765194600);
  assert.equal(p.parseLoadavg(s['vm.loadavg']).length, 3);
  const swap = p.parseSwapusage(s['vm.swapusage']);
  assert.equal(swap.total_bytes, 4096 * 1024 ** 2);
  assert.ok(swap.used_bytes > 3 * 1024 ** 3);
  assert.equal(p.parseBoottime(undefined), null);
  assert.equal(p.parseSwapusage('garbage'), null);
});

test('sw_vers', () => {
  assert.deepEqual(p.parseSwVers(fx('sw_vers.txt')), { product_name: 'macOS', version: '26.1', build: '25B78' });
  assert.equal(p.parseSwVers(''), null);
  assert.equal(p.parseSwVers(null), null);
});

test('uptime: fixture and other formats', () => {
  const u = p.parseUptime(fx('uptime.txt'));
  assert.equal(u.uptime_seconds, 38 * 86400 + 21 * 3600 + 10 * 60);
  assert.deepEqual(u.load_average, [5.84, 5.21, 4.77]);
  assert.equal(p.parseUptime('10:00  up 17 mins, 2 users, load averages: 1.00 0.50 0.25').uptime_seconds, 17 * 60);
  assert.equal(p.parseUptime('10:00  up 2:05, 1 user, load averages: 1 1 1').uptime_seconds, 2 * 3600 + 5 * 60);
  assert.equal(p.parseUptime('10:00  up 1 day, 3 hrs, 1 user, load averages: 1 1 1').uptime_seconds, 86400 + 3 * 3600);
  assert.equal(p.parseUptime('10:00  up 3 days, 5 mins, 1 user, load averages: 1 1 1').uptime_seconds, 3 * 86400 + 300);
  assert.equal(p.parseUptime('nonsense'), null);
});

test('memory_pressure -Q and vm_stat', () => {
  assert.deepEqual(p.parseMemoryPressure(fx('memory_pressure.txt')), { free_percent: 27, total_bytes: 8589934592 });
  const vm = p.parseVmStat(fx('vm_stat.txt'));
  assert.equal(vm.page_size, 16384);
  assert.equal(vm.pages.free, 4120);
  assert.equal(vm.pages.wired_down, 143200);
  assert.equal(vm.pages.occupied_by_compressor, 179800);
  assert.equal(vm.pages.file_backed_pages, 51200);
  assert.equal(vm.pages.translation_faults, 812345678);
  assert.equal(p.parseVmStat('x'), null);
  assert.equal(p.parseMemoryPressure(''), null);
});

test('df -k /', () => {
  const d = p.parseDf(fx('df.txt'));
  assert.equal(d.mount, '/');
  assert.equal(d.total_bytes, 482797652 * 1024);
  assert.equal(d.available_bytes, 118204320 * 1024);
  assert.equal(d.capacity_percent, 9);
  // Without inode columns (df -P style) and with a filesystem name containing spaces.
  const d2 = p.parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\nmap auto home 1000 900 100 90% /\n');
  assert.equal(d2.available_bytes, 100 * 1024);
  assert.equal(p.parseDf('only header'), null);
});

test('pmset -g batt: laptop, desktop, charging', () => {
  const b = p.parsePmsetBatt(fx('pmset-batt.txt'));
  assert.deepEqual(b, { power_source: 'Battery Power', present: true, percent: 64, state: 'discharging', time_remaining_minutes: 185 });
  const desk = p.parsePmsetBatt("Now drawing from 'AC Power'\n");
  assert.equal(desk.present, false);
  assert.equal(desk.power_source, 'AC Power');
  const ch = p.parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n");
  assert.equal(ch.state, 'charged');
  assert.equal(ch.percent, 100);
  assert.equal(p.parsePmsetBatt(''), null);
  assert.equal(p.parsePmsetBatt('something unexpected\n'), null);
});

test('pmset -g therm: none recorded and throttled', () => {
  const t = p.parsePmsetTherm(fx('pmset-therm.txt'));
  assert.equal(t.thermal_warning_level, 0);
  assert.equal(t.performance_warning_level, 0);
  assert.equal(t.cpu_speed_limit, null);
  const hot = p.parsePmsetTherm('Note: Thermal warning level set to 2\nCPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 70\n');
  assert.equal(hot.thermal_warning_level, 2);
  assert.equal(hot.cpu_speed_limit, 70);
  assert.equal(hot.cpu_available_cpus, 8);
});

test('ioreg battery: only whitelisted keys, never identifiers', () => {
  const io = p.parseIoregBattery(fx('ioreg-battery.txt'));
  assert.equal(io.cycle_count, 112);
  assert.equal(io.design_capacity_mah, 4382);
  assert.equal(io.full_charge_capacity_mah, 4010);
  assert.equal(io.health_percent, 92);
  assert.equal(io.temperature_c, 29.8);
  assert.equal(io.is_charging, false);
  assert.equal(io.permanent_failure, false);
  const json = JSON.stringify(io);
  assert.doesNotMatch(json, /FAKESERIAL|XX0000|serial|uuid|device/i);
  assert.equal(p.parseIoregBattery(''), null); // desktop Mac: ioreg prints nothing
});
