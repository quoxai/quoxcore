/**
 * RunnableCodeBlock
 *
 * Custom ReactMarkdown `pre` component that adds "Run" buttons to shell code blocks.
 * Validates commands client-side against the denylist and respects mode policies.
 */

import { useState, useCallback, useMemo } from 'react';
import { validateForExec } from '../../services/terminalExecService';
import { execInTerminal } from '../../services/terminalExecService';
import { recordCommandExecution } from '../../services/terminalMemoryBridge';
import './RunnableCodeBlock.css';

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'console', 'zsh']);

// Common command prefixes for unlabeled code blocks
const COMMAND_PREFIX_RE = /^(sudo\s+)?(apt|yum|npm|npx|docker|git|curl|wget|ssh|scp|rsync|systemctl|journalctl|cat|ls|cd|mkdir|rm|cp|mv|chmod|chown|grep|find|tar|zip|unzip|df|du|top|htop|ps|kill|ping|dig|make|cargo|python|node|go|pip|brew|dnf|zypper|snap|flatpak|service|mount|umount|fdisk|lsblk|ip|ss|netstat|hostname|whoami|id|uname|date|uptime|free|vmstat|iostat|sar|strace|ltrace|tcpdump|nmap|openssl)\b/;

/**
 * Extract language and code text from ReactMarkdown's pre > code structure.
 */
function extractCodeInfo(children) {
  // ReactMarkdown renders: <pre><code className="language-bash">...</code></pre>
  if (!children) return { language: '', code: '' };

  const codeChild = Array.isArray(children) ? children[0] : children;
  if (!codeChild?.props) return { language: '', code: '' };

  const className = codeChild.props.className || '';
  const langMatch = className.match(/language-(\w+)/);
  const language = langMatch ? langMatch[1].toLowerCase() : '';

  // Extract text content
  const code = typeof codeChild.props.children === 'string'
    ? codeChild.props.children
    : String(codeChild.props.children || '');

  return { language, code: code.trim() };
}

/**
 * Check if unlabeled code looks like a shell command.
 */
function isLikelyShellCommand(code) {
  if (!code) return false;
  const firstLine = code.split('\n')[0].trim();
  // Starts with $ or # prompt
  if (/^\s*[\$#]\s/.test(firstLine)) return true;
  // Matches common command patterns
  if (COMMAND_PREFIX_RE.test(firstLine)) return true;
  return false;
}

/**
 * Strip $ prompts from command text.
 * Only strips `$ ` user prompts — `# ` lines are kept as valid shell comments.
 */
function stripPrompts(code) {
  return code
    .split('\n')
    .map(line => line.replace(/^\s*\$\s*/, ''))
    .join('\n')
    .trim();
}

export default function RunnableCodeBlock({ children, sessionId, mode, authFetch, onExecRequest }) {
  const [execState, setExecState] = useState('idle'); // idle | running | done | error
  const [statusMsg, setStatusMsg] = useState('');

  const { language, code } = useMemo(() => extractCodeInfo(children), [children]);

  const isShell = useMemo(() => {
    if (SHELL_LANGUAGES.has(language)) return true;
    if (language === '') return isLikelyShellCommand(code);
    return false;
  }, [language, code]);

  const command = useMemo(() => isShell ? stripPrompts(code) : '', [isShell, code]);

  const validation = useMemo(() => {
    if (!isShell || !command) return null;
    return validateForExec(command, mode);
  }, [isShell, command, mode]);

  const handleRun = useCallback(async () => {
    if (!validation || !command) return;

    // Commands requiring approval go through the modal
    if (validation.action === 'REQUIRE_APPROVAL' || validation.action === 'REQUIRE_OVERRIDE') {
      onExecRequest?.(command, validation);
      return;
    }

    // WARN: first click shows warning state, second click executes
    if (validation.action === 'WARN' && execState !== 'warn-confirm') {
      setExecState('warn-confirm');
      return;
    }

    // Execute
    setExecState('running');
    setStatusMsg('');
    const result = await execInTerminal(sessionId, command, authFetch);
    if (result.ok) {
      setExecState('done');
      setStatusMsg('Sent to terminal');
      recordCommandExecution(command, null);
      setTimeout(() => { setExecState('idle'); setStatusMsg(''); }, 3000);
    } else {
      setExecState('error');
      setStatusMsg(result.error || 'Failed');
      setTimeout(() => { setExecState('idle'); setStatusMsg(''); }, 5000);
    }
  }, [validation, command, sessionId, execState, authFetch, onExecRequest]);

  const handleCancelWarn = useCallback(() => {
    setExecState('idle');
  }, []);

  // Not a shell block — render plain pre
  if (!isShell) {
    return <pre>{children}</pre>;
  }

  const isAuditMode = mode === 'audit';
  const noSession = !sessionId;
  // In audit mode, the BLOCK comes from mode policy, not denylist — show audit badge instead
  const isBlocked = !isAuditMode && validation?.action === 'BLOCK';

  return (
    <div className="runnable-code-block">
      <pre className="runnable-code-block__code">{children}</pre>

      <div className="runnable-code-block__toolbar">
        {/* Status message (sent/error feedback) */}
        {statusMsg && (
          <span className={`runnable-code-block__status runnable-code-block__status--${execState === 'error' ? 'error' : 'done'}`}>
            {statusMsg}
          </span>
        )}

        {/* Audit mode badge (takes priority over blocked) */}
        {isAuditMode && (
          <span className="runnable-code-block__badge runnable-code-block__badge--audit">
            Audit mode
          </span>
        )}

        {/* Blocked badge (for actually dangerous commands, not audit-mode blocks) */}
        {isBlocked && (
          <span className="runnable-code-block__badge runnable-code-block__badge--blocked">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>
            </svg>
            Blocked
          </span>
        )}

        {/* Warning confirmation bar */}
        {execState === 'warn-confirm' && (
          <div className="runnable-code-block__warn-bar">
            <span>{validation?.description || 'This command may be risky.'}</span>
            <button className="runnable-code-block__btn runnable-code-block__btn--warn-confirm" onClick={handleRun}>
              Confirm
            </button>
            <button className="runnable-code-block__btn runnable-code-block__btn--cancel" onClick={handleCancelWarn}>
              Cancel
            </button>
          </div>
        )}

        {/* Run button */}
        {!isBlocked && !isAuditMode && execState !== 'warn-confirm' && (
          <button
            className={`runnable-code-block__btn runnable-code-block__btn--run ${
              validation?.action === 'WARN' ? 'runnable-code-block__btn--amber' :
              validation?.action === 'REQUIRE_APPROVAL' || validation?.action === 'REQUIRE_OVERRIDE'
                ? 'runnable-code-block__btn--approval' : ''
            }`}
            onClick={handleRun}
            disabled={noSession || execState === 'running'}
            title={noSession ? 'No active terminal session' : `Run in terminal${validation?.severity ? ` (${validation.severity})` : ''}`}
          >
            {execState === 'running' ? (
              <span className="runnable-code-block__spinner" />
            ) : execState === 'done' ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            ) : execState === 'error' ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            ) : (validation?.action === 'REQUIRE_APPROVAL' || validation?.action === 'REQUIRE_OVERRIDE') ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                Run
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5"/>
                  <line x1="12" y1="19" x2="20" y2="19"/>
                </svg>
                Run
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
