#!/usr/bin/env node
'use strict';
// Builds dist/mac-health-<version>.mcpb (one-click install file for Claude Desktop).
// Usage: node scripts/pack.js
// Note: uses npx @anthropic-ai/mcpb (locked version below; network if not cached) – only run when a release is approved.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Locked version of the packer (never @latest), so a release always builds with the reviewed tool.
const MCPB_VERSION = '2.1.2';
const MCPB = `@anthropic-ai/mcpb@${MCPB_VERSION}`;

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const manifest = require(path.join(root, 'manifest.json'));
const stage = path.join(root, 'build', 'bundle');
const dist = path.join(root, 'dist');
const out = path.join(dist, `mac-health-${pkg.version}.mcpb`);

if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: package.json ${pkg.version} vs manifest.json ${manifest.version}`);
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

const copy = (rel) => fs.cpSync(path.join(root, rel), path.join(stage, rel), { recursive: true, verbatimSymlinks: true });
const files = ['manifest.json', 'package.json', 'README.md', 'LICENSE', 'server'];
if (fs.existsSync(path.join(root, 'icon.png'))) files.push('icon.png'); // no icon yet (milestone 1)
files.forEach(copy);

execFileSync('npx', ['--yes', MCPB, 'validate', path.join(stage, 'manifest.json')], { stdio: 'inherit' });
execFileSync('npx', ['--yes', MCPB, 'pack', stage, out], { stdio: 'inherit' });
console.log(`\nCreated ${path.relative(root, out)}`);
