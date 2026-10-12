/**
 * QuoxMindPanel — SET-IA parity restoration.
 *
 * V1 had this at /settings#quoxmind. Phase 1 of SET-IA dropped it
 * silently when the registry was built. Restored here as a thin
 * wrapper around the existing component.
 */

import QuoxMindSettings from '../../../components/settings/QuoxMindSettings';

// QuoxMindSettings provides its own SettingsSection chrome. Wrapping
// it in another padded div produced a ghost container; render direct.
export default function QuoxMindPanel() {
    return <QuoxMindSettings />;
}
