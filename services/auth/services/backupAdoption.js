/**
 * BACKUP #727: after an auth restart, re-attach to backup containers that kept
 * running. A 'running' backup row whose quox-backup-<id> container is still
 * alive is adopted (monitored to completion with the same result parsing as a
 * live run), never marked failed and never duplicated.
 *
 * Also hosts the orphan reaper (containers older than 24h).
 */
import { prepare } from '../db/index.js';
import {
    detachedBackupsEnabled, listBackupContainers, attachMonitor, containerNameFor,
    statusFileFor, reapOrphanBackupContainers, stopAndRemove, releaseBackupWitnesses, BACKUP_LABEL,
} from '../lib/backupContainer.js';
import { EventEmitter } from 'events';

const monitored = new Set();
const BACKUP_ROOT = process.env.BACKUP_ROOT || '/opt/quoxcore/backups';

/**
 * @param {object} deps  {docker, log, ...} for backupContainer plus
 *   finalizers {finalizeRoute, finalizeScheduled} (injected to avoid import cycles and for tests)
 * @returns {Promise<{adopted: string[], removed: string[]}>}
 */
export async function adoptDetachedBackups(deps = {}) {
    const log = deps.log || console;
    const adopted = []; const removed = [];
    if (!detachedBackupsEnabled(deps).enabled) return { adopted, removed };
    let containers;
    try { containers = await listBackupContainers(deps); }
    catch (err) { log.error(`[Backup] adoption: cannot list backup containers: ${err.message}`); return { adopted, removed }; }

    for (const c of containers) {
        const backupId = c.backupId;
        if (!backupId || monitored.has(c.name)) continue;
        const row = prepare('SELECT id, org_id, name, status FROM backups WHERE id = ?').get(backupId);
        if (!row || row.status !== 'running') {
            // Already finalised (or unknown): nothing to adopt. Remove it if it has exited.
            if (!c.running) { await releaseBackupWitnesses(c.name, statusFileFor(BACKUP_ROOT, backupId), deps); removed.push(c.name); }
            continue;
        }
        const labels = c.labels;
        const origin = labels[`${BACKUP_LABEL}.origin`] || 'route';
        const startTime = c.startedAt || Date.now();
        const container = { name: c.name, deadline: c.deadline, statusFile: statusFileFor(BACKUP_ROOT, backupId) };
        monitored.add(c.name);
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        let stdout = ''; let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('close', async (code) => {
            monitored.delete(c.name);
            try {
                if (origin === 'scheduler') {
                    const schedule = prepare('SELECT * FROM backup_schedules WHERE id = ?').get(labels[`${BACKUP_LABEL}.schedule`]);
                    if (schedule) {
                        await deps.finalizeScheduled({ schedule, backupId, backupName: row.name, startTime }, code, stdout, stderr);
                        await proc.release();
                        return;
                    }
                }
                await deps.finalizeRoute({
                    backupId, orgId: row.org_id,
                    operator: labels[`${BACKUP_LABEL}.operator`] || null,
                    operatorId: labels[`${BACKUP_LABEL}.operator_id`] || null,
                    startTime,
                }, code, stdout, stderr);
                await proc.release();
            } catch (err) { log.error(`[Backup] adoption: finalising ${backupId} failed, container kept for the next boot: ${err.message}`); }
        });
        proc.on('error', (err) => { monitored.delete(c.name); log.error(`[Backup] adoption monitor for ${c.name} failed: ${err.message}`); });
        log.log(`[Backup] adopted ${c.running ? 'running' : 'exited'} container ${c.name} for backup ${backupId} (origin ${origin})`);
        attachMonitor(proc, container, deps);
        adopted.push(c.name);
    }
    return { adopted, removed };
}

export async function reapOrphans(deps = {}) {
    if (!detachedBackupsEnabled(deps).enabled) return [];
    try { return await reapOrphanBackupContainers({}, deps); }
    catch (err) { (deps.log || console).error(`[Backup] orphan reaper failed: ${err.message}`); return []; }
}

let reaperTimer = null;
/** Adopt now, then reap hourly. Called once from server.js. */
export async function startBackupAdoption(deps) {
    await adoptDetachedBackups(deps);
    await reapOrphans(deps);
    reaperTimer = setInterval(() => { reapOrphans(deps); }, 60 * 60 * 1000);
    if (reaperTimer.unref) reaperTimer.unref();
}
export function stopBackupAdoption() { if (reaperTimer) clearInterval(reaperTimer); reaperTimer = null; }
export { containerNameFor };
