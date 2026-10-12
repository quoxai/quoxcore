/**
 * GitHubView - GitHub Operations Plugin
 *
 * Cross-repo issue board, feedback pipeline, release management,
 * and AI-powered GitHub operations.
 */

import { PageLayout } from '../../components/layout';
import GitHubPanel from '../../components/github/GitHubPanel';
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice';
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';
import './views.css';

export default function GitHubView() {
  const diag = usePluginLicenseDiagnosis('github');

  if (!diag.licensed) {
    return <PluginLicenseNotice diag={diag} displayName="GitHub Operations" accentColor="#a78bfa" />;
  }

  return (
    <PageLayout>
      <div style={{ padding: '0 16px 16px' }}>
        <GitHubPanel />
      </div>
    </PageLayout>
  );
}
