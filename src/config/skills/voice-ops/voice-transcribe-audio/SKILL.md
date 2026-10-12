---
name: voice-transcribe-audio
license: LicenseRef-SkillRights-Reserved-1.0
category: voice/operations
version: 1.0.0
edition: beta
author: quox-core
description: Transcribe an audio artefact via the registered STT provider, returning the full transcript text, per-segment timestamps, and per-segment confidence scores that Quox stores as a durable evidence record.
tags: [stt, speech-to-text, whisper, transcription, timestamps, confidence, audio-artefact]
best_for_agents: [quox]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Voice Transcribe Audio

## When to apply

Use this skill when an agent must convert a stored audio artefact into structured text with segment-level timing and confidence data. Typical triggers: a voice command has been recorded and must be parsed for intent routing, an operator meeting recording requires a timestamped transcript for compliance storage, or a TTS-rendered audio artefact produced by `tts-speak-localised` requires round-trip verification. Apply after the audio artefact has been stored via `/api/evidence`; do not pass raw audio bytes directly — reference the `artefact_id` and let the skill fetch the binary from evidence storage.

## Inputs

- `artefact_id` (string) — Evidence artefact identifier of the audio to transcribe. Required. Must reference an artefact with `evidence_type: audio_segment`.
- `language` (string, optional) — BCP-47 language hint for the STT model. Providing this reduces latency and improves accuracy for non-English audio. Default: `en` (Whisper auto-detection is active when omitted, but a hint is strongly recommended for non-English inputs).
- `segment_granularity` (string, optional) — Granularity of timestamp segments in the output. Accepted values: `word`, `segment`. Default: `segment`. Use `word` only when precise word-level timing is required, as it increases response payload size and processing time.
- `prompt` (string, optional) — A short primer string to condition the Whisper model on domain-specific vocabulary, spellings, or proper nouns (e.g. `"Quox, QuoxFlow, AOCL, VOLT"`). Maximum 224 tokens. Improves accuracy for technical jargon.
- `corr` (string, optional) — AOCL correlation ID. When provided and when the source artefact has a matching `corr` field, the transcript evidence record is linked to the same correlation chain as the originating TTS or recording session.

## Steps

1. Resolve the source artefact: fetch the artefact metadata from `/api/evidence/:artefact_id`. Verify that `evidence_type` is `audio_segment`. If the artefact does not exist or has a different type, return an error without calling the STT provider.
2. Retrieve the audio binary from the evidence store. Check that the binary is non-empty and that its encoded format is supported by Whisper (`mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm`). If the format is unsupported, return an error listing the detected format and the supported set.
3. Open an AEE envelope with `type: task`, `intent: quox.voice.stt.transcribe`. Include `artefact_id`, `language`, and `segment_granularity` in the envelope payload metadata. Inherit or assign `corr`.
4. Submit the audio binary to the STT provider via the collector's `/collector/webhook/transcribe` proxy endpoint. Include `language`, `segment_granularity`, and `prompt` (if provided) in the request body. The collector handles OpenAI Whisper API credential injection; callers must never embed the API key directly.
5. Receive the STT response. Extract the `text` field (full transcript) and the `segments` array. Each segment contains `id`, `start` (seconds), `end` (seconds), `text`, and `avg_logprob` (log-probability, used to compute confidence).
6. Normalise confidence per segment: compute `confidence = clamp(exp(avg_logprob), 0.0, 1.0)`. Flag any segment with `confidence < 0.60` as low-confidence in the output.
7. Store the transcript as an evidence artefact via `/api/evidence` with `evidence_type: audio_transcript`. Include `source_artefact_id`, `language`, `segment_count`, `duration_ms` (derived from last segment `end` × 1000), `low_confidence_segment_count`, and the AEE `corr` id in the metadata. Store the full `segments` array as the artefact body.
8. Close the AEE envelope with `type: result`. Include `transcript_artefact_id`, `segment_count`, and `low_confidence_segment_count` in the result payload.
9. Return the structured output object (see Outputs).

## Outputs

- `transcript_artefact_id` (string) — Evidence artefact identifier for the stored transcript record.
- `text` (string) — Full concatenated transcript of the audio.
- `language` (string) — Language code detected or declared for the transcription.
- `segments` (array) — Array of segment objects, each containing: `id` (number), `start_ms` (number), `end_ms` (number), `text` (string), `confidence` (number, 0.0–1.0), `low_confidence` (boolean).
- `segment_count` (number) — Total number of segments in the transcript.
- `low_confidence_segment_count` (number) — Number of segments where `confidence < 0.60`.
- `duration_ms` (number) — Total audio duration in milliseconds, derived from the final segment end time.
- `source_artefact_id` (string) — The `artefact_id` of the source audio that was transcribed.
- `corr` (string) — AOCL correlation ID linking this transcript to the originating request chain.
- `transcribed_at` (string) — ISO 8601 UTC timestamp when transcription completed.

## Failure modes

- **Artefact not found:** The supplied `artefact_id` does not exist in evidence storage or belongs to a different org. Return error `"artefact '<id>' not found"`. Do not proceed to the STT call.
- **Wrong evidence type:** The artefact exists but has an `evidence_type` other than `audio_segment` (for example, `audio_transcript` from a prior transcription). Return a descriptive error so the caller does not accidentally transcribe a transcript. The caller should verify they are passing the source audio artefact, not the output.
- **Unsupported audio format:** The audio binary is in a format Whisper cannot process. Return a validation error listing the detected format. The caller must convert the audio to a supported format before re-invoking.
- **STT provider error:** The Whisper API returned a non-2xx response. Surface the HTTP status and provider error message verbatim. Emit a VOLT evidence record with `evidence_type: stt_provider_error`. Do not retry automatically — provider errors may indicate oversized payloads, rate limiting, or audio content rejection.
- **Empty transcript returned:** The STT provider returned a 2xx response but the `text` field is empty and the `segments` array is empty. This typically indicates a silent or corrupted audio file. Store a transcript artefact with `segment_count: 0` and `text: ""` so that the absence of content is itself a durable evidence record, then return the output with a warning flag `empty_transcript: true`.

## Notes

Whisper processes audio in 30-second windows internally. For files longer than 30 seconds, segment boundaries at the 30-second marks may have slightly higher uncertainty and the skill will reflect this in `confidence` values at those boundaries. Callers that require high accuracy on long recordings should use `voice-segment-on-silence` first to split the audio at natural speech boundaries, then invoke `voice-transcribe-audio` on each segment, passing the same `corr` id across all segment transcription calls to group them in evidence. The `prompt` parameter is the most impactful tuning lever for domain-specific vocabulary; passing Quox-specific terms (`Quox, QuoxFlow, AOCL, VOLT, HITL`) as a prompt significantly reduces transcription errors on operator recordings that discuss the platform.
