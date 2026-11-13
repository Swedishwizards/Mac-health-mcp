'use strict';
// Preloaded with `node -r` in tests: pretends the server runs on Linux, so every tool must refuse
// with "unsupported" before running anything. The collector is replaced by one that fails loudly,
// so no real command is ever run, even when the test itself runs on a Mac.
const Module = require('node:module');

Object.defineProperty(process, 'platform', { value: 'linux' });

const refuse = async () => { throw new Error('collector must not run off macOS'); };
const fake = new Proxy({}, { get: () => refuse });

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/lib[\\/]collect$/.test(request) && parent && /server[\\/]index\.js$/.test(parent.filename)) return fake;
  return origLoad.call(this, request, parent, isMain);
};
