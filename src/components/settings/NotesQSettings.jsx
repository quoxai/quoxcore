/**
 * NotesQSettings: org-level NotesQ settings. Renders every settable platform
 * flag tagged group "notesq" (autosave delay, default collection, agent edit
 * policy, revision retention) through the generic PlatformFlagsPanel, so the
 * values are server-side, org-scoped, admin-only and audited.
 */
import { usePluginLicensed } from '../../hooks/usePluginLicensed';
import PlatformFlagsPanel from './PlatformFlagsPanel';
import NotesQSchedules from './NotesQSchedules';

export default function NotesQSettings() {
    const licensed = usePluginLicensed('notesq');
    if (!licensed) {
        return (
            <div data-testid="notesq-settings-locked" style={{ padding: 24, maxWidth: 560 }}>
                <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>NotesQ is not active here</h3>
                <p style={{ color: 'var(--ui-text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
                    These settings apply once NotesQ is licensed for this organisation.
                </p>
                <a href="/settings#plugins">Open plugin licensing</a>
            </div>
        );
    }
    return (
        <div className="qx-stack qx-stack--tight" data-testid="notesq-settings">
            <p className="qx-hint">Settings for every NotesQ user in this organisation. Changes are saved to the server and audited.</p>
            <PlatformFlagsPanel group="notesq" title="NotesQ" />
            <NotesQSchedules />
        </div>
    );
}
