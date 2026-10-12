/**
 * useExecutionSync - Bridges QuoxFlow executions into browser AEE store
 *
 * Polls QuoxFlow for recent executions and stores their AEE envelopes
 * in IndexedDB so they appear in the Activity page. This ensures that
 * scheduled workflow executions (which happen server-side) are visible
 * alongside manually-triggered ones.
 *
 * Without this, only manually-run workflows would appear in Activity
 * because only the browser UI creates IndexedDB entries.
 */

import { useEffect, useRef, useCallback } from 'react';
import { listExecutions } from '../services/quoxflowClient';
import { storeEnvelopes, getConversation, queryEnvelopes, deleteEnvelope } from '../lib/aee/store';
import { createEvent } from '../lib/aee/envelope';
import { QUOXFLOW_INTENTS } from '../lib/aee/intents';
import { isDevBypassEnabled } from '../utils/devMode';

// Sync every 60 seconds (was 30 — reduce load)
const SYNC_INTERVAL = 60_000;

// Only look back 24h for executions
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

// One-time cleanup flag (per page load)
let cleanupDone = false;

/**
 * Purge duplicate WFEXEC_ envelopes from IndexedDB.
 * Keeps only the 2 newest envelopes per correlation ID (STARTED + COMPLETED).
 */
async function cleanupDuplicateExecutions() {
    if (cleanupDone) return;
    cleanupDone = true;
    try {
        const allEnvelopes = await queryEnvelopes({ intentPrefix: 'quoxflow.flow', limit: 500 }) || [];
        // Group by correlation ID
        const byCorr = {};
        for (const env of allEnvelopes) {
            if (!env.corr?.startsWith('WFEXEC_')) continue;
            if (!byCorr[env.corr]) byCorr[env.corr] = [];
            byCorr[env.corr].push(env);
        }
        let deleted = 0;
        for (const [corr, envs] of Object.entries(byCorr)) {
            if (envs.length <= 2) continue; // Normal: 1 STARTED + 1 COMPLETED
            // Sort by timestamp descending, keep newest 2, delete rest
            envs.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
            for (let i = 2; i < envs.length; i++) {
                try { await deleteEnvelope(envs[i].id); deleted++; } catch { /* skip */ }
            }
        }
        if (deleted > 0) console.log(`[ExecutionSync] Cleaned up ${deleted} duplicate envelopes`);
    } catch (err) {
        console.warn('[ExecutionSync] Cleanup error:', err?.message || err);
    }
}

/**
 * Sync recent executions from QuoxFlow into the AEE IndexedDB store.
 * Uses IndexedDB correlation ID lookup for dedup (survives reload).
 */
async function syncExecutions() {
    try {
        const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
        const result = await listExecutions({ since, limit: 50 });
        const executions = result?.data || result?.executions || [];

        if (!executions.length) return;

        for (const exec of executions) {
            const execId = exec.id || exec.executionId;
            if (!execId) continue;

            // Build a stable correlation ID for this execution
            const corrId = exec.correlationId || `WFEXEC_${execId}`;

            // Check IndexedDB for existing envelopes with this correlation ID
            // getConversation queries the 'corr' index — proper dedup that survives reload
            try {
                const existing = await getConversation(corrId);
                if (existing && existing.length > 0) continue; // Already synced
            } catch {
                // If IndexedDB query fails, skip this execution rather than create dupes
                continue;
            }

            // Create minimal FLOW_STARTED + FLOW_COMPLETED envelope pair
            const wfName = exec.workflowName || exec.workflow?.name || exec.workflowId || 'Unknown Workflow';
            const status = exec.status || 'completed';
            const trigger = exec.triggeredBy || exec.triggerMode || 'schedule';
            const startedAt = exec.startedAt || exec.createdAt || new Date().toISOString();
            const completedAt = exec.completedAt || exec.finishedAt || startedAt;

            const envelopes = [];

            // FLOW_STARTED
            envelopes.push(createEvent(
                trigger === 'schedule' ? 'system.scheduler' : 'human.user',
                QUOXFLOW_INTENTS.FLOW_STARTED,
                {
                    workflowId: exec.workflowId,
                    workflowName: wfName,
                    executionId: execId,
                    triggerMode: trigger,
                    initiator: trigger === 'schedule' ? 'quoxflow.scheduler' : 'ui',
                    requestedAt: startedAt
                },
                corrId
            ));

            // FLOW_COMPLETED or FLOW_FAILED
            const endIntent = status === 'failed'
                ? QUOXFLOW_INTENTS.FLOW_FAILED
                : QUOXFLOW_INTENTS.FLOW_COMPLETED;

            envelopes.push(createEvent(
                'agent.quoxflow',
                endIntent,
                {
                    workflowId: exec.workflowId,
                    workflowName: wfName,
                    executionId: execId,
                    status,
                    duration: exec.duration || exec.durationMs,
                    error: exec.error || null,
                    completedAt
                },
                corrId
            ));

            try {
                await storeEnvelopes(envelopes);
            } catch (e) {
                console.warn('[ExecutionSync] Failed to store envelopes:', e);
            }
        }
    } catch (err) {
        // Don't spam console — this is a background sync
        if (err?.message?.includes('Failed to fetch')) return;
        console.warn('[ExecutionSync] Sync error:', err?.message || err);
    }
}

/**
 * Hook that syncs QuoxFlow executions into browser AEE store.
 * Mount this in AppShell or a top-level component.
 *
 * @param {Object} options
 * @param {boolean} [options.enabled=true] - Whether sync is active
 * @param {number} [options.interval] - Custom poll interval in ms
 */
export default function useExecutionSync({ enabled = true, interval = SYNC_INTERVAL } = {}) {
    const intervalRef = useRef(null);
    const devBypass = isDevBypassEnabled();

    const sync = useCallback(() => {
        if (!enabled || devBypass) return;
        syncExecutions();
    }, [devBypass, enabled]);

    useEffect(() => {
        if (!enabled || devBypass) return;

        // Clean up old duplicates then sync
        const initTimer = setTimeout(() => {
            cleanupDuplicateExecutions().then(sync);
        }, 2000);

        // Periodic sync
        intervalRef.current = setInterval(sync, interval);

        return () => {
            clearTimeout(initTimer);
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [sync, interval, enabled, devBypass]);

    return { syncNow: sync };
}
