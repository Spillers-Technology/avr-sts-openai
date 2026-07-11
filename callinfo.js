/**
 * In-memory store for per-call routing metadata.
 *
 * The Asterisk dialplan POSTs to /callinfo/<uuid> before entering AudioSocket:
 * `path` is how the call reached the DID ("forward" = diverted from another
 * number, detected via the SIP Diversion header; "direct" = dialed straight),
 * plus the caller id for logging. Session setup reads the entry to pick the
 * matching greeting (AVR_GREETING_FORWARD / AVR_GREETING_DIRECT). A missing
 * entry is treated as "direct" — the safe default for the business line.
 * Entries expire after a few minutes — they only matter for the moment
 * between the dialplan hit and the session.update that follows.
 */
const TTL_MS = 10 * 60 * 1000;

const store = new Map();

function setCallInfo(uuid, info) {
  // opportunistic sweep — the store only ever holds a handful of entries
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.at > TTL_MS) store.delete(key);
  }
  store.set(uuid, { ...info, at: now });
}

function getCallInfo(uuid) {
  const entry = store.get(uuid);
  if (!entry || Date.now() - entry.at > TTL_MS) return null;
  return entry;
}

module.exports = { setCallInfo, getCallInfo };
