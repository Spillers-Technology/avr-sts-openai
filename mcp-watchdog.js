class McpVoiceWatchdog {
  constructor({
    sendNudge,
    baseDelayMs = 1500,
    maxAttempts = 3,
    logger = console,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.sendNudge = sendNudge;
    this.baseDelayMs = baseDelayMs;
    this.maxAttempts = maxAttempts;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.attempts = 0;
    this.armed = false;
  }

  arm() {
    if (this.armed) return;
    this.armed = true;
    this.attempts = 0;
    this.schedule();
  }

  schedule() {
    if (!this.armed || this.timer || this.attempts >= this.maxAttempts) return;
    const delay = this.baseDelayMs * (2 ** this.attempts);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.armed) return;

      this.attempts += 1;
      this.logger.warn(
        `No agent audio after MCP call — nudging model (attempt ${this.attempts}/${this.maxAttempts})`
      );
      try {
        this.sendNudge();
      } catch (error) {
        this.logger.error("Failed to send MCP follow-up nudge:", error);
      }

      if (this.attempts < this.maxAttempts) {
        this.schedule();
      } else {
        this.logger.error(
          `MCP voice watchdog exhausted after ${this.maxAttempts} attempts`
        );
      }
    }, delay);
  }

  clear(reason) {
    if (this.timer) this.clearTimer(this.timer);
    if (this.armed) this.logger.log(`MCP voice watchdog cleared: ${reason}`);
    this.timer = null;
    this.attempts = 0;
    this.armed = false;
  }
}

module.exports = { McpVoiceWatchdog };
