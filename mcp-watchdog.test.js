const test = require("node:test");
const assert = require("node:assert/strict");
const { McpVoiceWatchdog } = require("./mcp-watchdog");

const makeHarness = () => {
  const timers = [];
  const nudges = [];
  const delays = [];
  const watchdog = new McpVoiceWatchdog({
    sendNudge: () => nudges.push("nudge"),
    baseDelayMs: 100,
    maxAttempts: 3,
    logger: { log() {}, warn() {}, error() {} },
    setTimer: (callback, delay) => {
      const timer = { callback, cleared: false, fired: false };
      timers.push(timer);
      delays.push(delay);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  const fireNext = () => {
    const timer = timers.find((candidate) => !candidate.cleared && !candidate.fired);
    assert.ok(timer, "expected a pending timer");
    timer.fired = true;
    timer.callback();
  };
  return { watchdog, nudges, delays, timers, fireNext };
};

test("retries a silent post-MCP response three times with exponential backoff", () => {
  const { watchdog, nudges, delays, fireNext } = makeHarness();
  watchdog.arm();
  fireNext();
  fireNext();
  fireNext();
  assert.equal(nudges.length, 3);
  assert.deepEqual(delays, [100, 200, 400]);
});

test("a silent response lifecycle leaves the watchdog armed", () => {
  const { watchdog, nudges, fireNext } = makeHarness();
  watchdog.arm();
  // response.created/response.done deliberately have no watchdog side effect.
  fireNext();
  assert.equal(nudges.length, 1);
});

test("actual agent audio clears all pending retries", () => {
  const { watchdog, nudges, timers, fireNext } = makeHarness();
  watchdog.arm();
  fireNext();
  watchdog.clear("agent audio");
  assert.equal(nudges.length, 1);
  assert.equal(timers.filter((timer) => !timer.cleared && !timer.fired).length, 0);
});

test("caller speech clears the watchdog before its first attempt", () => {
  const { watchdog, nudges, timers } = makeHarness();
  watchdog.arm();
  watchdog.clear("caller speech");
  assert.equal(nudges.length, 0);
  assert.equal(timers[0].cleared, true);
});
