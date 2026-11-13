'use strict';
/**
 * Last line of defence before anything is sent to Claude: removes identifiers
 * (serial numbers, UUIDs, hardware IDs, MAC addresses) and user names / home paths.
 * The parsers already only pick whitelisted fields; this catches anything that slips through.
 */

const REDACTED = '[borttaget]';

// Keys that are dropped entirely, whatever their value.
const SECRET_KEY = /serial|uuid|udid|guid|hardware[_\s-]?id|platform[_\s-]?id|device[_\s-]?(name|id)|mac[_\s-]?address|^id$|ecid|imei|manufacturer[_\s-]?data|mfg[_\s-]?data|user(name)?$|^home$|hostname|computer[_\s-]?name/i;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const MAC_ADDR = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi;
const HOME_PATH = /\/(?:Users|home)\/[^/\s"'),]+/g;
const SERIAL_PAIR = /("?(?:serial(?:[_\s-]?number)?|uuid|udid)"?\s*[=:]\s*)("?)[^",}\s]+\2/gi;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * @param {object} ctx  { usernames?: string[], hostnames?: string[] } – words that must never appear.
 */
function scrubString(s, ctx = {}) {
  let out = s.replace(HOME_PATH, '~').replace(UUID, REDACTED).replace(MAC_ADDR, REDACTED).replace(SERIAL_PAIR, `$1${REDACTED}`);
  for (const word of [...(ctx.usernames || []), ...(ctx.hostnames || [])]) {
    if (word && word.length >= 2) out = out.replace(new RegExp(`\\b${escapeRe(word)}\\b`, 'gi'), REDACTED);
  }
  return out;
}

function scrub(value, ctx = {}) {
  if (typeof value === 'string') return scrubString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => scrub(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = scrub(v, ctx);
    }
    return out;
  }
  return value;
}

/** Identity words of the current machine/user, read locally (never sent anywhere). */
function localContext() {
  const os = require('node:os');
  const usernames = [];
  const hostnames = [];
  try { usernames.push(os.userInfo().username); } catch { /* ignore */ }
  if (process.env.USER) usernames.push(process.env.USER);
  try {
    const h = os.hostname();
    hostnames.push(h, h.replace(/\.local$/i, ''));
  } catch { /* ignore */ }
  // Never redact generic words that would destroy normal text.
  const safe = (w) => w && w.length >= 3 && !/^(root|mac|macos|admin|user|localhost)$/i.test(w);
  return { usernames: [...new Set(usernames.filter(safe))], hostnames: [...new Set(hostnames.filter(safe))] };
}

module.exports = { scrub, scrubString, localContext, REDACTED };
