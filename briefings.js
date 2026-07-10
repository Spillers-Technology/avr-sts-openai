/**
 * In-memory store for warm-transfer briefing audio.
 *
 * The avr_warm_transfer tool writes a TTS wav buffer here keyed by the call
 * UUID; the Asterisk dialplan fetches it over HTTP (GET /brief/<uuid>.wav)
 * right after the caller's channel is redirected. Entries expire after a few
 * minutes — a briefing only matters for the seconds between transfer and dial.
 */
const TTL_MS = 10 * 60 * 1000;

const store = new Map();

function setBriefing(uuid, buffer) {
  // opportunistic sweep — the store only ever holds a handful of entries
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.at > TTL_MS) store.delete(key);
  }
  store.set(uuid, { buffer, at: now });
}

function getBriefing(uuid) {
  const entry = store.get(uuid);
  if (!entry || Date.now() - entry.at > TTL_MS) return null;
  return entry.buffer;
}

module.exports = { setBriefing, getBriefing };
