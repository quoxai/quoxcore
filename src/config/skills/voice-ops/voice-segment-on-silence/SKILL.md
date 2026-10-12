---
name: voice-segment-on-silence
license: LicenseRef-SkillRights-Reserved-1.0
category: voice/operations
version: 1.0.0
edition: beta
author: quox-core
description: Split a long audio artefact at silence boundaries to produce ordered segment intervals that Quox stores as evidence, ready to feed chunked transcription or downstream audio processing.
tags: [audio-segmentation, silence-detection, vad, chunked-transcription, audio-artefact, segment-intervals, preprocessing]
best_for_agents: [quox]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Voice Segment on Silence

## When to apply

Use this skill when a long audio artefact must be divided into manageable, self-contained segments before transcription or analysis. Typical triggers: a meeting recording longer than 30 seconds must be transcribed with accurate per-segment timestamps via `voice-transcribe-audio`, an audio file exceeds the STT provider's maximum payload size, or a voice log must be partitioned into speaker turns for downstream routing. Apply this skill before invoking `voice-transcribe-audio` on any audio longer than 60 seconds — chunking at natural speech boundaries produces significantly better STT accuracy than arbitrary time-based splits. The output segment intervals reference the original artefact; this skill does not create new binary artefacts for each segment, only the interval metadata.

## Inputs

- `artefact_id` (string) — Evidence artefact identifier of the source audio to segment. Required. Must reference an artefact with `evidence_type: audio_segment`.
- `silence_threshold_db` (number, optional) — RMS amplitude threshold in decibels below which a region is classified as silence. Lower (more negative) values are more sensitive to quiet passages. Default: `-40` dBFS.
- `min_silence_ms` (number, optional) — Minimum continuous silence duration in milliseconds required to trigger a segment boundary. Shorter silences (e.g. brief pauses within a sentence) are ignored. Default: `700`.
- `min_segment_ms` (number, optional) — Minimum acceptable segment length in milliseconds. Segments shorter than this value are merged with the adjacent segment. Default: `3000`.
- `max_segment_ms` (number, optional) — Maximum acceptable segment length in milliseconds. If no silence boundary is found within this window, a forced split is inserted at the nearest zero-crossing. Default: `30000`.
- `padding_ms` (number, optional) — Milliseconds of audio to include before and after each detected boundary, preserving the onset of speech at segment edges. Default: `200`.
- `corr` (string, optional) — AOCL correlation ID to attach to the segment-map artefact. When provided, all downstream transcription calls using these intervals should pass the same `corr` to group the full conversation in evidence.

## Steps

1. Resolve the source artefact: fetch the artefact metadata from `/api/evidence/:artefact_id`. Verify that `evidence_type` is `audio_segment`. If the artefact does not exist or has a different type, return an error immediately.
2. Retrieve the audio binary from the evidence store. Determine the total audio duration by reading the file header. If the audio is shorter than `min_segment_ms`, return a single-segment interval spanning the full file without performing silence detection — there is nothing to split.
3. Open an AEE envelope with `type: task`, `intent: quox.voice.segment.split`. Include `artefact_id`, `silence_threshold_db`, `min_silence_ms`, and `max_segment_ms` in the envelope payload metadata. Inherit or assign `corr`.
4. Submit the audio binary to the collector's audio-processing pipeline. The pipeline applies a sliding RMS window (50 ms window, 25 ms hop) across the waveform to build a per-frame amplitude profile. Frames where `RMS < silence_threshold_db` are tagged as silent.
5. Identify silence regions: collect contiguous runs of silent frames whose total duration meets or exceeds `min_silence_ms`. Each such region is a candidate boundary. The boundary position within the region is placed at the midpoint of the silence run.
6. Build the initial segment list: intervals between consecutive boundaries, with `padding_ms` applied to both edges (clamped to the file bounds so no segment starts before 0 or ends after the total duration).
7. Apply merge and split passes:
   a. Merge: iterate forward through segments; if a segment's duration is less than `min_segment_ms`, merge it with its later neighbour (or earlier if it is the last segment).
   b. Split: iterate through segments; if a segment's duration exceeds `max_segment_ms`, locate the nearest zero-crossing to the midpoint and insert a forced boundary there.
8. Assign sequential `segment_index` values (0-based) to the final segment list. Each segment records `start_ms`, `end_ms`, `duration_ms`, and `forced_split` (boolean, true when step 7b applied).
9. Store the segment map as an evidence artefact via `/api/evidence` with `evidence_type: audio_segment_map`. Include `source_artefact_id`, `segment_count`, `total_duration_ms`, `silence_threshold_db`, `min_silence_ms`, `max_segment_ms`, and the AEE `corr` id in the metadata. Store the full segments array as the artefact body.
10. Close the AEE envelope with `type: result`. Include `segment_map_artefact_id` and `segment_count` in the result payload.

## Outputs

- `segment_map_artefact_id` (string) — Evidence artefact identifier for the stored segment-map record.
- `segments` (array) — Ordered array of segment interval objects, each containing: `segment_index` (number), `start_ms` (number), `end_ms` (number), `duration_ms` (number), `forced_split` (boolean).
- `segment_count` (number) — Total number of segments produced.
- `total_duration_ms` (number) — Full duration of the source audio in milliseconds.
- `source_artefact_id` (string) — The `artefact_id` of the source audio that was segmented.
- `silence_threshold_db` (number) — The dBFS threshold used.
- `min_silence_ms` (number) — The minimum silence duration used for boundary detection.
- `forced_split_count` (number) — Number of segments that were split by the max-segment guard rather than at a natural silence boundary.
- `corr` (string) — AOCL correlation ID for grouping downstream transcription calls.
- `segmented_at` (string) — ISO 8601 UTC timestamp when segmentation completed.

## Failure modes

- **Artefact not found:** The supplied `artefact_id` does not exist in evidence storage or belongs to a different org. Return error `"artefact '<id>' not found"` without calling the audio pipeline.
- **Wrong evidence type:** The artefact has an `evidence_type` other than `audio_segment`. Return a descriptive error. Callers should not pass a segment-map artefact back into this skill for re-segmentation.
- **All silence or all speech:** The amplitude profile is uniformly below the threshold (entirely silent file) or uniformly above it (no detectable silence). In either case, return a single segment spanning the full duration. Set `forced_split_count: 0` and include a `warning` field: `"no silence boundaries detected; single segment returned"`. This is a valid output, not an error — the caller should decide whether to adjust thresholds and retry.
- **Forced-split-heavy output:** If more than 30% of segments were produced by the max-segment guard (step 7b) rather than natural silence, the output includes a `warning` field: `"high forced-split ratio (<n>/<total>); consider increasing silence_threshold_db or decreasing max_segment_ms"`. The output is usable but STT accuracy at forced-split boundaries may be lower than at natural boundaries.
- **Audio pipeline processing error:** The collector's audio-processing pipeline returned an error (e.g. unsupported codec, corrupt file header). Surface the pipeline error verbatim. Emit a VOLT evidence record with `evidence_type: audio_pipeline_error`. Do not return partial segment intervals from a failed run — return the error and let the caller decide whether to convert or repair the source artefact.

## Notes

The segment intervals produced by this skill are metadata only — the source audio binary is not split or duplicated. Downstream callers (typically `voice-transcribe-audio`) receive the `segments` array and use `start_ms`/`end_ms` to request byte-range extraction of the source binary at transcription time. This design keeps evidence storage lean: one binary artefact plus one segment-map artefact covers the full pipeline, regardless of how many segments are produced. When building a full voice-processing pipeline, the recommended call order is: store audio → `voice-segment-on-silence` → for each segment: `voice-transcribe-audio` with the same `corr`. This `corr` chain allows the evidence viewer to reconstruct the full conversation from individual segment transcripts ordered by `segment_index`.
