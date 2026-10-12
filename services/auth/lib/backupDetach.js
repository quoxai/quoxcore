/**
 * BACKUP #727: glue between the two backup entry points (routes/backups.js and
 * services/backupScheduler.js) and lib/backupContainer.js. Kept separate so the
 * container module stays free of database imports and fully injectable.
 */
import { prepare } from '../db/index.js';
import { getInstanceSetting } from './configResolver.js';
import { detachedBackupsEnabled, launchDetachedBackup, isBackupContainerRunning } from './backupContainer.js';

export { isBackupContainerRunning };

/**
 * Launch the backup as a detached container and record its id on the backup
 * row. Returns a ChildProcess-shaped emitter, or null when the caller must fall
 * back to spawning a child (docker unavailable, disabled, or the start failed).
 * The fallback is never silent.
 */
export async function tryLaunchDetachedBackup(opts, deps = {}) {
    const log = deps.log || console;
    let override;
    try {
        const resolved = await (deps.getInstanceSetting || getInstanceSetting)('BACKUP_DETACHED', deps);
        if (resolved && resolved.source === 'setting' && resolved.value !== undefined) override = resolved.value;
    } catch (err) {
        log.error(`[Backup] BACKUP_DETACHED setting resolver failed, using env (${err.message})`);
    }
    const gate = detachedBackupsEnabled(deps, override);
    if (!gate.enabled) {
        log.warn(`[Backup] ${opts.backupId}: running as a CHILD of auth, NOT detached (${gate.reason}). An auth restart will kill this run.`);
        return null;
    }
    try {
        const { proc, container } = await launchDetachedBackup(opts, deps);
        prepare(`UPDATE backups SET container_id = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(container.containerId, opts.backupId);
        log.log(`[Backup] ${opts.backupId}: running detached in container ${container.name} (${container.containerId.slice(0, 12)}); survives auth restarts`);
        return proc;
    } catch (err) {
        log.error(`[Backup] ${opts.backupId}: could not start detached container (${err.message}); falling back to a CHILD of auth. An auth restart will kill this run.`);
        return null;
    }
}
