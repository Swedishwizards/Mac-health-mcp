'use strict';
const { execFile } = require('node:child_process');

/**
 * Run a program without a shell and resolve with { code, stdout, stderr, error, timedOut, missing }.
 * Never rejects, so callers can decide what a failure means.
 */
function run(file, args, { timeoutMs = 10000, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      env: env || process.env,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error || null,
        timedOut: Boolean(error && error.killed),
        missing: Boolean(error && error.code === 'ENOENT'),
      });
    });
  });
}

class ToolError extends Error {
  constructor(message, { hint, code } = {}) {
    super(message);
    this.name = 'ToolError';
    this.hint = hint || null;
    this.code = code || 'tool_failed';
  }
}

module.exports = { run, ToolError };
