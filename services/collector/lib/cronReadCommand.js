'use strict';
/**
 * One complete, read-only read of every cron source on a host (fleet/t1-system_cron, 2026-10-17): user crontabs,
 * /etc/crontab, the CONTENTS of every /etc/cron.d file (it used to list them by name only), and systemd timers.
 * When the read was partial, the specialist shelled out with ssh_exec to finish it, which is held for approval, so a
 * read-only "which cron jobs are scheduled" turn ended held. Shared by the native system_admin executor and the
 * Bastion entity tool so the two cannot drift.
 */
const CRON_ALL_CMD = [
  'for user in $(cut -f1 -d: /etc/passwd); do crontab -u $user -l 2>/dev/null && echo "--- $user ---"; done',
  'echo "=== /etc/crontab ==="; cat /etc/crontab 2>/dev/null',
  'for f in /etc/cron.d/*; do [ -f "$f" ] && echo "=== $f ===" && cat "$f"; done 2>/dev/null',
  'echo "=== systemd timers ==="; systemctl list-timers --all --no-pager 2>/dev/null',
].join('; ');

module.exports = { CRON_ALL_CMD };
