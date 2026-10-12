/**
 * WazuhSetupGate
 *
 * Shown when the Wazuh plugin is licensed but not yet configured.
 * Collects the minimum required credentials (host + password) with an
 * optional Advanced section for port, username, and bastion host.
 * On save, calls props.onConfigured() so WazuhView transitions to the SIEM.
 */

import { useState } from 'react';
import { PageLayout } from '../layout';
import { validatePluginConfig } from '../../services/pluginConfigStorage';
import { saveWazuhConfig } from '../../services/wazuhClient';

export default function WazuhSetupGate({ onConfigured, orgId }) {
  const [wazuhHost, setWazuhHost]         = useState('');
  const [wazuhPassword, setWazuhPassword] = useState('');
  const [wazuhApiPort, setWazuhApiPort]   = useState('55000');
  const [wazuhUser, setWazuhUser]         = useState('wazuh-wui');
  const [bastionHost, setBastionHost]     = useState('');
  const [errors, setErrors]               = useState([]);
  const [saving, setSaving]               = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setErrors([]);

    const values = {
      wazuhHost:     wazuhHost.trim(),
      wazuhPassword: wazuhPassword,
      wazuhApiPort:  wazuhApiPort.trim() || '55000',
      wazuhUser:     wazuhUser.trim()    || 'wazuh-wui',
      bastionHost:   bastionHost.trim(),
    };

    // Manual required-field check (schema validation skips undefined, not empty)
    const requiredErrors = [];
    if (!values.wazuhHost)     requiredErrors.push('Wazuh Server IP is required.');
    if (!values.wazuhPassword) requiredErrors.push('API Password is required.');
    if (requiredErrors.length) {
      setErrors(requiredErrors);
      return;
    }

    // Schema validation (type checks, ranges, enums)
    const result = validatePluginConfig('wazuh', values);
    if (!result.valid) {
      setErrors(result.errors);
      return;
    }

    if (!orgId) {
      setErrors(['No organization selected — cannot save Wazuh configuration.']);
      return;
    }

    setSaving(true);
    try {
      // Server-side vault is the source of truth (ZERO TOLERANCE: no
      // browser-only persistence) — this is what collector's getWazuhToken
      // resolves at runtime via resolveCredentialForAgent(orgId, 'argus',
      // 'wazuh'). The password never touches localStorage.
      await saveWazuhConfig(orgId, values);
      onConfigured();
    } catch (err) {
      setErrors([err.message || 'Unexpected error saving configuration.']);
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageLayout>
      <div className="qx-view" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div
          className="qx-card"
          style={{
            padding: 32,
            maxWidth: 480,
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
            marginTop: 40,
          }}
        >
          {/* Shield icon — matches license-gate */}
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#00a9e5" strokeWidth="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>

          <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', letterSpacing: '-0.01em', textAlign: 'center' }}>
            Configure Wazuh
          </div>

          <div style={{ fontSize: 13, color: '#fff', opacity: 0.75, lineHeight: 1.55, textAlign: 'center' }}>
            Tell QuoxCORE where your Wazuh manager lives. Settings can be edited later under
            Settings &rarr; Plugins &rarr; Wazuh &rarr; Configure.
          </div>

          {/* Error banner */}
          {errors.length > 0 && (
            <div className="qx-banner qx-banner--danger" style={{ width: '100%', textAlign: 'left' }}>
              {errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Wazuh Server IP */}
            <div className="qx-field">
              <label>Wazuh Server IP</label>
              <input
                className="qx-input"
                type="text"
                placeholder="198.51.100.175"
                value={wazuhHost}
                onChange={e => setWazuhHost(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {/* API Password */}
            <div className="qx-field">
              <label>API Password</label>
              <input
                className="qx-input"
                type="password"
                placeholder="API password"
                value={wazuhPassword}
                onChange={e => setWazuhPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>

            {/* Advanced (collapsed by default) */}
            <details style={{ width: '100%' }}>
              <summary
                style={{
                  fontSize: 12,
                  color: '#00a9e5',
                  cursor: 'pointer',
                  userSelect: 'none',
                  opacity: 0.85,
                  listStyle: 'none',
                }}
              >
                Advanced options
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
                {/* API Port */}
                <div className="qx-field">
                  <label>API Port</label>
                  <input
                    className="qx-input"
                    type="text"
                    placeholder="55000"
                    value={wazuhApiPort}
                    onChange={e => setWazuhApiPort(e.target.value)}
                  />
                </div>

                {/* API Username */}
                <div className="qx-field">
                  <label>API Username</label>
                  <input
                    className="qx-input"
                    type="text"
                    placeholder="wazuh-wui"
                    value={wazuhUser}
                    onChange={e => setWazuhUser(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                {/* Bastion Host (optional) */}
                <div className="qx-field">
                  <label>Bastion Host <span style={{ opacity: 0.55, fontWeight: 400 }}>(optional)</span></label>
                  <input
                    className="qx-input"
                    type="text"
                    placeholder="198.51.100.247"
                    value={bastionHost}
                    onChange={e => setBastionHost(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>
            </details>

            {/* Submit */}
            <button
              type="submit"
              className="qx-btn qx-btn--primary"
              disabled={saving}
              style={{ marginTop: 4 }}
            >
              {saving ? 'Saving…' : 'Save and continue'}
            </button>
          </form>

          <div style={{ fontSize: 11, color: '#fff', opacity: 0.5, textAlign: 'center', lineHeight: 1.4 }}>
            All credentials stored encrypted. Password is never returned to the browser after save.
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
