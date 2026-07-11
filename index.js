/**
 * index.js
 * Entry point for the OpenAI Speech-to-Speech streaming WebSocket server.
 * This server handles real-time audio streaming between clients and OpenAI's API,
 * performing necessary audio format conversions and WebSocket communication.
 *
 * Client Protocol:
 * - Send {"type": "init", "uuid": "uuid"} to initialize session
 * - Send {"type": "audio", "audio": "base64_encoded_audio"} to stream audio
 * - Receive {"type": "audio", "audio": "base64_encoded_audio"} for responses
 * - Receive {"type": "error", "message": "error_message"} for errors
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */

const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const fs = require("fs").promises;
const { create } = require("@alexanderolsen/libsamplerate-js");
const { loadTools, getToolHandler } = require("./loadTools");
const { getBriefing, getBriefingInfo } = require("./briefings");
const { setCallInfo, getCallInfo } = require("./callinfo");
const { typingFrame } = require("./sfx");

require("dotenv").config();

const DEFAULT_MODEL = "gpt-realtime-2";

// Call-control tools tear the audio path down the moment they execute. Delay
// them so the agent's parting words finish playing out through Asterisk first
// (fixes hangups cutting off the goodbye mid-sentence).
const CALL_CONTROL_TOOLS = new Set(["avr_hangup", "avr_transfer", "avr_warm_transfer"]);
const CALL_CONTROL_GRACE_MS = parseInt(process.env.AVR_CALL_CONTROL_GRACE_MS || "3000", 10);
// Soft typing loop streamed to the caller while a server-side MCP call runs,
// so the wait reads as "she's writing it down" instead of dead air. Set
// AVR_TOOL_SFX=off to disable. The start delay skips the effect entirely for
// near-instant tool calls.
const TOOL_SFX_ENABLED = (process.env.AVR_TOOL_SFX || "typing").toLowerCase() !== "off";
const TOOL_SFX_START_DELAY_MS = 400;
// The Realtime API usually auto-generates a follow-up response after a
// server-side MCP call completes, but sometimes it just stops — leaving the
// caller in silence until they speak again. If no new response starts within
// this window after a tool-call response finishes, prod the model.
const MCP_NUDGE_MS = parseInt(process.env.AVR_MCP_NUDGE_MS || "1500", 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REALTIME_PCM_RATE = 24000;
const REALTIME_PCM_FORMAT = { type: "audio/pcm", rate: REALTIME_PCM_RATE };
const DEPRECATED_MODELS = new Set([
  "gpt-4o-realtime-preview",
  "gpt-4o-mini-realtime-preview",
]);
const REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const isReasoningRealtimeModel = (model) => model.startsWith("gpt-realtime-2");

const resolveModel = () => process.env.OPENAI_MODEL || DEFAULT_MODEL;

const validateModel = (model) => {
  if (DEPRECATED_MODELS.has(model)) {
    return `OPENAI_MODEL=${model} is no longer supported. Use gpt-realtime-2 (default), gpt-realtime, or gpt-realtime-mini with the GA Realtime API.`;
  }
  if (!model.startsWith("gpt-realtime")) {
    return `OPENAI_MODEL=${model} is not a supported GA Realtime model. Use gpt-realtime-2, gpt-realtime, or gpt-realtime-mini.`;
  }
  return null;
};

const buildTurnDetection = () => {
  const type = (process.env.OPENAI_TURN_DETECTION || "server_vad").toLowerCase();
  if (type === "semantic_vad") {
    const turnDetection = { type: "semantic_vad" };
    const eagerness = process.env.OPENAI_TURN_DETECTION_EAGERNESS;
    if (eagerness) turnDetection.eagerness = eagerness;
    return turnDetection;
  }
  return { type: "server_vad" };
};

const resolveReasoningEffort = () => {
  const effort = (process.env.OPENAI_REASONING_EFFORT || "low").toLowerCase();
  return REASONING_EFFORTS.has(effort) ? effort : "low";
};

const resolveMaxOutputTokens = () => {
  const raw = process.env.OPENAI_MAX_TOKENS;
  if (!raw || raw === "inf") return "inf";
  const n = +raw;
  return Number.isFinite(n) && n > 0 ? n : "inf";
};

const resolveTemperature = () => {
  const raw = process.env.OPENAI_TEMPERATURE;
  if (raw === undefined || raw === "") return 0.8;
  const temp = +raw;
  if (!Number.isFinite(temp)) return 0.8;
  return Math.min(1.2, Math.max(0.6, temp));
};

const applyGenerationOptions = (session, model) => {
  if (isReasoningRealtimeModel(model)) {
    session.reasoning = { effort: resolveReasoningEffort() };
    return;
  }

  session.temperature = resolveTemperature();
};

const buildResponseCreate = (overrides = {}) => {
  const response = { ...overrides };
  const maxTokens = resolveMaxOutputTokens();
  if (maxTokens !== "inf") {
    response.max_output_tokens = maxTokens;
  }
  return Object.keys(response).length
    ? { type: "response.create", response }
    : { type: "response.create" };
};

const isEnabled = (value, defaultValue = true) => {
  if (value === undefined || value === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
};

const redactSensitive = (value) => JSON.parse(JSON.stringify(value, (key, item) => {
  const normalized = key.toLowerCase();
  if (
    normalized.includes("authorization") ||
    normalized.includes("api_key") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("secret")
  ) {
    return "[redacted]";
  }
  return item;
}));

const anchordeskApiBase = () => {
  const base = process.env.ANCHORDESK_API_URL || process.env.ANCHORDESK_URL;
  return base ? base.replace(/\/$/, "") : null;
};

const anchordeskToken = () => process.env.ANCHORDESK_PAT || process.env.MCP_AUTHORIZATION;

const anchordeskTimeoutMs = () => {
  const raw = +process.env.ANCHORDESK_TIMEOUT_MS;
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
};

const anchordeskRequest = async (method, path, data) => {
  const base = anchordeskApiBase();
  const token = anchordeskToken();
  if (!base || !token) {
    throw new Error("ANCHORDESK_API_URL and AnchorDesk token are not configured");
  }

  const response = await axios({
    method,
    url: `${base}${path}`,
    data,
    timeout: anchordeskTimeoutMs(),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return response.data;
};

const truncate = (text, max = 500) => {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

const hasUrgentLanguage = (transcript) => transcript.some(({ text }) =>
  /\b(urgent|high priority|priority 1|emergency|asap|immediately)\b/i.test(text || "")
);

const hasCreateTicketToolSignal = (message) => {
  if (!message || typeof message !== "object") return false;
  if (typeof message.type === "string" && message.type.startsWith("mcp_list_tools")) {
    return false;
  }

  const candidates = [
    message.name,
    message.tool_name,
    message.item?.name,
    message.item?.tool_name,
    message.item?.function?.name,
    message.output?.name,
    message.tool_call?.name,
    message.call?.name,
  ];
  if (candidates.some((name) => name === "create_ticket")) return true;

  if (
    typeof message.type === "string" &&
    (message.type.includes("mcp") ||
      message.type.includes("tool") ||
      message.type.includes("function"))
  ) {
    return JSON.stringify(message).includes("create_ticket");
  }

  return false;
};

// Pick the greeting for how this call reached us: the dialplan reports
// "forward" (diverted from another number) or "direct" (DID dialed straight)
// via POST /callinfo/<uuid>. No entry — or no matching env — means no
// injection, so deployments without AVR_GREETING_* keep their old behavior.
const resolveGreeting = (sessionUuid) => {
  const info = getCallInfo(sessionUuid);
  const path = info && info.path === "forward" ? "forward" : "direct";
  const greeting =
    path === "forward"
      ? process.env.AVR_GREETING_FORWARD
      : process.env.AVR_GREETING_DIRECT;
  if (!greeting) return null;
  console.log(
    `Call path for ${sessionUuid}: ${path}${info ? "" : " (no callinfo on file, defaulted)"}${info && info.caller ? `, caller ${info.caller}` : ""}`
  );
  return greeting;
};

const appendCallContext = (instructions, sessionUuid) => {
  if (!sessionUuid) return instructions;
  return `${instructions}

CALL CONTEXT: This call session UUID is ${sessionUuid}. Include this UUID in any AnchorDesk ticket description so automated fallback checks can avoid duplicate tickets.`;
};

/**
 * Creates and configures a WebSocket connection to OpenAI's real-time API.
 *
 * @returns {WebSocket} Configured WebSocket instance
 */
const connectToOpenAI = () => {
  const model = resolveModel();
  console.log("Connecting to OpenAI with model:", model);
  return new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
  });
};

/**
 * Stream Processing
 */

// Global audio resamplers - created once and shared across all connections
let globalDownsampler = null;
let globalUpsampler = null;

/**
 * Initializes global audio resamplers for format conversion.
 * Called once at server startup.
 */
const initializeResamplers = async () => {
  try {
    globalDownsampler = await create(1, 24000, 8000); // 1 channel, 24kHz to 8kHz
    globalUpsampler = await create(1, 8000, 24000); // 1 channel, 8kHz to 24kHz
    console.log("Global audio resamplers initialized");
  } catch (error) {
    console.error("Error initializing resamplers:", error);
    process.exit(1);
  }
};

/**
 * Handles incoming client WebSocket connection and manages communication with OpenAI's API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {WebSocket} clientWs - Client WebSocket connection
 */
const handleClientConnection = (clientWs) => {
  console.log("New client WebSocket connection received");
  let sessionUuid = null;
  const connectedAt = new Date();
  const transcript = [];
  let ticketCreateObserved = false;
  let cleanupStarted = false;
  let fallbackTicketStarted = false;

  let audioBuffer8k = [];
  let ws = null;

  // Tool-wait sound effect + stalled-response nudge state
  let sfxDelayTimer = null;
  let sfxInterval = null;
  let sfxFrameIndex = 0;
  let nudgeTimer = null;
  let mcpCallInResponse = false;

  // Streams the typing loop to the caller one 20ms frame at a time — real-time
  // pacing keeps avr-core's playback buffer near-empty, so when the agent's
  // voice resumes it isn't queued behind seconds of sound effect.
  const startToolSfx = () => {
    if (!TOOL_SFX_ENABLED || sfxDelayTimer || sfxInterval) return;
    sfxDelayTimer = setTimeout(() => {
      sfxDelayTimer = null;
      sfxInterval = setInterval(() => {
        if (clientWs.readyState !== WebSocket.OPEN) {
          stopToolSfx();
          return;
        }
        clientWs.send(
          JSON.stringify({
            type: "audio",
            audio: typingFrame(sfxFrameIndex++).toString("base64"),
          })
        );
      }, 20);
    }, TOOL_SFX_START_DELAY_MS);
  };

  const stopToolSfx = () => {
    if (sfxDelayTimer) clearTimeout(sfxDelayTimer);
    if (sfxInterval) clearInterval(sfxInterval);
    sfxDelayTimer = null;
    sfxInterval = null;
  };

  const scheduleMcpNudge = () => {
    if (nudgeTimer) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("No follow-up response after MCP call — nudging model");
        ws.send(JSON.stringify(buildResponseCreate()));
      }
    }, MCP_NUDGE_MS);
  };

  const cancelMcpNudge = () => {
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = null;
  };

  /**
   * Processes OpenAI audio chunks by downsampling and extracting frames.
   * Converts 24kHz audio to 8kHz and extracts 20ms frames (160 samples).
   *
   * @param {Buffer} inputBuffer - Raw audio buffer from OpenAI
   * @returns {Buffer[]} Array of 20ms audio frames
   */
  function processOpenAIAudioChunk(inputBuffer) {
    // Convert Buffer to Int16Array for processing
    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2
    );

    // Downsample from 24kHz to 8kHz using global downsampler
    const downsampledSamples = globalDownsampler.full(inputSamples);

    // Accumulate samples in buffer
    audioBuffer8k = audioBuffer8k.concat(Array.from(downsampledSamples));

    // Extract 20ms frames (160 samples = 320 bytes)
    const audioFrames = [];
    while (audioBuffer8k.length >= 160) {
      const frame = audioBuffer8k.slice(0, 160);
      audioBuffer8k = audioBuffer8k.slice(160);

      // Convert to PCM16LE Buffer (320 bytes)
      audioFrames.push(Buffer.from(Int16Array.from(frame).buffer));
    }

    return audioFrames;
  }

  /**
   * Converts 8kHz audio to 24kHz for sending to OpenAI API.
   *
   * @param {Buffer} inputBuffer - 8kHz audio buffer
   * @returns {Buffer} 24kHz audio buffer
   */
  function convert8kTo24k(inputBuffer) {
    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2
    );
    const upsampledSamples = globalUpsampler.full(inputSamples);
    return Buffer.from(Int16Array.from(upsampledSamples).buffer);
  }

  // Handle client WebSocket messages
  clientWs.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      switch (message.type) {
        case "init":
          sessionUuid = message.uuid;
          console.log("Session UUID:", sessionUuid);
          // Initialize OpenAI connection when client is ready
          initializeOpenAIConnection();
          break;

        case "audio":
          // Handle audio data from client
          if (message.audio && ws && ws.readyState === WebSocket.OPEN) {
            const audioBuffer = Buffer.from(message.audio, "base64");
            const upsampledAudio = convert8kTo24k(audioBuffer);
            ws.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: upsampledAudio.toString("base64"),
              })
            );
          }
          break;

        default:
          console.log("Unknown message type from client:", message.type);
          break;
      }
    } catch (error) {
      console.error("Error processing client message:", error);
    }
  });

  // Initialize OpenAI WebSocket connection
  const initializeOpenAIConnection = () => {
    const model = resolveModel();
    const modelError = validateModel(model);
    if (modelError) {
      console.error(modelError);
      clientWs.send(JSON.stringify({ type: "error", message: modelError }));
      return;
    }

    ws = connectToOpenAI();

    // Configure WebSocket event handlers
    ws.on("open", async () => {
      console.log("WebSocket connected to OpenAI");

      const session = {
        type: "realtime",
        output_modalities: ["audio"],
        instructions:
          "You are a helpful assistant that can answer questions and help with tasks.",
        audio: {
          input: {
            format: REALTIME_PCM_FORMAT,
            turn_detection: buildTurnDetection(),
            transcription: {
              model: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
            },
          },
          output: {
            format: REALTIME_PCM_FORMAT,
            voice: process.env.OPENAI_VOICE || "alloy",
          },
        },
      };

      if (process.env.OPENAI_LANGUAGE) {
        session.audio.input.transcription.language = process.env.OPENAI_LANGUAGE;
      }

      applyGenerationOptions(session, model);

      const obj = { type: "session.update", session };

      if (process.env.OPENAI_INSTRUCTIONS) {
        console.log("Using OPENAI_INSTRUCTIONS from environment variable");
        obj.session.instructions = process.env.OPENAI_INSTRUCTIONS;
      } else if (process.env.OPENAI_URL_INSTRUCTIONS) {
        console.log("Using OPENAI_URL_INSTRUCTIONS from environment variable");
        try {
          const response = await axios.get(
            process.env.OPENAI_URL_INSTRUCTIONS,
            {
              headers: {
                "Content-Type": "application/json",
                "X-AVR-UUID": sessionUuid,
              },
            }
          );
          const data = await response.data;
          console.log(data);
          obj.session.instructions = data.system;
        } catch (error) {
          console.error(
            `Error loading instructions from ${process.env.OPENAI_URL_INSTRUCTIONS}: ${error.message}`
          );
        }
      } else if (process.env.OPENAI_FILE_INSTRUCTIONS) {
        console.log("Using OPENAI_FILE_INSTRUCTIONS from environment variable");
        try {
          const data = await fs.readFile(
            process.env.OPENAI_FILE_INSTRUCTIONS,
            "utf8"
          );
          obj.session.instructions = data;
        } catch (error) {
          console.error(
            `Error loading instructions from ${process.env.OPENAI_FILE_INSTRUCTIONS}: ${error.message}`
          );
        }
      } else {
        console.log("Using default instructions");
        obj.session.instructions =
          "You are a helpful assistant that can answer questions and help with tasks.";
      }

      obj.session.instructions = appendCallContext(
        obj.session.instructions,
        sessionUuid
      );

      // Fallback re-entry after a failed warm transfer keeps the original
      // call UUID, so a briefing on file means this caller was already
      // greeted and Joey was already tried.
      const priorAttempt = getBriefingInfo(sessionUuid);
      if (priorAttempt) {
        console.log("Returning caller after failed warm transfer:", sessionUuid);
        ticketCreateObserved = true; // first session (or its fallback) owns the ticket
        obj.session.instructions += `

RETURNING CALLER: You already know this caller — you just tried Joey for them and he could not pick up. Your briefing was: "${priorAttempt.text}". Do NOT repeat the standard greeting. Open by apologizing that he couldn't break away, confirm their message will get to him, and log the failed attempt as an update on this call's ticket (it contains this session UUID) — or note it when creating one if none exists. If they have nothing to add, wrap up warmly and end the call with avr_hangup.`;
      } else {
        const greeting = resolveGreeting(sessionUuid);
        if (greeting) {
          obj.session.instructions += `

GREETING: Open this call by saying exactly: "${greeting}" — nothing more until the caller speaks.`;
        }
      }

      // Load available tools for OpenAI
      try {
        obj.session.tools = loadTools();
        console.log(`Loaded ${obj.session.tools.length} tools for OpenAI`);
      } catch (error) {
        console.error(`Error loading tools for OpenAI: ${error.message}`);
      }

      console.log(redactSensitive(obj.session));

      ws.send(JSON.stringify(obj));
    });

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);
        if (hasCreateTicketToolSignal(message)) {
          ticketCreateObserved = true;
          console.log("Create-ticket tool activity observed");
        }

        switch (message.type) {
          case "error":
            console.error("OpenAI API error:", message.error);
            clientWs.send(
              JSON.stringify({
                type: "error",
                message: message.error.message,
              })
            );
            break;

          case "session.updated":
            console.log("Session updated:", redactSensitive(message));
            await ws.send(JSON.stringify(buildResponseCreate()));
            break;

          case "response.output_audio.delta":
          case "response.audio.delta":
            // The voice is back — stop covering the wait and stand down any
            // pending nudge (the model followed up on its own).
            stopToolSfx();
            cancelMcpNudge();
            const audioChunk = Buffer.from(message.delta, "base64");
            const audioFrames = processOpenAIAudioChunk(audioChunk);
            audioFrames.forEach((frame) => {
              clientWs.send(
                JSON.stringify({
                  type: "audio",
                  audio: frame.toString("base64"),
                })
              );
            });
            break;

          case "response.function_call_arguments.done":
            console.log("Function call arguments streaming completed", message);
            // Get the appropriate handler for the tool
            const handler = getToolHandler(message.name);
            if (!handler) {
              const errMsg = `No handler found for tool: ${message.name}`;
              console.error(errMsg);
              clientWs.send(JSON.stringify({ type: "error", message: errMsg }));
              return;
            }

            try {
              const isCallControl = CALL_CONTROL_TOOLS.has(message.name);
              if (isCallControl) {
                console.log(
                  `Delaying ${message.name} ${CALL_CONTROL_GRACE_MS}ms so parting words finish playing`
                );
                await sleep(CALL_CONTROL_GRACE_MS);
              }
              const content = await handler(
                sessionUuid,
                JSON.parse(message.arguments)
              );
              console.log("Tool response:", content);
              // Call-control success ends the session — prompting the model to
              // respond again would talk into a dead channel. Errors still go
              // back so the agent can recover out loud.
              if (!isCallControl || /^error/i.test(String(content))) {
                ws.send(
                  JSON.stringify(
                    buildResponseCreate({ instructions: content })
                  )
                );
              }
            } catch (error) {
              const errMsg = `Tool ${message.name} failed: ${error.message}`;
              console.error(errMsg, error);
              clientWs.send(JSON.stringify({ type: "error", message: errMsg }));
            }
            break;

          case "response.output_audio_transcript.done":
          case "response.audio_transcript.done":
            const agentData = {
              type: "transcript",
              role: "agent",
              text: message.transcript,
            };
            transcript.push({
              role: "agent",
              text: message.transcript,
              at: new Date().toISOString(),
            });
            clientWs.send(JSON.stringify(agentData));
            console.log("Agent transcript:", agentData);
            break;

          case "input_audio_buffer.speech_started":
            console.log("Audio streaming started");
            // The caller is talking: kill the typing loop and any pending
            // nudge — their turn will trigger a response by itself.
            stopToolSfx();
            cancelMcpNudge();
            clientWs.send(JSON.stringify({ type: "interruption" }));
            break;

          case "response.created":
            // A response is starting on its own — no nudge needed.
            cancelMcpNudge();
            break;

          case "response.mcp_call_arguments.delta":
            // Server-side tool call underway — cover the wait with typing.
            // (Not logged: these arrive in bursts of dozens per call.)
            startToolSfx();
            break;

          case "response.mcp_call.in_progress":
          case "response.mcp_call.completed":
          case "response.mcp_call.failed":
            // Typing keeps running until the voice actually resumes; mark the
            // response so response.done can schedule the stall nudge.
            startToolSfx();
            mcpCallInResponse = true;
            console.log("Received message type:", message.type);
            break;

          case "response.done":
            if (mcpCallInResponse) {
              mcpCallInResponse = false;
              scheduleMcpNudge();
            }
            break;

          case "conversation.item.input_audio_transcription.completed":
            const userData = {
              type: "transcript",
              role: "user",
              text: message.transcript,
            };
            transcript.push({
              role: "user",
              text: message.transcript,
              at: new Date().toISOString(),
            });
            clientWs.send(JSON.stringify(userData));
            console.log("User transcript:", userData);
            break;

          default:
            console.log("Received message type:", message.type);
            break;
        }
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
      }
    });

    ws.on("close", () => {
      console.log("OpenAI WebSocket connection closed");
      cleanup("openai_close");
    });

    ws.on("error", (err) => {
      console.error("OpenAI WebSocket error:", err);
      cleanup("openai_error");
    });
  };

  // Handle client WebSocket close
  clientWs.on("close", () => {
    console.log("Client WebSocket connection closed");
    cleanup("client_close");
  });

  clientWs.on("error", (err) => {
    console.error("Client WebSocket error:", err);
    cleanup("client_error");
  });

  async function maybeCreateFallbackTicket(reason) {
    if (
      fallbackTicketStarted ||
      ticketCreateObserved ||
      !sessionUuid ||
      !isEnabled(process.env.ANCHORDESK_FALLBACK_TICKETS, true)
    ) {
      return;
    }

    const base = anchordeskApiBase();
    const token = anchordeskToken();
    if (!base || !token) return;

    fallbackTicketStarted = true;
    const endedAt = new Date();
    const durationSeconds = Math.max(0, Math.round((endedAt - connectedAt) / 1000));
    const transcriptText = transcript.length
      ? transcript.map((entry) => `[${entry.role}] ${entry.text}`).join("\n")
      : "No completed transcript was captured before the call ended.";
    const lastUserText = [...transcript].reverse().find((entry) => entry.role === "user")?.text;
    const priority = hasUrgentLanguage(transcript) ? "1" : "3";

    try {
      const existing = await anchordeskRequest(
        "get",
        `/tickets/search?q=${encodeURIComponent(sessionUuid)}&limit=1`
      );
      if (Array.isArray(existing) && existing.length > 0) {
        ticketCreateObserved = true;
        console.log(`AnchorDesk ticket already exists for session ${sessionUuid}`);
        return;
      }

      const ticket = await anchordeskRequest("post", "/tickets", {
        title: "avr follow up",
        summary: truncate(
          lastUserText
            ? `AVR call follow-up: ${lastUserText}`
            : "AVR call ended before caller details were captured.",
          500
        ),
        description: [
          "Automatically created by AVR fallback because no create-ticket tool call was observed before disconnect.",
          "",
          `Session UUID: ${sessionUuid}`,
          `Started: ${connectedAt.toISOString()}`,
          `Ended: ${endedAt.toISOString()}`,
          `Duration: ${durationSeconds} seconds`,
          `Cleanup reason: ${reason}`,
          "",
          "Transcript:",
          transcriptText,
        ].join("\n"),
        status: "Open",
        priority,
        source: "local",
        externalProvider: "avr",
        externalId: sessionUuid,
      });
      ticketCreateObserved = true;
      console.log(
        `Created AnchorDesk fallback ticket ${ticket.ticketNumber || ticket.id} for AVR session ${sessionUuid}`
      );
    } catch (error) {
      const status = error.response?.status;
      const body = error.response?.data;
      console.error(
        `Failed to create AnchorDesk fallback ticket for session ${sessionUuid}: ${status || ""} ${error.message}`,
        body || ""
      );
    }
  }

  /**
   * Cleans up resources and closes connections.
   */
  function cleanup(reason) {
    if (cleanupStarted) return;
    cleanupStarted = true;
    stopToolSfx();
    cancelMcpNudge();
    maybeCreateFallbackTicket(reason).catch((error) => {
      console.error("AnchorDesk fallback ticket cleanup failed:", error);
    });
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    if (clientWs && clientWs.readyState === WebSocket.OPEN) clientWs.close();
  }
};

/**
 * Global cleanup function to destroy resamplers when the process is terminated.
 */
const cleanupGlobalResources = () => {
  console.log("Cleaning up global resources...");
  if (globalDownsampler) {
    globalDownsampler.destroy();
    globalDownsampler = null;
  }
  if (globalUpsampler) {
    globalUpsampler.destroy();
    globalUpsampler = null;
  }
  console.log("Global resources cleaned up");
};

// Handle process termination signals
process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down gracefully...");
  cleanupGlobalResources();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down gracefully...");
  cleanupGlobalResources();
  process.exit(0);
});

// Initialize resamplers and start server
const startServer = async () => {
  try {
    await initializeResamplers();

    // HTTP + WebSocket on one port. HTTP serves warm-transfer briefing audio
    // to the Asterisk dialplan (GET /brief/<uuid>.wav); WebSocket carries the
    // avr-core audio bridge as before.
    const PORT = process.env.PORT || 6030;
    const server = http.createServer((req, res) => {
      const briefMatch =
        req.method === "GET" &&
        req.url.match(/^\/brief\/([0-9a-fA-F-]{36})\.wav$/);
      if (briefMatch) {
        const audio = getBriefing(briefMatch[1]);
        if (audio) {
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": audio.length,
          });
          res.end(audio);
        } else {
          res.writeHead(404);
          res.end("no briefing for that uuid");
        }
        return;
      }
      // The dialplan reports how the call reached the DID before it enters
      // AudioSocket, so the entry is always on file by session setup.
      const callInfoMatch =
        req.method === "POST" &&
        req.url.match(/^\/callinfo\/([0-9a-fA-F-]{36})$/);
      if (callInfoMatch) {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const params = new URLSearchParams(body);
          const info = {
            path: params.get("path") === "forward" ? "forward" : "direct",
            caller: params.get("caller") || null,
          };
          setCallInfo(callInfoMatch[1], info);
          console.log(`Call info for ${callInfoMatch[1]}:`, info);
          res.writeHead(204);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wss = new WebSocket.Server({ server });

    wss.on("connection", (clientWs) => {
      console.log("New client connected");
      handleClientConnection(clientWs);
    });

    server.listen(PORT, () => {
      console.log(
        `OpenAI Speech-to-Speech WebSocket server running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Start the server
startServer();
