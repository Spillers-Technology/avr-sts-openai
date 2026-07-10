/**
 * In-memory store for warm-transfer briefing state.
 *
 * The avr_warm_transfer tool records the attempt (briefing text, then the TTS
 * wav buffer once rendered) keyed by call UUID. Two consumers:
 *  - the HTTP endpoint serves the wav to the Asterisk dialplan
 *    (GET /brief/<uuid>.wav) right after the caller's channel is redirected;
 *  - session setup checks the same UUID to detect a RETURNING caller (the
 *    dialplan re-enters AudioSocket with the original UUID when Joey can't
 *    pick up) so the agent doesn't re-greet someone it just tried Joey for.
 * Entries expire after a few minutes — an attempt only matters for the
 * seconds between transfer and dial (or the fallback re-entry).
 */
const TTL_MS = 10 * 60 * 1000;

const store = new Map();

function setBriefing(uuid, buffer, text) {
  // opportunistic sweep — the store only ever holds a handful of entries
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.at > TTL_MS) store.delete(key);
  }
  store.set(uuid, { buffer, text, at: now });
}

function getBriefing(uuid) {
  const entry = getBriefingInfo(uuid);
  return entry ? entry.buffer : null;
}

function getBriefingInfo(uuid) {
  const entry = store.get(uuid);
  if (!entry || Date.now() - entry.at > TTL_MS) return null;
  return entry;
}

module.exports = { setBriefing, getBriefing, getBriefingInfo };
