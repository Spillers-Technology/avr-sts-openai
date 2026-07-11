/**
 * Synthesized background sound effect for tool-call waits.
 *
 * While a server-side MCP call runs (ticket creation), the caller would
 * otherwise hear dead air. Streaming a soft keyboard-typing loop makes the
 * wait read as "the receptionist is writing this down". The loop is
 * synthesized once at startup — short high-passed noise bursts with a fast
 * decay (key clicks) at slightly irregular intervals, plus occasional longer
 * pauses — so no audio asset ships in the image. Output matches the
 * AudioSocket leg: 8 kHz mono PCM16, consumed as 20 ms frames (160 samples).
 *
 * Peak amplitude is kept well below speech level so the typing sits in the
 * background if it ever brushes against the agent's voice.
 */
const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160; // 20ms at 8kHz

function synthTypingLoop(seconds = 2.4) {
  const total = Math.floor(seconds * SAMPLE_RATE);
  const out = new Int16Array(total); // zero-initialized = silence between clicks
  let i = 0;
  while (i < total) {
    // one key click: 3-6ms of decaying noise, first-differenced to push the
    // energy up the band so it reads as a click, not a thump
    const len = 24 + Math.floor(Math.random() * 24);
    let prev = 0;
    for (let j = 0; j < len && i + j < total; j++) {
      const noise = Math.random() * 2 - 1;
      const clicky = noise - prev * 0.5;
      prev = noise;
      const envelope = Math.exp(-j / (len / 4));
      out[i + j] = Math.round(clicky * envelope * 5000);
    }
    // 70-160ms to the next key, with an occasional thinking pause
    let gap = 560 + Math.floor(Math.random() * 720);
    if (Math.random() < 0.12) gap += 1600 + Math.floor(Math.random() * 1600);
    i += len + gap;
  }
  return out;
}

const loop = synthTypingLoop();

/**
 * Returns the nth 20ms frame of the loop as a 320-byte PCM16LE Buffer,
 * wrapping around seamlessly.
 */
function typingFrame(frameIndex) {
  const start = (frameIndex * FRAME_SAMPLES) % loop.length;
  const frame = new Int16Array(FRAME_SAMPLES);
  for (let k = 0; k < FRAME_SAMPLES; k++) {
    frame[k] = loop[(start + k) % loop.length];
  }
  return Buffer.from(frame.buffer, 0, FRAME_SAMPLES * 2);
}

module.exports = { typingFrame };
