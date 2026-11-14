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

const { localContext } = require('../server/lib/privacy');

test('localContext includes $USER and never generic words that would ruin normal text', () => {
  const saved = process.env.USER;
  try {
    process.env.USER = 'testuser';
    const ctx = localContext();
    assert.ok(ctx.usernames.includes('testuser'));
    assert.equal(new Set(ctx.usernames).size, ctx.usernames.length, 'no duplicates');
    assert.ok(Array.isArray(ctx.hostnames));
    for (const w of [...ctx.usernames, ...ctx.hostnames]) {
      assert.ok(w.length >= 3, w);
      assert.doesNotMatch(w, /^(root|mac|macos|admin|user|localhost)$/i);
    }
    for (const generic of ['root', 'admin', 'user', 'ab']) {
      process.env.USER = generic;
      assert.equal(localContext().usernames.includes(generic), false, generic);
    }
  } finally {
    if (saved === undefined) delete process.env.USER; else process.env.USER = saved;
  }
});

test('scrub keeps numbers, booleans and null and handles serial pairs in several spellings', () => {
  assert.equal(scrub(5), 5);
  assert.equal(scrub(false), false);
  assert.equal(scrub(null), null);
  assert.equal(scrub(undefined), undefined);
  const s = scrubString('serial_number: FAKESERIAL000000; SerialNumber=FAKESERIAL000000; "UDID" : "FAKEUDID0000"');
  assert.doesNotMatch(s, /FAKESERIAL|FAKEUDID/);
  assert.match(scrubString('/home/testuser/demo and /Users/testuser'), /^~\/demo and ~$/);
});

test('names shorter than two letters are ignored; names are matched as whole words only', () => {
  assert.equal(scrubString('a b c', { usernames: ['a'] }), 'a b c');
  assert.equal(scrubString('testusers testuser', { usernames: ['testuser'] }), `testusers ${REDACTED}`);
  assert.equal(scrubString('Price (1+1)', { usernames: ['1+1'] }), `Price (${REDACTED})`, 'regex characters are escaped');
});
