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

/**
 * Creates and configures a WebSocket connection to OpenAI's real-time API.
 *
 * @returns {WebSocket} Configured WebSocket instance
 */
const connectToOpenAI = () => {
  const model = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
  console.log("Connecting to OpenAI with model:", model);
  return new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
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
    ws = connectToOpenAI();

    // Configure WebSocket event handlers
    ws.on("open", async () => {
      console.log("WebSocket connected to OpenAI");

      // Initialize session with audio format specifications
      const obj = {
        type: "session.update",
        session: {
          input_audio_format: "pcm16",
          input_audio_transcription: {
            model: "whisper-1",
          },
          output_audio_format: "pcm16",
          instructions:
            "You are a helpful assistant that can answer questions and help with tasks.",
          temperature: +process.env.OPENAI_TEMPERATURE || 0.8,
          max_response_output_tokens: +process.env.OPENAI_MAX_TOKENS || "inf",
          voice: process.env.OPENAI_VOICE || "alloy", // default voice is alloy
        },
      };

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
            await ws.send(
              JSON.stringify({
                type: "response.create",
              })
            );
            break;

          case "response.audio.delta":
            const audioChunk = Buffer.from(message.delta, "base64");
            const audioFrames = processOpenAIAudioChunk(audioChunk);
            // Send audio frames to client
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
              console.error(`No handler found for tool: ${message.name}`);
              return;
            }

            try {
              // Execute the tool handler with the provided arguments
              const content = await handler(
                sessionUuid,
                JSON.parse(message.arguments)
              );
              console.log("Tool response:", content);
              ws.send(
                JSON.stringify({
                  type: "response.create",
                  response: {
                    instructions: content,
                  },
                })
              );
            } catch (error) {
              // Handle errors during tool execution
              console.error(`Error executing tool ${message.name}:`, error);
              return;
            }
            break;

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
