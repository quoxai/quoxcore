---
name: tts-speak-localised
license: LicenseRef-SkillRights-Reserved-1.0
category: voice/operations
version: 1.0.0
edition: beta
author: quox-core
description: Render text to speech via the registered TTS provider with locale and voice id, returning a durable audio artefact reference that Quox stores in evidence for downstream playback or verification.
tags: [tts, text-to-speech, elevenlabs, localisation, audio-artefact, voice-id, bcp47]
best_for_agents: [quox, action-q]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# TTS Speak Localised

## When to apply

Use this skill when an agent or workflow must convert text into audible speech and return a referenceable audio artefact rather than streaming audio bytes inline. Typical triggers: a notification pipeline must announce a result to an operator over voice, a HITL approval response includes an audio acknowledgment, or an automated report is rendered to spoken audio for a locale-aware audience. Apply after the text payload has been finalised; do not invoke mid-generation while the text content is still being composed.

## Inputs

- `text` (string) — The plain-text content to synthesise. Required. Maximum 5,000 characters per invocation; split longer content and call in sequence.
- `locale` (string) — BCP-47 locale code controlling language and regional accent. Required. Examples: `en-US`, `de-DE`, `fr-FR`, `sv-SE`. Must match a locale supported by the configured ElevenLabs voice.
- `voice_id` (string) — ElevenLabs voice identifier. Required. Examples: `voice_id_en_us_warm_1`, `voice_id_de_de_authoritative_1`. The voice registry is loaded from the Quox voice settings configuration; callers must pass a registered identifier, not a raw ElevenLabs API ID.
- `stability` (number, optional) — ElevenLabs stability parameter, range 0.0–1.0. Controls consistency of the output voice. Default: `0.75`.
- `similarity_boost` (number, optional) — ElevenLabs similarity boost, range 0.0–1.0. Default: `0.75`.
- `output_format` (string, optional) — Audio encoding format. Supported: `mp3_44100_128`, `pcm_16000`. Default: `mp3_44100_128`.
- `corr` (string, optional) — AOCL correlation ID to attach to the resulting artefact. When provided, the audio artefact inherits this correlation so downstream STT verification can be linked back to the originating TTS request.

## Steps

1. Validate `locale` against the BCP-47 pattern (`^[a-z]{2}-[A-Z]{2}$`). If the format is invalid, return a validation error immediately without calling the TTS provider.
2. Look up `voice_id` in the Quox voice registry. Confirm the voice is active and that its declared locale matches the requested `locale`. If there is a mismatch, return an error — do not silently substitute a different voice, as locale substitution can produce unintelligible output.
3. Open an AEE envelope with `type: task`, `intent: quox.voice.tts.render`, and include `locale`, `voice_id`, and `text.length` in the payload metadata. Assign or inherit `corr` from the caller.
4. Issue the synthesis request to the ElevenLabs API via the collector's `/collector/webhook/speak` proxy endpoint. Include `voice_id`, `text`, `stability`, `similarity_boost`, and `output_format` as the request body. The collector handles credential injection from the vault; callers must never embed the ElevenLabs API key directly.
5. On a successful 2xx response, receive the audio binary. Compute `duration_ms` from the audio stream length and `output_format` sample rate.
6. Store the audio binary as an evidence artefact via `/api/evidence` with `evidence_type: audio_segment`, including `locale`, `voice_id`, `text_length`, `duration_ms`, and the AEE `corr` id in the metadata fields.
7. Record `artefact_id` returned by the evidence endpoint. Close the AEE envelope with `type: result` and include `artefact_id` and `duration_ms` in the result payload.
8. Return the structured output object (see Outputs).

## Outputs

- `artefact_id` (string) — Evidence artefact identifier for the rendered audio. Use this reference to retrieve or stream the audio via `/api/evidence/:artefact_id`.
- `voice_id` (string) — The voice identifier used for synthesis.
- `locale` (string) — The BCP-47 locale code used.
- `duration_ms` (number) — Approximate audio duration in milliseconds.
- `output_format` (string) — The audio encoding format of the stored artefact.
- `text_length` (number) — Character count of the input text.
- `corr` (string) — AOCL correlation ID linking this artefact to the originating request.
- `rendered_at` (string) — ISO 8601 UTC timestamp when synthesis completed.

## Failure modes

- **Voice ID not found in registry:** The supplied `voice_id` is not present in the Quox voice registry. Return a validation error with message `"voice_id '<id>' is not registered in the Quox voice configuration"`. Do not fall back silently to a default voice — the caller must correct the input, as the wrong voice may violate locale or persona requirements.
- **Locale mismatch:** The registered voice locale does not match the requested `locale`. Return a validation error listing both the requested locale and the voice's declared locale. The caller must choose a voice that matches the target locale.
- **ElevenLabs API error:** The TTS provider returned a non-2xx status. Surface the HTTP status code and provider error message verbatim in the skill error output. Emit a VOLT evidence record with `evidence_type: tts_provider_error`. Do not retry automatically — provider errors may indicate quota exhaustion or content policy rejection, both of which require caller intervention.
- **Evidence store write failure:** The audio binary was synthesised but `/api/evidence` returned an error. In this case, the audio binary is lost and cannot be recovered — return an error indicating the artefact could not be persisted and include the evidence endpoint error. The caller must re-invoke the full skill to regenerate.
- **Text exceeds length limit:** Input text is longer than 5,000 characters. Return a validation error immediately, before any API call. Recommend that the caller split the text and invoke the skill in sequence, passing the same `corr` id to all segments so they are linked in evidence.

## Notes

Audio artefacts stored via this skill are immutable evidence records. Once written, they cannot be overwritten by subsequent invocations — each call produces a new `artefact_id`. When a workflow requires sequenced audio (for example, narrating a multi-part report), invoke this skill once per segment and collect the resulting `artefact_id` values; the caller is responsible for ordering and concatenating playback. The `corr` field is the recommended mechanism for grouping related artefacts: pass the same `corr` across all segments of a single logical utterance. Because ElevenLabs billing is per character, workflows that generate high-volume TTS should gate invocation on user-confirmed need rather than invoking speculatively on every execution branch.
