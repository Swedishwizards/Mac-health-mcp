'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrub, scrubString, REDACTED } = require('../server/lib/privacy');

test('drops identifier keys at any depth', () => {
  const out = scrub({
    serial_number: 'C02XYZ', Serial: 'FAKESERIAL000000', hardware_uuid: 'x', platform_id: 'y', id: 7,
    battery: { DeviceName: 'XX0000', ManufacturerData: '<00>', cycle_count: 112, nested: [{ UUID: 1, ok: true }] },
    model: 'Mac14,2', username: 'someone', home: '/Users/someone',
  });
  assert.deepEqual(out, { battery: { cycle_count: 112, nested: [{ ok: true }] }, model: 'Mac14,2' });
});

test('redacts UUIDs, MAC addresses, serial pairs, home paths and given names in text', () => {
  const s = scrubString(
    'disk 6F9619FF-8B86-D011-B42D-00C04FC964FF at a4:2b:b0:11:22:33, "Serial" = "FQ1ABC", '
    + 'file /Users/testperson/Documents/x, user testperson on box testhost.local',
    { usernames: ['testperson'], hostnames: ['testhost.local', 'testhost'] },
  );
  assert.doesNotMatch(s, /6F9619FF|a4:2b|FQ1ABC|testperson|testhost/i);
  assert.match(s, /~\/Documents\/x/);
  assert.ok(s.includes(REDACTED));
});

test('leaves normal values alone', () => {
  const v = { grade: 'Bra', summary: '112.7 GB ledigt av 460.4 GB (24 %)', load: [5.84, 5.21, 4.77], present: true, none: null };
  assert.deepEqual(scrub(v, { usernames: ['zz9'] }), v);
});
