/**
 * GrafanaView - Grafana Dashboard Plugin
 *
 * Standalone view for browsing, embedding, and managing Grafana dashboards.
 * GrafanaEmbed has its own built-in setup wizard, so this View just wraps it
 * with a license gate. Also available as a tab within NOC when both are active.
 */

import { PageLayout } from '../../components/layout'
import { GrafanaEmbed } from '../../components/core/monitoring/GrafanaEmbed'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import './views.css'

export default function GrafanaView() {
  const diag = usePluginLicenseDiagnosis('grafana')

  if (!diag.licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Grafana" accentColor="#f46800" />
  }

  return (
    <PageLayout>
      <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <GrafanaEmbed />
      </div>
    </PageLayout>
  )
}
