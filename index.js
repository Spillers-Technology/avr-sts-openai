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

const WebSocket = require("ws");
const axios = require("axios");
const fs = require("fs").promises;
const { create } = require("@alexanderolsen/libsamplerate-js");
const { loadTools, getToolHandler } = require("./loadTools");

require("dotenv").config();

const DEFAULT_MODEL = "gpt-realtime-2";
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

  let audioBuffer8k = [];
  let ws = null;

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

      // Load available tools for OpenAI
      try {
        obj.session.tools = loadTools();
        console.log(`Loaded ${obj.session.tools.length} tools for OpenAI`);
      } catch (error) {
        console.error(`Error loading tools for OpenAI: ${error.message}`);
      }

      console.log(obj.session);

      ws.send(JSON.stringify(obj));
    });

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);

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
            console.log("Session updated:", message);
            await ws.send(JSON.stringify(buildResponseCreate()));
            break;

          case "response.output_audio.delta":
          case "response.audio.delta":
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
              const content = await handler(
                sessionUuid,
                JSON.parse(message.arguments)
              );
              console.log("Tool response:", content);
              ws.send(
                JSON.stringify(
                  buildResponseCreate({ instructions: content })
                )
              );
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
            clientWs.send(JSON.stringify(agentData));
            console.log("Agent transcript:", agentData);
            break;

          case "input_audio_buffer.speech_started":
            console.log("Audio streaming started");
            clientWs.send(JSON.stringify({ type: "interruption" }));
            break;

          case "conversation.item.input_audio_transcription.completed":
            const userData = {
              type: "transcript",
              role: "user",
              text: message.transcript,
            };
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
      cleanup();
    });

    ws.on("error", (err) => {
      console.error("OpenAI WebSocket error:", err);
      cleanup();
    });
  };

  // Handle client WebSocket close
  clientWs.on("close", () => {
    console.log("Client WebSocket connection closed");
    cleanup();
  });

  clientWs.on("error", (err) => {
    console.error("Client WebSocket error:", err);
    cleanup();
  });

  /**
   * Cleans up resources and closes connections.
   */
  function cleanup() {
    if (ws) ws.close();
    if (clientWs) clientWs.close();
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

    // Create WebSocket server
    const PORT = process.env.PORT || 6030;
    const wss = new WebSocket.Server({ port: PORT });

    wss.on("connection", (clientWs) => {
      console.log("New client connected");
      handleClientConnection(clientWs);
    });

    console.log(
      `OpenAI Speech-to-Speech WebSocket server running on port ${PORT}`
    );
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Start the server
startServer();
