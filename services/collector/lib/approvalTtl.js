'use strict';

/**
 * approvalTtl.js — the ONE approval lifetime both sides read.
 *
 * toolResume.js refuses to execute an approval older than this (QUOXTRUST
 * T-AUTH), and approvalExpirySweeper.js closes the human-facing card at the
 * same age. They used to disagree: the sweeper only closed "do it now" cards,
 * so a note save, a post or a PR card stayed approvable in the inbox after the
 * resume path would already refuse it. A human then clicked Approve, the card
 * said approved, and nothing ran (live 2026-10-10, notesq_update at 84 min).
 */
const APPROVAL_MAX_AGE_MS = 60 * 60 * 1000; // 1h, matches the system HITL approval timeout default

module.exports = { APPROVAL_MAX_AGE_MS };
