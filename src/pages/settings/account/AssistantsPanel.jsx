/**
 * AssistantsPanel — SET-IA parity restoration.
 *
 * V1 had this at /settings#assistants. SET-IA dropped it silently;
 * restored here as a thin wrapper around the existing component.
 *
 * V1 supported deep-linking to a specific agent's edit tab via
 * location.state.editAgent / editTab. V2 reads the same hints from
 * location.state when SettingsView passes them through. For direct
 * `/settings#account/assistants` navigation both are null and the
 * panel opens at its default state.
 */

import { useLocation } from 'react-router-dom';
import AssistantSettings from '../../../components/settings/AssistantSettings';

export default function AssistantsPanel() {
    const location = useLocation();
    // AssistantSettings handles its own padding; no outer wrapper.
    return (
        <AssistantSettings
            initialEditAgent={location.state?.editAgent || null}
            initialEditTab={location.state?.editTab || null}
        />
    );
}
