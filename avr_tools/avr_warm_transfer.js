require("dotenv").config();

const axios = require("axios");
const { setBriefing } = require("../briefings");

module.exports = {
  name: "avr_warm_transfer",
  description:
    "Try Joey one more time and warm-transfer the caller to him. Provide a one-sentence briefing of who is calling and why — Joey hears it spoken aloud before deciding whether to accept. The caller hears ringing while Joey is tried, and is reconnected to an assistant if he can't pick up. Only use this after the caller has agreed to hold while you try him.",
  input_schema: {
    type: "object",
    properties: {
      briefing: {
        type: "string",
        description:
          "One sentence for Joey: who is calling (name, company if given) and why. Example: 'Sam Carter from Acme is on hold about the March invoice.'",
      },
    },
    required: ["briefing"],
  },
  handler: async (uuid, { briefing }) => {
    const amiUrl = (process.env.AMI_URL || "http://127.0.0.1:6006").replace(/\/$/, "");

    // Generate the spoken briefing Joey hears before accepting. Failure is
    // non-fatal — the transfer still happens, Joey just gets the beep prompt.
    try {
      const tts = await axios.post(
        "https://api.openai.com/v1/audio/speech",
        {
          model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
          voice: process.env.OPENAI_VOICE || "coral",
          input: `Hey Joey, it's Alice. ${briefing} Press 1 to take the call, or hang up and I'll take a message.`,
          response_format: "wav",
        },
        {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          responseType: "arraybuffer",
          timeout: 15000,
        }
      );
      setBriefing(uuid, Buffer.from(tts.data));
      console.log(`Warm-transfer briefing ready for ${uuid} (${tts.data.byteLength} bytes)`);
    } catch (error) {
      console.error("Briefing TTS failed (transferring anyway):", error.message);
    }

    try {
      const res = await axios.post(`${amiUrl}/transfer`, {
        uuid,
        exten: "s",
        context: process.env.WARM_TRANSFER_CONTEXT || "avr-try-joey",
        priority: 1,
      });
      console.log("Warm transfer response:", res.data);
      return res.data.message;
    } catch (error) {
      console.error("Error during warm transfer:", error.message);
      return `Error during warm transfer: ${error.message}`;
    }
  },
};
