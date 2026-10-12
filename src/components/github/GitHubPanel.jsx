/**
 * GitHubPanel - GitHub Operations Plugin Panel
 *
 * Three-state panel:
 * 1. UNCONFIGURED — Setup wizard (add credentials, discover orgs, link, choose repos)
 * 2. CONNECTED — Full issues board with filters, detail view, actions
 * 3. ERROR — Connection error state
 *
 * R2: Org-aware. Reads currentOrg from WorkspaceContext, stores config per-org,
 * and supports vault-backed credentials via the Integrations Vault.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  getConnectionStatus, testConnection, saveConfig, getConfig,
  fetchOrgs, fetchRepos, fetchIssues, fetchIssue, fetchIssueComments,
  updateIssue, addComment, getRateLimitInfo,
  fetchReleases, createRelease, generateReleaseNotes, fetchPRs,
  getPolicies, savePolicies,
  isTokenExpired, clearTokenExpired,
  setOrgContext,
} from '../../services/githubClient';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';

const ACCENT = '#8b5cf6';
const BG_CARD = 'rgba(255,255,255,0.02)';
const REQUIRED_SCOPES = ['repo', 'read:org', 'workflow'];
const REPO_COLOURS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

function repoColour(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return REPO_COLOURS[Math.abs(h) % REPO_COLOURS.length];
}

function relativeTime(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/* ---------- Markdown style components for ReactMarkdown ---------- */
const mdComponents = {
  h1: ({ children }) => <h1 style={{ fontSize: 20, fontWeight: 700, color: 'rgba(255,255,255,0.95)', margin: '16px 0 8px' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: 17, fontWeight: 600, color: 'rgba(255,255,255,0.9)', margin: '14px 0 6px' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: 15, fontWeight: 600, color: 'rgba(255,255,255,0.85)', margin: '12px 0 4px' }}>{children}</h3>,
  h4: ({ children }) => <h4 style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.8)', margin: '10px 0 4px' }}>{children}</h4>,
  p: ({ children }) => <p style={{ margin: '6px 0', lineHeight: 1.6 }}>{children}</p>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#8b5cf6', textDecoration: 'underline' }}>{children}</a>,
  code: ({ inline, children }) => inline
    ? <code style={{ padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.08)', fontFamily: 'monospace', fontSize: 12 }}>{children}</code>
    : <code style={{ fontFamily: 'monospace', fontSize: 12 }}>{children}</code>,
  pre: ({ children }) => <pre style={{ padding: 12, borderRadius: 6, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.06)', overflowX: 'auto', margin: '8px 0', fontSize: 12, lineHeight: 1.5 }}>{children}</pre>,
  ul: ({ children }) => <ul style={{ paddingLeft: 24, margin: '6px 0' }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ paddingLeft: 24, margin: '6px 0' }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 2, lineHeight: 1.5 }}>{children}</li>,
  blockquote: ({ children }) => <blockquote style={{ margin: '8px 0', paddingLeft: 12, borderLeft: '3px solid rgba(139,92,246,0.4)', color: 'rgba(255,255,255,0.6)' }}>{children}</blockquote>,
  img: ({ src, alt }) => <img src={src} alt={alt || ''} style={{ maxWidth: '100%', borderRadius: 6, margin: '8px 0' }} />,
  table: ({ children }) => <table style={{ width: '100%', borderCollapse: 'collapse', margin: '8px 0', fontSize: 12 }}>{children}</table>,
  th: ({ children }) => <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>{children}</th>,
  td: ({ children }) => <td style={{ padding: '4px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.7)' }}>{children}</td>,
  hr: () => <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)', margin: '12px 0' }} />,
  input: ({ type, checked, ...rest }) => type === 'checkbox'
    ? <input type="checkbox" checked={checked} readOnly style={{ accentColor: '#8b5cf6', marginRight: 6 }} />
    : <input type={type} {...rest} />,
};

/* ---------- PR state colours ---------- */
function prStateColour(pr) {
  if (pr.merged_at || pr.merge_commit_sha && pr.state === 'closed') return '#a855f7'; // merged = purple
  if (pr.state === 'closed') return '#ef4444'; // closed = red
  return '#10b981'; // open = green
}
function prStateLabel(pr) {
  if (pr.merged_at || (pr.merge_commit_sha && pr.state === 'closed')) return 'merged';
  return pr.state;
}

/* ---------- StepHeader ---------- */
function StepHeader({ number, title, active, done }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
      borderRadius: 8, background: active ? 'rgba(139, 92, 246, 0.08)' : 'transparent',
      opacity: !active && !done ? 0.4 : 1,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 600,
        background: done ? ACCENT : active ? 'rgba(139, 92, 246, 0.2)' : 'rgba(255,255,255,0.06)',
        color: done || active ? '#fff' : 'rgba(255,255,255,0.4)',
      }}>
        {done ? '\u2713' : number}
      </div>
      <span style={{ fontSize: 14, fontWeight: 500, color: active || done ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)' }}>
        {title}
      </span>
    </div>
  );
}

/* ---------- SetupWizard ---------- */
function SetupWizard({ onConnected, orgId, authFetch }) {
  const [token, setToken] = useState('');
  const [step, setStep] = useState(1);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [orgs, setOrgs] = useState([]);
  const [selectedOrg, setSelectedOrg] = useState(null); // { login, id, avatar_url }
  const [repos, setRepos] = useState([]);
  const [selectedRepos, setSelectedRepos] = useState([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleTestToken() {
    if (!token.trim()) return;
    setTesting(true);
    setError('');
    try {
      const result = await testConnection(token.trim());
      if (result.success) {
        setOrgs(result.orgs || []);
        setStep(3);
      } else {
        setError('Token validation failed. Check scopes and try again.');
      }
    } catch (err) {
      setError('Connection failed: ' + err.message);
    } finally {
      setTesting(false);
    }
  }

  async function handleSelectOrg(org) {
    setSelectedOrg(org);
    setLoadingRepos(true);
    setStep(4);
    try {
      const repoList = await fetchRepos(token.trim(), org.login);
      setRepos(repoList);
      setSelectedRepos(repoList.map(r => r.name));
    } catch (err) {
      setError('Failed to fetch repos: ' + err.message);
    } finally {
      setLoadingRepos(false);
    }
  }

  function toggleRepo(name) {
    setSelectedRepos(prev => prev.includes(name) ? prev.filter(r => r !== name) : [...prev, name]);
  }

  function toggleAll() {
    setSelectedRepos(prev => prev.length === repos.length ? [] : repos.map(r => r.name));
  }

  async function handleConnect() {
    setSaving(true);
    setError('');

    try {
      let credentialId = null;

      // R2: If we have an orgId, store the token in the vault and create an org mapping
      if (orgId && authFetch && selectedOrg) {
        // Step A: Store token in Integrations Vault
        try {
          const vaultResp = await authFetch(`/api/orgs/${orgId}/integrations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              integration_type: 'github',
              label: `GitHub (${selectedOrg.login})`,
              credentials: { token: token.trim() },
              auth_type: 'api_key',
              is_default: true,
              description: `GitHub PAT for ${selectedOrg.login} org`,
            }),
          });

          if (vaultResp.ok) {
            const cred = await vaultResp.json();
            credentialId = cred.id;
          } else {
            // Vault save failed but not fatal — token is still stored server-side by testConnection
            console.warn('[SetupWizard] Vault credential save failed:', vaultResp.status);
          }
        } catch (vaultErr) {
          console.warn('[SetupWizard] Vault save error:', vaultErr.message);
        }

        // Step B: Create org mapping
        try {
          await authFetch(`/api/orgs/${orgId}/github/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              github_org_login: selectedOrg.login,
              github_org_id: selectedOrg.id,
              credential_id: credentialId,
              tracked_repos: selectedRepos,
            }),
          });
        } catch (mapErr) {
          console.warn('[SetupWizard] Org mapping save error:', mapErr.message);
        }
      }

      // Save preferences to localStorage (org-scoped key via getStorageKey())
      saveConfig({
        orgName: selectedOrg?.login || selectedOrg,
        selectedRepos,
        connectedAt: new Date().toISOString(),
        credentialId, // Track which vault credential is used
      });
      onConnected();
    } catch (err) {
      setError('Failed to save configuration: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      {/* GitHub logo */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 72, height: 72, borderRadius: 16,
          background: 'rgba(139, 92, 246, 0.06)', border: '1px solid rgba(139, 92, 246, 0.12)',
          boxShadow: '0 0 40px rgba(139, 92, 246, 0.1)',
        }}>
          <svg width="36" height="36" viewBox="0 0 24 24" style={{ fill: 'rgba(255,255,255,0.85)' }}>
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 700, margin: '20px 0 8px', color: '#fff', letterSpacing: '-0.02em' }}>
          GitHub Operations
        </h2>
        <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', margin: 0, lineHeight: 1.5, maxWidth: 400, marginLeft: 'auto', marginRight: 'auto' }}>
          Connect your GitHub organisation to manage issues, pull requests, releases, and CI from inside QuoxCORE.
        </p>
      </div>

      {/* What you get — shown above the steps */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 24 }}>
        {[
          { icon: '\u25CB', label: 'Cross-repo issues' },
          { icon: '\u2192', label: 'PR & CI status' },
          { icon: '\u2699', label: 'Release management' },
          { icon: '\u2713', label: 'VULCAN AI agent' },
          { icon: '\u26A1', label: 'Feedback pipeline' },
          { icon: '\u2666', label: 'Policy gates' },
        ].map(f => (
          <div key={f.label} style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 14, marginBottom: 4, color: ACCENT }}>{f.icon}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>{f.label}</div>
          </div>
        ))}
      </div>

      {/* Steps */}
      <div style={{ background: BG_CARD, borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)', padding: 20, marginBottom: 16 }}>

        {/* Step 1: Authentication method */}
        <StepHeader number={1} title="Authentication" active={step === 1} done={step > 1} />
        {step === 1 && (
          <div style={{ padding: '12px 16px 16px 54px' }}>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', margin: '0 0 16px', lineHeight: 1.6 }}>
              Generate a Personal Access Token on GitHub. Choose either type:
            </p>

            {/* Classic PAT */}
            <div style={{
              padding: '14px 16px', borderRadius: 8, marginBottom: 10,
              background: 'rgba(139, 92, 246, 0.04)', border: '1px solid rgba(139, 92, 246, 0.1)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)', marginBottom: 6 }}>
                Classic token
                <span style={{ fontSize: 10, fontWeight: 500, color: ACCENT, marginLeft: 8, padding: '2px 6px', borderRadius: 4, background: 'rgba(139,92,246,0.12)' }}>Recommended</span>
              </div>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', margin: '0 0 8px', lineHeight: 1.5 }}>
                Settings → Developer Settings → Personal access tokens → Tokens (classic). Select these scopes:
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {REQUIRED_SCOPES.map(s => (
                  <span key={s} style={{
                    padding: '3px 10px', borderRadius: 6, fontSize: 12, fontFamily: "'SF Mono', 'JetBrains Mono', monospace",
                    background: 'rgba(139, 92, 246, 0.1)', color: 'rgba(255,255,255,0.7)', border: '1px solid rgba(139,92,246,0.15)',
                  }}>{s}</span>
                ))}
              </div>
              <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 12, color: ACCENT, textDecoration: 'none' }}>
                Create classic token {'\u2192'}
              </a>
            </div>

            {/* Fine-grained PAT */}
            <div style={{
              padding: '14px 16px', borderRadius: 8, marginBottom: 16,
              background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 6 }}>
                Fine-grained token
              </div>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', margin: '0 0 8px', lineHeight: 1.5 }}>
                Settings → Developer Settings → Personal access tokens → Fine-grained tokens. Set repository access to your org, then enable these permissions:
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {['Issues: Read & write', 'Pull requests: Read', 'Actions: Read', 'Contents: Read', 'Metadata: Read'].map(s => (
                  <span key={s} style={{
                    padding: '3px 10px', borderRadius: 6, fontSize: 11, fontFamily: "'SF Mono', 'JetBrains Mono', monospace",
                    background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.06)',
                  }}>{s}</span>
                ))}
              </div>
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', textDecoration: 'none' }}>
                Create fine-grained token {'\u2192'}
              </a>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setStep(2)} style={{
                padding: '10px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600,
                border: 'none', cursor: 'pointer', background: ACCENT, color: '#fff',
              }}>
                I have a token
              </button>
            </div>

            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', margin: '12px 0 0', lineHeight: 1.5 }}>
              Your token is stored server-side only. It never reaches the browser after setup. For encrypted storage, configure the Integrations Vault in Settings.
            </p>
          </div>
        )}

        {/* Step 2: Paste token */}
        <StepHeader number={2} title="Paste your token" active={step === 2} done={step > 2} />
        {step === 2 && (
          <div style={{ padding: '8px 16px 16px 54px' }}>
            <input type="password" value={token} onChange={e => setToken(e.target.value)}
              placeholder="Paste your GitHub PAT here"
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 13,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(255,255,255,0.9)', outline: 'none', boxSizing: 'border-box',
              }}
            />
            {error && <p style={{ fontSize: 12, color: '#ef4444', margin: '8px 0 0' }}>{error}</p>}
            <button onClick={handleTestToken} disabled={!token.trim() || testing} style={{
              marginTop: 10, padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500,
              border: 'none', cursor: token.trim() && !testing ? 'pointer' : 'default',
              background: token.trim() ? 'rgba(139, 92, 246, 0.2)' : 'rgba(255,255,255,0.04)',
              color: token.trim() ? ACCENT : 'rgba(255,255,255,0.3)',
            }}>
              {testing ? 'Validating...' : 'Validate Token'}
            </button>
          </div>
        )}

        {/* Step 3 — select org */}
        <StepHeader number={3} title="Link a GitHub organisation" active={step === 3} done={step > 3} />
        {step === 3 && (
          <div style={{ padding: '8px 16px 16px 54px' }}>
            {orgs.length === 0 ? (
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>No organisations found for this token.</p>
            ) : (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {orgs.map(o => (
                  <button key={o.login} onClick={() => handleSelectOrg(o)} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 10,
                    border: '1px solid rgba(255,255,255,0.08)', background: BG_CARD, cursor: 'pointer',
                    transition: 'border-color 0.15s ease',
                  }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = ACCENT}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'}
                  >
                    <img src={o.avatar_url} alt="" width={28} height={28} style={{ borderRadius: '50%' }} />
                    <span style={{ fontSize: 14, fontWeight: 500, color: 'rgba(255,255,255,0.9)' }}>{o.login}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 4 — choose repos */}
        <StepHeader number={4} title="Select repos to track" active={step === 4} done={false} />
        {step === 4 && (
          <div style={{ padding: '8px 16px 16px 54px' }}>
            {loadingRepos ? (
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>Loading repositories...</p>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
                    {selectedRepos.length} of {repos.length} selected
                  </span>
                  <button onClick={toggleAll} style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 12, border: '1px solid rgba(255,255,255,0.1)',
                    background: 'transparent', color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
                  }}>
                    {selectedRepos.length === repos.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {repos.map(r => (
                    <label key={r.name} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6,
                      cursor: 'pointer', transition: 'background 0.15s ease',
                    }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <input type="checkbox" checked={selectedRepos.includes(r.name)}
                        onChange={() => toggleRepo(r.name)}
                        style={{ accentColor: ACCENT }}
                      />
                      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', fontFamily: 'monospace' }}>{r.name}</span>
                      {r.private && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>private</span>}
                    </label>
                  ))}
                </div>
                {error && <p style={{ fontSize: 12, color: '#ef4444', margin: '8px 0 0' }}>{error}</p>}
                <button onClick={handleConnect} disabled={selectedRepos.length === 0 || saving} style={{
                  marginTop: 12, padding: '10px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600,
                  border: 'none', cursor: selectedRepos.length && !saving ? 'pointer' : 'default',
                  background: selectedRepos.length && !saving ? ACCENT : 'rgba(255,255,255,0.06)',
                  color: selectedRepos.length && !saving ? '#fff' : 'rgba(255,255,255,0.3)',
                }}>
                  {saving ? 'Saving...' : 'Connect GitHub'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', textAlign: 'center', margin: '0 0 20px' }}>
        Your token is stored server-side. Configure the Integrations Vault for encrypted storage.
      </p>
    </div>
  );
}

/* ---------- StatusBar ---------- */
function StatusBar({ config, lastSynced, onSync, onSettings, syncing }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      {/* Status dot */}
      <div style={{ position: 'relative', width: 7, height: 7, flexShrink: 0 }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%', background: '#22c55e',
          boxShadow: '0 0 6px rgba(34, 197, 94, 0.5)',
        }} />
      </div>
      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', fontWeight: 500 }}>
        Connected to {config.orgName}
      </span>
      {config.orgName && (
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
          {config.selectedRepos?.length || 0} repos
        </span>
      )}
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace' }}>
        {lastSynced ? `Synced ${relativeTime(lastSynced)}` : ''}
      </span>
      <div style={{ flex: 1 }} />
      <button onClick={onSync} disabled={syncing} title="Sync issues" style={{
        padding: '4px 10px', borderRadius: 6, fontSize: 12, border: '1px solid rgba(255,255,255,0.08)',
        background: 'transparent', color: syncing ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.7)',
        cursor: syncing ? 'default' : 'pointer', transition: 'all 0.15s ease',
      }}>
        {syncing ? '\u21BB Syncing...' : '\u21BB Sync'}
      </button>
      <button onClick={onSettings} title="Settings" style={{
        padding: '4px 8px', borderRadius: 6, fontSize: 14, border: '1px solid rgba(255,255,255,0.08)',
        background: 'transparent', color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
        transition: 'all 0.15s ease',
      }}>
        {'\u2699'}
      </button>
    </div>
  );
}

/* ---------- FilterRow ---------- */
function FilterRow({ repos, filters, onChange }) {
  const states = ['open', 'closed', 'all'];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', flexWrap: 'wrap',
      borderBottom: '1px solid rgba(255,255,255,0.03)',
    }}>
      {/* Repo dropdown */}
      <select value={filters.repo} onChange={e => onChange({ ...filters, repo: e.target.value })} style={{
        padding: '5px 8px', borderRadius: 6, fontSize: 12, background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)', outline: 'none',
      }}>
        <option value="">All repos</option>
        {repos.map(r => <option key={r} value={r}>{r}</option>)}
      </select>

      {/* State pills */}
      <div style={{ display: 'flex', gap: 2, borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' }}>
        {states.map(s => (
          <button key={s} onClick={() => onChange({ ...filters, state: s })} style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 500, border: 'none', cursor: 'pointer',
            background: filters.state === s ? 'rgba(139, 92, 246, 0.2)' : 'transparent',
            color: filters.state === s ? ACCENT : 'rgba(255,255,255,0.5)',
            textTransform: 'capitalize', transition: 'all 0.15s ease',
          }}>
            {s}
          </button>
        ))}
      </div>

      {/* Label filter */}
      <input value={filters.labels} onChange={e => onChange({ ...filters, labels: e.target.value })}
        placeholder="Filter by label..."
        style={{
          padding: '5px 8px', borderRadius: 6, fontSize: 12, width: 130,
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
          color: 'rgba(255,255,255,0.8)', outline: 'none',
        }}
      />

      {/* Search */}
      <input value={filters.search} onChange={e => onChange({ ...filters, search: e.target.value })}
        placeholder="Search issues..."
        style={{
          padding: '5px 8px', borderRadius: 6, fontSize: 12, flex: 1, minWidth: 120,
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
          color: 'rgba(255,255,255,0.8)', outline: 'none',
        }}
      />
    </div>
  );
}

/* ---------- IssueRow ---------- */
function IssueRow({ issue, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.02)', cursor: 'pointer',
        background: hovered ? 'rgba(255,255,255,0.02)' : 'transparent',
        transition: 'background 0.15s ease', minHeight: 44,
      }}
    >
      {/* Repo badge */}
      <span style={{
        padding: '2px 6px', borderRadius: 4, fontSize: 10, fontFamily: 'monospace', fontWeight: 500,
        background: `${repoColour(issue._repo)}20`, color: repoColour(issue._repo),
        whiteSpace: 'nowrap', flexShrink: 0,
      }}>
        {issue._repo}
      </span>

      {/* Issue number */}
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', flexShrink: 0, width: 48, textAlign: 'right' }}>
        #{issue.number}
      </span>

      {/* Title + labels */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.9)' }}>
          {issue.title}
        </span>
        {issue.labels?.length > 0 && (
          <span style={{ marginLeft: 8 }}>
            {issue.labels.slice(0, 4).map(l => (
              <span key={l.id} style={{
                display: 'inline-block', padding: '1px 6px', borderRadius: 10, fontSize: 10,
                marginRight: 4, fontWeight: 500,
                background: `#${l.color}30`, color: `#${l.color}`,
                border: `1px solid #${l.color}40`,
              }}>
                {l.name}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* Author */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {issue.user?.avatar_url && (
          <img src={issue.user.avatar_url} alt="" width={16} height={16} style={{ borderRadius: '50%' }} />
        )}
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{issue.user?.login}</span>
      </div>

      {/* Date */}
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', flexShrink: 0, width: 60, textAlign: 'right' }}>
        {relativeTime(issue.created_at)}
      </span>

      {/* Comments */}
      {issue.comments > 0 && (
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>
          {'\uD83D\uDCAC'} {issue.comments}
        </span>
      )}
    </div>
  );
}

/* ---------- Loading skeleton ---------- */
function LoadingSkeleton() {
  return (
    <div style={{ padding: 16 }}>
      {[...Array(6)].map((_, i) => (
        <div key={i} style={{
          height: 44, marginBottom: 8, borderRadius: 6,
          background: 'rgba(255,255,255,0.02)',
          animation: 'pulse 1.5s ease-in-out infinite',
        }} />
      ))}
      <style>{`@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }`}</style>
    </div>
  );
}

/* ---------- PolicyBlockedModal ---------- */
function PolicyBlockedModal({ policy, message, onClose, onOverride, children }) {
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#18181b', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)',
        padding: 24, maxWidth: 480, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 18, color: '#f59e0b' }}>{'\u26A0'}</span>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: 'rgba(255,255,255,0.95)', margin: 0 }}>Policy Blocked</h3>
        </div>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', margin: '0 0 8px' }}>{message}</p>
        <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)', margin: '0 0 16px' }}>
          Policy: {policy}
        </p>
        {children}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500,
            border: '1px solid rgba(255,255,255,0.1)', background: 'transparent',
            color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
          }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- IssueDetail ---------- */
function IssueDetail({ issue, onBack, onRefresh }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [policyModal, setPolicyModal] = useState(null); // { policy, message }
  const [overrideReason, setOverrideReason] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const config = getConfig();
    fetchIssueComments(config.orgName, issue._repo, issue.number)
      .then(c => { if (!cancelled) setComments(c); })
      .catch(err => console.error('[GitHubPanel] Failed to load comments:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [issue._repo, issue.number]);

  async function handleAddComment() {
    if (!newComment.trim()) return;
    setPosting(true);
    try {
      const config = getConfig();
      await addComment(config.orgName, issue._repo, issue.number, newComment.trim());
      setNewComment('');
      const updated = await fetchIssueComments(config.orgName, issue._repo, issue.number);
      setComments(updated);
    } catch (err) {
      console.error('[GitHubPanel] Failed to post comment:', err);
    } finally {
      setPosting(false);
    }
  }

  async function handleToggleState(overrideReasonParam) {
    const config = getConfig();
    const newState = issue.state === 'open' ? 'closed' : 'open';
    setClosing(true);
    try {
      const payload = { state: newState };
      if (overrideReasonParam) payload.override_reason = overrideReasonParam;
      const result = await updateIssue(config.orgName, issue._repo, issue.number, payload);
      // R4: Handle policy_blocked response
      if (result.status === 'policy_blocked') {
        setClosing(false);
        setPolicyModal({ policy: result.policy, message: result.message });
        return;
      }
      issue.state = newState;
      setPolicyModal(null);
      setOverrideReason('');
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('[GitHubPanel] Failed to update issue:', err);
    } finally {
      setClosing(false);
    }
  }

  async function handleOverrideClose() {
    if (!overrideReason.trim()) return;
    setPolicyModal(null);
    await handleToggleState(overrideReason.trim());
    setOverrideReason('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* R4: Policy blocked modal for issue close */}
      {policyModal && policyModal.policy === 'requireLinkedPRForClosure' && (
        <PolicyBlockedModal
          policy={policyModal.policy}
          message={policyModal.message}
          onClose={() => { setPolicyModal(null); setOverrideReason(''); }}
        >
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', margin: '0 0 8px' }}>
            Enter a reason to override this policy and close the issue anyway:
          </p>
          <textarea
            value={overrideReason}
            onChange={e => setOverrideReason(e.target.value)}
            placeholder="Override reason..."
            rows={3}
            style={{
              width: '100%', padding: 10, borderRadius: 8, fontSize: 13, resize: 'vertical',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.9)', outline: 'none', boxSizing: 'border-box',
              fontFamily: 'inherit',
            }}
          />
          <button onClick={handleOverrideClose} disabled={!overrideReason.trim()} style={{
            marginTop: 8, padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500,
            border: 'none', cursor: overrideReason.trim() ? 'pointer' : 'default',
            background: overrideReason.trim() ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255,255,255,0.04)',
            color: overrideReason.trim() ? '#ef4444' : 'rgba(255,255,255,0.3)',
          }}>
            {'\u2716'} Close with override
          </button>
        </PolicyBlockedModal>
      )}

      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onBack} style={{
          padding: '4px 10px', borderRadius: 6, fontSize: 13, border: '1px solid rgba(255,255,255,0.08)',
          background: 'transparent', color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
        }}>
          {'\u2190'} Back
        </button>
        <span style={{
          padding: '2px 6px', borderRadius: 4, fontSize: 10, fontFamily: 'monospace', fontWeight: 500,
          background: `${repoColour(issue._repo)}20`, color: repoColour(issue._repo),
        }}>
          {issue._repo}
        </span>
        <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>#{issue.number}</span>
        <div style={{ flex: 1 }} />
        <span style={{
          padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 500,
          background: issue.state === 'open' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(139, 92, 246, 0.15)',
          color: issue.state === 'open' ? 'rgba(34, 197, 94, 0.9)' : 'rgba(139, 92, 246, 0.9)',
        }}>
          {issue.state}
        </span>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: 'rgba(255,255,255,0.95)', margin: '0 0 8px' }}>
          {issue.title}
        </h2>

        {/* Meta */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {issue.user?.avatar_url && (
            <img src={issue.user.avatar_url} alt="" width={18} height={18} style={{ borderRadius: '50%' }} />
          )}
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{issue.user?.login}</span>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>opened {relativeTime(issue.created_at)}</span>
          {issue.assignees?.length > 0 && (
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
              {'\u2192'} {issue.assignees.map(a => a.login).join(', ')}
            </span>
          )}
        </div>

        {/* Labels */}
        {issue.labels?.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 16 }}>
            {issue.labels.map(l => (
              <span key={l.id} style={{
                padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 500,
                background: `#${l.color}30`, color: `#${l.color}`, border: `1px solid #${l.color}40`,
              }}>
                {l.name}
              </span>
            ))}
          </div>
        )}

        {/* Issue body */}
        <div style={{
          padding: 16, borderRadius: 8, background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.04)', marginBottom: 20,
          fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.6,
          wordBreak: 'break-word',
        }}>
          {issue.body
            ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{issue.body}</ReactMarkdown>
            : 'No description provided.'}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <button onClick={() => handleToggleState()} disabled={closing} style={{
            padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer',
            background: issue.state === 'open' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)',
            color: issue.state === 'open' ? '#ef4444' : '#22c55e',
            transition: 'all 0.15s ease',
          }}>
            {closing ? '...' : issue.state === 'open' ? '\u2716 Close issue' : '\u21BA Reopen issue'}
          </button>
        </div>

        {/* Comments */}
        <h3 style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.7)', margin: '0 0 12px' }}>
          Comments ({loading ? '...' : comments.length})
        </h3>

        {loading ? (
          <LoadingSkeleton />
        ) : comments.length === 0 ? (
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>No comments yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {comments.map(c => (
              <div key={c.id} style={{
                padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.04)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  {c.user?.avatar_url && (
                    <img src={c.user.avatar_url} alt="" width={16} height={16} style={{ borderRadius: '50%' }} />
                  )}
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.7)' }}>{c.user?.login}</span>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{relativeTime(c.created_at)}</span>
                </div>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{c.body || ''}</ReactMarkdown>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add comment */}
        <div style={{ marginTop: 16 }}>
          <textarea value={newComment} onChange={e => setNewComment(e.target.value)}
            placeholder="Add a comment..."
            rows={3}
            style={{
              width: '100%', padding: 10, borderRadius: 8, fontSize: 13, resize: 'vertical',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.9)', outline: 'none', boxSizing: 'border-box',
              fontFamily: 'inherit',
            }}
          />
          <button onClick={handleAddComment} disabled={!newComment.trim() || posting} style={{
            marginTop: 6, padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500,
            border: 'none', cursor: newComment.trim() && !posting ? 'pointer' : 'default',
            background: newComment.trim() ? 'rgba(139, 92, 246, 0.2)' : 'rgba(255,255,255,0.04)',
            color: newComment.trim() ? ACCENT : 'rgba(255,255,255,0.3)',
            transition: 'all 0.15s ease',
          }}>
            {posting ? 'Posting...' : '\u21B3 Comment'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- GitHubDashboard ---------- */
function GitHubDashboard({ onDisconnect }) {
  const config = getConfig();
  const [tab, setTab] = useState('issues');
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState(null);
  const [error, setError] = useState('');
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [filters, setFilters] = useState({ repo: '', state: 'open', labels: '', search: '' });
  const [page, setPage] = useState(1);
  const perPage = 30;

  // Releases state
  const [releases, setReleases] = useState([]);
  const [relLoading, setRelLoading] = useState(false);
  const [showCreateRelease, setShowCreateRelease] = useState(false);
  const [relForm, setRelForm] = useState({ repo: '', tag_name: '', name: '', body: '', draft: false, prerelease: false });
  const [relGenerating, setRelGenerating] = useState(false);
  const [relCreating, setRelCreating] = useState(false);
  const [checklist, setChecklist] = useState([false, false, false, false, false]);
  const checklistItems = ['All tests pass', 'No open blockers in this milestone', 'Changelog reviewed', 'Version bumped in package.json', 'Security scan clear'];

  // PRs state
  const [prs, setPrs] = useState([]);
  const [prLoading, setPrLoading] = useState(false);
  const [prFilter, setPrFilter] = useState('open'); // open | closed | all

  // Recent closed issues state (for "Recent Changes" in releases tab)
  const [recentClosed, setRecentClosed] = useState([]);
  const [recentClosedLoading, setRecentClosedLoading] = useState(false);

  const loadReleases = useCallback(async () => {
    setRelLoading(true);
    try {
      const fetches = (config.selectedRepos || []).map(async (repo) => {
        try {
          const rels = await fetchReleases(config.orgName, repo);
          return rels.map(r => ({ ...r, _repo: repo }));
        } catch { return []; }
      });
      const all = (await Promise.all(fetches)).flat();
      all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      setReleases(all);
    } catch (err) { console.error('[GitHubPanel] Failed to load releases:', err); }
    finally { setRelLoading(false); }
  }, [config.orgName, config.selectedRepos]);

  const loadPRs = useCallback(async () => {
    setPrLoading(true);
    try {
      const fetches = (config.selectedRepos || []).map(async (repo) => {
        try {
          const list = await fetchPRs(config.orgName, repo, prFilter);
          return list.map(pr => ({ ...pr, _repo: repo }));
        } catch { return []; }
      });
      const all = (await Promise.all(fetches)).flat();
      all.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      setPrs(all);
    } catch (err) { console.error('[GitHubPanel] Failed to load PRs:', err); }
    finally { setPrLoading(false); }
  }, [config.orgName, config.selectedRepos, prFilter]);

  async function handleGenerateNotes() {
    if (!relForm.repo || !relForm.tag_name) return;
    setRelGenerating(true);
    try {
      const notes = await generateReleaseNotes(config.orgName, relForm.repo, { tag_name: relForm.tag_name });
      setRelForm(f => ({ ...f, body: notes.body || '', name: notes.name || f.name }));
    } catch (err) { console.error('[GitHubPanel] Generate notes failed:', err); }
    finally { setRelGenerating(false); }
  }

  // R4: Release policy modal state
  const [relPolicyModal, setRelPolicyModal] = useState(null);

  async function handleCreateRelease() {
    const policies = getPolicies();
    if (!relForm.repo || !relForm.tag_name) return;
    if (!window.confirm(`Create release ${relForm.tag_name} on ${relForm.repo}?`)) return;
    setRelCreating(true);
    try {
      // Review approval warning (informational only)
      if (policies.requireReviewApproval) {
        try {
          const closedPRs = await fetchPRs(config.orgName, relForm.repo, 'closed');
          const unreviewed = closedPRs.filter(pr => pr.merged_at && (!pr.requested_reviewers || pr.requested_reviewers.length === 0));
          if (unreviewed.length > 0) {
            window.alert(`Warning: ${unreviewed.length} merged PR(s) may lack approving reviews.`);
          }
        } catch (e) { console.warn('[GitHubPanel] Review check failed:', e); }
      }
      const result = await createRelease(config.orgName, relForm.repo, {
        ...relForm,
        checklist_confirmed: checklist.every(Boolean),
      });
      // R4: Handle policy_blocked response from server
      if (result.status === 'policy_blocked') {
        setRelCreating(false);
        setRelPolicyModal({ policy: result.policy, message: result.message });
        return;
      }
      setShowCreateRelease(false);
      setRelForm({ repo: '', tag_name: '', name: '', body: '', draft: false, prerelease: false });
      setChecklist([false, false, false, false, false]);
      setRelPolicyModal(null);
      loadReleases();
    } catch (err) { console.error('[GitHubPanel] Create release failed:', err); }
    finally { setRelCreating(false); }
  }

  const loadIssues = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    else setSyncing(true);
    setError('');
    try {
      const opts = { state: filters.state, page, per_page: perPage };
      if (filters.labels) opts.labels = filters.labels;
      const data = await fetchIssues(opts);
      setIssues(data);
      setLastSynced(new Date().toISOString());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, [filters.state, filters.labels, page]);

  useEffect(() => { loadIssues(); }, [loadIssues]);
  useEffect(() => { if (tab === 'releases' && releases.length === 0) loadReleases(); }, [tab]);
  useEffect(() => { if (tab === 'prs') loadPRs(); }, [tab, loadPRs]);

  // Load recently closed issues when releases tab is opened
  const loadRecentClosed = useCallback(async () => {
    setRecentClosedLoading(true);
    try {
      const data = await fetchIssues({ state: 'closed', per_page: 5 });
      setRecentClosed(data.slice(0, 5));
    } catch (err) {
      console.error('[GitHubPanel] Failed to load recent closed issues:', err);
    } finally {
      setRecentClosedLoading(false);
    }
  }, []);
  useEffect(() => { if (tab === 'releases' && recentClosed.length === 0) loadRecentClosed(); }, [tab]);

  // Client-side filters for repo and search
  const filtered = issues.filter(i => {
    if (filters.repo && i._repo !== filters.repo) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!i.title.toLowerCase().includes(q) && !(i.body || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const totalFiltered = filtered.length;
  const pageStart = 0;
  const displayed = filtered.slice(pageStart, pageStart + perPage);

  if (selectedIssue) {
    return (
      <IssueDetail
        issue={selectedIssue}
        onBack={() => setSelectedIssue(null)}
        onRefresh={() => loadIssues(false)}
      />
    );
  }

  const tabs = [
    { id: 'issues', label: 'Issues' },
    { id: 'feedback', label: 'Feedback' },
    { id: 'prs', label: 'Pull Requests' },
    { id: 'releases', label: 'Releases' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <StatusBar
        config={config}
        lastSynced={lastSynced}
        syncing={syncing}
        onSync={() => loadIssues(false)}
        onSettings={onDisconnect}
      />

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '10px 20px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
            background: 'transparent',
            color: tab === t.id ? ACCENT : 'rgba(255,255,255,0.5)',
            borderBottom: tab === t.id ? `2px solid ${ACCENT}` : '2px solid transparent',
            transition: 'all 0.15s ease',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'issues' && (
        <>
          <FilterRow repos={config.selectedRepos || []} filters={filters} onChange={f => { setFilters(f); setPage(1); }} />

          {error && (
            <div style={{ padding: '10px 16px', background: 'rgba(239, 68, 68, 0.08)', borderBottom: '1px solid rgba(239, 68, 68, 0.1)' }}>
              <span style={{ fontSize: 12, color: '#ef4444' }}>{error}</span>
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {loading ? (
              <LoadingSkeleton />
            ) : displayed.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>
                  No {filters.state !== 'all' ? filters.state : ''} issues across your tracked repositories.
                </p>
              </div>
            ) : (
              displayed.map(issue => (
                <IssueRow key={`${issue._repo}-${issue.number}`} issue={issue} onClick={() => setSelectedIssue(issue)} />
              ))
            )}
          </div>

          {/* Pagination */}
          {totalFiltered > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 16px', borderTop: '1px solid rgba(255,255,255,0.04)',
            }}>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>
                Showing {Math.min(displayed.length, totalFiltered)} of {totalFiltered}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={{
                  padding: '3px 10px', borderRadius: 4, fontSize: 12, border: '1px solid rgba(255,255,255,0.08)',
                  background: 'transparent', color: page > 1 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)',
                  cursor: page > 1 ? 'pointer' : 'default',
                }}>
                  {'\u2190'} Prev
                </button>
                <button onClick={() => setPage(p => p + 1)} disabled={displayed.length < perPage} style={{
                  padding: '3px 10px', borderRadius: 4, fontSize: 12, border: '1px solid rgba(255,255,255,0.08)',
                  background: 'transparent',
                  color: displayed.length >= perPage ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)',
                  cursor: displayed.length >= perPage ? 'pointer' : 'default',
                }}>
                  Next {'\u2192'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'feedback' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.3)' }}>Loading...</div>
          ) : (() => {
            const feedbackIssues = issues.filter(i =>
              i.labels?.some(l => ['feedback', 'lead', 'triage-needed'].includes(l.name || l))
            );
            if (feedbackIssues.length === 0) return (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>
                  No feedback submissions yet.
                </p>
                <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)' }}>
                  When visitors use forms on quox.ai, issues will appear here automatically.
                </p>
              </div>
            );
            return feedbackIssues.map(issue => (
              <div key={`${issue._repo}-${issue.number}`} onClick={() => setSelectedIssue(issue)} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer',
                transition: 'background 0.15s ease',
              }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', minWidth: 40 }}>#{issue.number}</span>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', flex: 1 }}>{issue.title}</span>
                {issue.labels?.filter(l => (l.name || l).startsWith('from:')).map(l => {
                  const name = l.name || l;
                  return <span key={name} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(139,92,246,0.12)', color: '#a78bfa' }}>{name}</span>;
                })}
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.25)' }}>{relativeTime(issue.created_at)}</span>
              </div>
            ));
          })()}
        </div>
      )}

      {tab === 'prs' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* PR filter bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            {['open', 'closed', 'all'].map(f => (
              <button key={f} onClick={() => setPrFilter(f)} style={{
                padding: '3px 10px', borderRadius: 4, fontSize: 12, border: '1px solid rgba(255,255,255,0.08)',
                background: prFilter === f ? 'rgba(139,92,246,0.15)' : 'transparent',
                color: prFilter === f ? ACCENT : 'rgba(255,255,255,0.5)', cursor: 'pointer', textTransform: 'capitalize',
              }}>{f}</button>
            ))}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>{prs.length} PRs</span>
            <button onClick={loadPRs} disabled={prLoading} style={{
              padding: '3px 10px', borderRadius: 4, fontSize: 12, border: '1px solid rgba(255,255,255,0.08)',
              background: 'transparent', color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
            }}>{prLoading ? '\u21BB...' : '\u21BB'}</button>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {prLoading && prs.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.3)' }}>Loading pull requests...</div>
            ) : prs.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>No {prFilter !== 'all' ? prFilter : ''} pull requests.</p>
              </div>
            ) : prs.map(pr => (
              <div key={`${pr._repo}-${pr.number}`} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px',
                borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer',
                transition: 'background 0.15s ease',
              }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => pr.url && window.open(pr.url, '_blank')}
              >
                {/* Repo badge */}
                <span style={{
                  padding: '1px 5px', borderRadius: 3, fontSize: 9, fontFamily: 'monospace', fontWeight: 500,
                  background: `${repoColour(pr._repo)}20`, color: repoColour(pr._repo), whiteSpace: 'nowrap', flexShrink: 0,
                }}>{pr._repo}</span>

                {/* PR number */}
                <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)', minWidth: 40, flexShrink: 0 }}>#{pr.number}</span>

                {/* Title */}
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {pr.title}
                </span>

                {/* Author */}
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>
                  {pr.author || ''}
                </span>

                {/* State badge */}
                <span style={{
                  padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 500, flexShrink: 0,
                  background: `${prStateColour(pr)}20`, color: prStateColour(pr),
                }}>{prStateLabel(pr)}</span>

                {/* Review status */}
                {pr.requested_reviewers?.length > 0 && (
                  <span style={{ fontSize: 10, color: '#f59e0b', flexShrink: 0 }} title="Reviews pending">
                    {'\u231B'} {pr.requested_reviewers.length}
                  </span>
                )}

                {/* Relative date */}
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace', flexShrink: 0 }}>
                  {relativeTime(pr.updated_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'releases' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {/* R4: Release policy blocked modal */}
          {relPolicyModal && relPolicyModal.policy === 'requireChecklistBeforeRelease' && (
            <PolicyBlockedModal
              policy={relPolicyModal.policy}
              message={relPolicyModal.message}
              onClose={() => setRelPolicyModal(null)}
            >
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', margin: '0 0 12px' }}>
                Complete all checklist items above, then try again.
              </p>
              <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
                {checklistItems.map((item, i) => (
                  <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}>
                    <input type="checkbox" checked={checklist[i]} onChange={() => setChecklist(c => c.map((v, j) => j === i ? !v : v))}
                      style={{ accentColor: '#22c55e' }} />
                    <span style={{ fontSize: 13, color: checklist[i] ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)' }}>{item}</span>
                  </label>
                ))}
              </div>
              {checklist.every(Boolean) && (
                <button onClick={() => { setRelPolicyModal(null); handleCreateRelease(); }} style={{
                  marginTop: 12, padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                  border: 'none', background: 'rgba(139,92,246,0.2)', color: ACCENT, cursor: 'pointer',
                }}>
                  {'\u2713'} Checklist complete - retry
                </button>
              )}
            </PolicyBlockedModal>
          )}

          {/* Header with Create button */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>{releases.length} releases</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={loadReleases} disabled={relLoading} style={{
                padding: '5px 12px', borderRadius: 6, fontSize: 12, border: '1px solid rgba(255,255,255,0.08)',
                background: 'transparent', color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
              }}>{relLoading ? '\u21BB...' : '\u21BB Refresh'}</button>
              <button onClick={() => setShowCreateRelease(true)} style={{
                padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, border: 'none',
                background: 'rgba(139,92,246,0.2)', color: ACCENT, cursor: 'pointer',
              }}>+ Create Release</button>
            </div>
          </div>

          {/* Create Release Panel */}
          {showCreateRelease && (
            <div style={{ padding: 16, borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.01)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.9)' }}>New Release</span>
                <button onClick={() => setShowCreateRelease(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 16 }}>{'\u2715'}</button>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <select value={relForm.repo} onChange={e => setRelForm(f => ({ ...f, repo: e.target.value }))} style={{
                  padding: '6px 8px', borderRadius: 6, fontSize: 12, background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)', outline: 'none', flex: 1,
                }}>
                  <option value="">Select repo</option>
                  {(config.selectedRepos || []).map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <input value={relForm.tag_name} onChange={e => setRelForm(f => ({ ...f, tag_name: e.target.value }))}
                  placeholder="Tag (e.g. v1.2.0)" style={{
                  padding: '6px 8px', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)', outline: 'none', width: 130,
                }} />
              </div>
              <input value={relForm.name} onChange={e => setRelForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Release title" style={{
                width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12, background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)', outline: 'none', boxSizing: 'border-box', marginBottom: 8,
              }} />
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button onClick={handleGenerateNotes} disabled={!relForm.repo || !relForm.tag_name || relGenerating} style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: 11, border: '1px solid rgba(255,255,255,0.08)',
                  background: 'transparent', color: relForm.repo && relForm.tag_name ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)', cursor: 'pointer',
                }}>{relGenerating ? 'Generating...' : '\u2728 Generate notes'}</button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={relForm.draft} onChange={e => setRelForm(f => ({ ...f, draft: e.target.checked }))} style={{ accentColor: '#f59e0b' }} /> Draft
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={relForm.prerelease} onChange={e => setRelForm(f => ({ ...f, prerelease: e.target.checked }))} style={{ accentColor: '#3b82f6' }} /> Pre-release
                </label>
              </div>
              <textarea value={relForm.body} onChange={e => setRelForm(f => ({ ...f, body: e.target.value }))}
                placeholder="Release notes..." rows={4} style={{
                width: '100%', padding: '8px', borderRadius: 6, fontSize: 12, background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)', outline: 'none',
                boxSizing: 'border-box', fontFamily: 'inherit', resize: 'vertical', marginBottom: 12,
              }} />

              {/* Deploy Checklist */}
              <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', marginBottom: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: 8 }}>Deploy Checklist</span>
                {checklistItems.map((item, i) => (
                  <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}>
                    <input type="checkbox" checked={checklist[i]} onChange={() => setChecklist(c => c.map((v, j) => j === i ? !v : v))}
                      style={{ accentColor: '#22c55e' }} />
                    <span style={{ fontSize: 13, color: checklist[i] ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)' }}>{item}</span>
                  </label>
                ))}
              </div>

              {(() => {
                const pol = getPolicies();
                const clReq = pol.requireChecklistBeforeRelease;
                const ready = relForm.repo && relForm.tag_name && (!clReq || checklist.every(Boolean)) && !relCreating;
                return <button onClick={handleCreateRelease} disabled={!ready} style={{
                  padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none',
                  background: ready ? ACCENT : 'rgba(255,255,255,0.06)',
                  color: ready ? '#fff' : 'rgba(255,255,255,0.3)',
                  cursor: ready ? 'pointer' : 'default',
                }}>{relCreating ? 'Creating...' : '\u{1F680} Create Release'}</button>;
              })()}
            </div>
          )}

          {/* Release List */}
          {relLoading ? <LoadingSkeleton /> : releases.length === 0 && !relLoading ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>No releases found across your tracked repositories.</p>
              <button onClick={loadReleases} style={{
                marginTop: 8, padding: '6px 14px', borderRadius: 6, fontSize: 12, border: '1px solid rgba(255,255,255,0.1)',
                background: 'transparent', color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
              }}>Load releases</button>
            </div>
          ) : releases.map(r => (
            <div key={r.id} style={{
              padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.03)',
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <span style={{
                padding: '2px 6px', borderRadius: 4, fontSize: 10, fontFamily: 'monospace', fontWeight: 500,
                background: `${repoColour(r._repo)}20`, color: repoColour(r._repo), whiteSpace: 'nowrap', flexShrink: 0,
              }}>{r._repo}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: ACCENT }}>{r.tag_name}</span>
                  {r.name && r.name !== r.tag_name && <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)' }}>{r.name}</span>}
                  {r.draft && <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 500, background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>draft</span>}
                  {r.prerelease && <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 500, background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}>pre-release</span>}
                </div>
                {r.body && <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.body.slice(0, 150)}
                </p>}
              </div>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', flexShrink: 0 }}>{relativeTime(r.created_at)}</span>
            </div>
          ))}

          {/* Recent Changes — last 5 closed issues */}
          <div style={{ padding: '16px', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 8 }}>
            <h4 style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 10 }}>Recent Changes</h4>
            {recentClosedLoading ? (
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>Loading...</p>
            ) : recentClosed.length === 0 ? (
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>No recently closed issues.</p>
            ) : recentClosed.map(issue => (
              <div key={issue.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                borderBottom: '1px solid rgba(255,255,255,0.02)',
              }}>
                <span style={{
                  padding: '1px 5px', borderRadius: 3, fontSize: 9, fontFamily: 'monospace', fontWeight: 500,
                  background: `${repoColour(issue._repo)}20`, color: repoColour(issue._repo), whiteSpace: 'nowrap', flexShrink: 0,
                }}>{issue._repo}</span>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {issue.title}
                </span>
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace', flexShrink: 0 }}>
                  {issue.closed_at ? relativeTime(issue.closed_at) : relativeTime(issue.updated_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- RepoManager (settings sub-component) ---------- */
function RepoManager({ config, onSave }) {
  const [allRepos, setAllRepos] = useState([]);
  const [selected, setSelected] = useState(new Set(config?.selectedRepos || []));
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleLoad() {
    if (!config?.orgName) return;
    setLoading(true);
    try {
      const repos = await fetchRepos(null, config.orgName);
      const repoNames = (repos || []).map(r => typeof r === 'string' ? r : r.name).sort((a, b) => a.localeCompare(b));
      setAllRepos(repoNames);
      setLoaded(true);
    } catch (err) {
      console.error('[GitHubPanel] Failed to fetch repos:', err);
    } finally {
      setLoading(false);
    }
  }

  function toggleRepo(name) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === allRepos.length) setSelected(new Set());
    else setSelected(new Set(allRepos));
  }

  async function handleSave() {
    setSaving(true);
    const updated = { ...config, selectedRepos: [...selected] };
    saveConfig(updated);
    onSave(updated);
    setSaving(false);
  }

  const changed = (() => {
    const current = new Set(config?.selectedRepos || []);
    if (current.size !== selected.size) return true;
    for (const r of selected) if (!current.has(r)) return true;
    return false;
  })();

  if (!loaded) {
    return (
      <div style={{ background: BG_CARD, borderRadius: 10, border: '1px solid rgba(255,255,255,0.04)', padding: 16, marginBottom: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.9)', margin: '0 0 12px' }}>Manage Repos</p>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', margin: '0 0 12px' }}>
          Currently tracking {config?.selectedRepos?.length || 0} repos.
        </p>
        <button onClick={handleLoad} disabled={loading} style={{
          padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500, border: 'none',
          background: 'rgba(139,92,246,0.15)', color: ACCENT, cursor: 'pointer',
        }}>
          {loading ? 'Loading...' : '\u2699 Load repos from GitHub'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ background: BG_CARD, borderRadius: 10, border: '1px solid rgba(255,255,255,0.04)', padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <p style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.9)', margin: 0 }}>Manage Repos</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
          <input type="checkbox" checked={selected.size === allRepos.length && allRepos.length > 0}
            onChange={toggleAll} style={{ accentColor: ACCENT }} />
          Select all
        </label>
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 10 }}>
        {allRepos.map(name => (
          <label key={name} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer',
          }}>
            <input type="checkbox" checked={selected.has(name)} onChange={() => toggleRepo(name)}
              style={{ accentColor: ACCENT }} />
            <span style={{ fontSize: 13, fontFamily: 'monospace', color: selected.has(name) ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)' }}>
              {name}
            </span>
          </label>
        ))}
      </div>
      {changed && (
        <button onClick={handleSave} disabled={saving || selected.size === 0} style={{
          padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500, border: 'none',
          background: 'rgba(16,185,129,0.2)', color: '#10b981', cursor: 'pointer',
        }}>
          {saving ? 'Saving...' : `\u2713 Save (${selected.size} repos)`}
        </button>
      )}
    </div>
  );
}

/* ---------- Main Panel ---------- */
export default function GitHubPanel() {
  // R2: org-aware config
  const { currentOrg } = useWorkspace();
  const { authFetch } = useAuth();
  const orgId = currentOrg?.id || null;

  // Set org context on mount and org change so githubClient uses org-scoped keys
  useEffect(() => {
    setOrgContext(orgId);
  }, [orgId]);

  const [connected, setConnected] = useState(() => getConnectionStatus().connected);
  const [showSettings, setShowSettings] = useState(false);
  const [tokenExpired, setTokenExpired] = useState(() => isTokenExpired());
  const [, forceUpdate] = useState(0);

  // Re-check connection when org changes
  useEffect(() => {
    setConnected(getConnectionStatus().connected);
  }, [orgId]);

  // Poll token expiry flag (set by githubClient on 401)
  useEffect(() => {
    const interval = setInterval(() => {
      const expired = isTokenExpired();
      if (expired !== tokenExpired) setTokenExpired(expired);
    }, 3000);
    return () => clearInterval(interval);
  }, [tokenExpired]);

  function handleDisconnect() {
    if (window.confirm('Disconnect GitHub and clear configuration?')) {
      const key = orgId ? `quox-github-${orgId}` : 'quox-plugin-github-config';
      localStorage.removeItem(key);
      clearTokenExpired();
      setTokenExpired(false);
      setConnected(false);
      setShowSettings(false);
    }
  }

  function handleReconnect() {
    clearTokenExpired();
    setTokenExpired(false);
    setShowSettings(true);
  }

  if (connected && !showSettings) {
    return (
      <div style={{ background: '#09090b', minHeight: '60vh', display: 'flex', flexDirection: 'column' }}>
        {tokenExpired && (
          <div style={{
            padding: '10px 16px', background: 'rgba(239, 68, 68, 0.08)',
            borderBottom: '1px solid rgba(239, 68, 68, 0.15)', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 13, color: '#ef4444' }}>GitHub token expired. Please reconnect.</span>
            <button onClick={handleReconnect} style={{
              padding: '3px 10px', borderRadius: 4, fontSize: 12, border: '1px solid rgba(239,68,68,0.3)',
              background: 'transparent', color: '#ef4444', cursor: 'pointer',
            }}>
              {'\u2699'} Settings
            </button>
          </div>
        )}
        <GitHubDashboard onDisconnect={() => setShowSettings(true)} />
      </div>
    );
  }

  if (showSettings) {
    const config = getConfig();
    return (
      <div style={{ background: '#09090b', minHeight: '60vh', padding: '40px 16px' }}>
        <div style={{ maxWidth: 400, margin: '0 auto' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: 'rgba(255,255,255,0.95)', marginBottom: 16 }}>GitHub Settings</h2>

          {tokenExpired && (
            <div style={{
              padding: 12, borderRadius: 8, background: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.15)', marginBottom: 16,
            }}>
              <p style={{ fontSize: 13, color: '#ef4444', margin: 0 }}>
                Your GitHub token has expired or been revoked. Disconnect and re-enter a valid token.
              </p>
            </div>
          )}

          <div style={{ background: BG_CARD, borderRadius: 10, border: '1px solid rgba(255,255,255,0.04)', padding: 16, marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', margin: '0 0 6px' }}>Organisation</p>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.9)', margin: '0 0 12px', fontFamily: 'monospace' }}>{config?.orgName || 'None'}</p>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', margin: '0 0 6px' }}>Tracked repos</p>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.9)', margin: '0 0 12px', fontFamily: 'monospace' }}>{config?.selectedRepos?.length || 0}</p>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', margin: '0 0 6px' }}>Connected</p>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', margin: 0, fontFamily: 'monospace' }}>{config?.connectedAt ? relativeTime(config.connectedAt) : 'Unknown'}</p>
          </div>

          {/* Repo Management */}
          <RepoManager config={config} onSave={() => forceUpdate(n => n + 1)} />

          {/* AOCL Policy Gates */}
          <div style={{ background: BG_CARD, borderRadius: 10, border: '1px solid rgba(255,255,255,0.04)', padding: 16, marginBottom: 16 }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.9)', margin: '0 0 12px' }}>AOCL Policy Gates</p>
            {[
              { key: 'requireChecklistBeforeRelease', label: 'Require checklist before release', desc: 'All deploy checklist items must be ticked before creating a release.' },
              { key: 'requireLinkedPRForClosure', label: 'Require linked PR for issue closure', desc: 'Warn when closing an issue that has no linked pull request.' },
              { key: 'requireReviewApproval', label: 'Require review approval for releases', desc: 'Warn if merged PRs lack approving reviews before release.' },
            ].map(p => {
              const policies = getPolicies();
              return (
                <label key={p.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!policies[p.key]} onChange={() => {
                    const updated = { ...policies, [p.key]: !policies[p.key] };
                    savePolicies(updated);
                  }} style={{ accentColor: ACCENT, marginTop: 2 }} />
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.85)', display: 'block' }}>{p.label}</span>
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{p.desc}</span>
                  </div>
                </label>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowSettings(false)} style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
              border: '1px solid rgba(255,255,255,0.1)', background: 'transparent',
              color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
            }}>
              {'\u2190'} Back
            </button>
            <button onClick={handleDisconnect} style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
              border: 'none', background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', cursor: 'pointer',
            }}>
              {'\u2716'} Disconnect
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: '#09090b', minHeight: '60vh', padding: '40px 16px' }}>
      <SetupWizard onConnected={() => setConnected(true)} orgId={orgId} authFetch={authFetch} />
    </div>
  );
}
