/**
 * QuoxAgentInstallPrompt - Prompts user to install QuoxAgent on hosts that don't have it
 *
 * Handles:
 * - Displaying hosts without QuoxAgent
 * - Selecting hosts to install on
 * - Installation progress and results
 * - Error handling for empty/invalid host lists
 */

import React, { useState, useMemo } from 'react';
import './quoxagent.css';

export default function QuoxAgentInstallPrompt({ hosts = [], onInstall, onSkip, onCancel }) {
  // Safely filter valid hosts
  const validHosts = useMemo(() =>
    (hosts || []).filter(h => h && h.hostname),
    [hosts]
  );

  const [installing, setInstalling] = useState(false);
  const [selectedHosts, setSelectedHosts] = useState(validHosts.map(h => h.hostname));
  const [results, setResults] = useState(null);

  const toggleHost = (hostname) => {
    setSelectedHosts(prev =>
      prev.includes(hostname)
        ? prev.filter(h => h !== hostname)
        : [...prev, hostname]
    );
  };

  const handleInstall = async () => {
    if (selectedHosts.length === 0) {
      onSkip();
      return;
    }

    setInstalling(true);
    try {
      const installResults = await onInstall(selectedHosts);
      setResults(installResults);
    } catch (err) {
      setResults({ error: err.message });
    }
    setInstalling(false);
  };

  // Handle empty hosts list
  if (validHosts.length === 0) {
    return (
      <div className="quoxagent-install-prompt">
        <div className="quoxagent-prompt-header">
          <span className="quoxagent-icon">--</span>
          <h3>No Hosts Available</h3>
        </div>
        <p className="quoxagent-description">
          No hosts are available for QuoxAgent installation.
        </p>
        <div className="quoxagent-actions">
          <button className="quoxagent-btn primary" onClick={onCancel || onSkip}>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (results) {
    const hasErrors = results.error || (Array.isArray(results) && results.some?.(r => !r.success));
    return (
      <div className="quoxagent-install-prompt">
        <div className="quoxagent-prompt-header">
          <span className="quoxagent-icon">{hasErrors ? '!' : '*'}</span>
          <h3>QuoxAgent Installation {hasErrors ? 'Completed with Issues' : 'Complete'}</h3>
        </div>
        <div className="quoxagent-results">
          {results.error ? (
            <div className="quoxagent-result error">{results.error}</div>
          ) : Array.isArray(results) ? (
            results.map((r, i) => (
              <div key={i} className={`quoxagent-result ${r?.success ? 'success' : 'error'}`}>
                <span className="hostname">{r?.hostname || 'Unknown'}</span>
                <span className="status">{r?.success ? 'Installed' : `Error: ${r?.error || 'Unknown error'}`}</span>
              </div>
            ))
          ) : (
            <div className="quoxagent-result success">Installation complete</div>
          )}
        </div>
        <div className="quoxagent-actions">
          <button className="quoxagent-btn primary" onClick={onSkip}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="quoxagent-install-prompt">
      <div className="quoxagent-prompt-header">
        <span className="quoxagent-icon">🔧</span>
        <h3>QuoxAgent Not Installed</h3>
      </div>

      <p className="quoxagent-description">
        The following hosts don't have the Quox Helper Agent installed.
        Installing QuoxAgent enables direct command execution, monitoring, and fleet management.
      </p>

      <div className="quoxagent-host-list">
        {validHosts.map(host => (
          <label key={host.hostname} className="quoxagent-host-item">
            <input
              type="checkbox"
              checked={selectedHosts.includes(host.hostname)}
              onChange={() => toggleHost(host.hostname)}
              disabled={installing}
            />
            <span className="hostname">{host.hostname}</span>
            <span className="status">{host.status || 'Unknown'}</span>
          </label>
        ))}
      </div>

      <div className="quoxagent-actions">
        <button
          className="quoxagent-btn secondary"
          onClick={onCancel}
          disabled={installing}
        >
          Cancel
        </button>
        <button
          className="quoxagent-btn secondary"
          onClick={onSkip}
          disabled={installing}
        >
          Skip & Continue
        </button>
        <button
          className="quoxagent-btn primary"
          onClick={handleInstall}
          disabled={installing || selectedHosts.length === 0}
        >
          {installing ? 'Installing...' : `Install QuoxAgent (${selectedHosts.length})`}
        </button>
      </div>

      <p className="quoxagent-note">
        Installation requires SSH access via the bastion host.
      </p>
    </div>
  );
}
