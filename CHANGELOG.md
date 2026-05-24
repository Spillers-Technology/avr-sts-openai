# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.0] - 2026-05-24

### Added

- GA Realtime API support with default model `gpt-realtime-2`.
- Configurable turn detection via `OPENAI_TURN_DETECTION` (`server_vad` default, optional `semantic_vad`) and `OPENAI_TURN_DETECTION_EAGERNESS`.
- `OPENAI_REASONING_EFFORT` for `gpt-realtime-2` models (`low`, `medium`, `high`).
- `OPENAI_TRANSCRIPTION_MODEL` for input audio transcription.

### Changed

- Migrated from beta `gpt-4o-realtime-preview` to the GA Realtime session schema (`type: realtime`, nested `audio`, `output_modalities`, `max_output_tokens`).
- Removed `OpenAI-Beta: realtime=v1` header.
- Primary GA server events: `response.output_audio.delta`, `response.output_audio_transcript.done` (legacy beta event names retained as fallbacks).

### Fixed

- Reject deprecated beta models (`gpt-4o-realtime-preview`, etc.) at session init with a clear AVR client `error`.
- Clamp invalid `OPENAI_REASONING_EFFORT` values to `low`.
- Forward tool execution failures to AVR clients as `error` events.

### Documentation

- README breaking-change section for GA migration.
- `.env.example` documents new optional settings.
