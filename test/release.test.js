'use strict';
// Release consistency: package.json, manifest.json and the server agree (version, tools, entry point).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const manifest = require('../manifest.json');
const { TOOLS } = require('../server/index.js');

test('package.json and manifest.json have the same version (semver)', () => {
  assert.equal(manifest.version, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('manifest tools match the server: same names, same order, each described', () => {
  assert.deepEqual(manifest.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const t of manifest.tools) assert.ok(t.description && t.description.length > 10, t.name);
  assert.equal(manifest.tools_generated, false);
});

test('every server tool is read-only, has a title, a description and an object input schema', () => {
  assert.equal(TOOLS.length, 8);
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length, 'no duplicate names');
  for (const t of TOOLS) {
    assert.ok(t.title, t.name);
    assert.ok(t.description.length > 20, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.equal(typeof t.handler, 'function', t.name);
  }
});

test('manifest entry point, Node requirement and platform match package.json', () => {
  assert.equal(manifest.server.entry_point, pkg.main);
  assert.ok(fs.existsSync(path.join(root, manifest.server.entry_point)));
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/' + manifest.server.entry_point]);
  assert.equal(pkg.engines.node, '>=18');
  assert.equal(manifest.compatibility.runtimes.node, '>=18.0.0');
  assert.deepEqual(manifest.compatibility.platforms, ['darwin']);
  assert.deepEqual(pkg.os, ['darwin']);
  assert.equal(manifest.license, pkg.license);
});

test('zero dependencies', () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
