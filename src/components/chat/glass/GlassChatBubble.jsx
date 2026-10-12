/**
 * GlassChatBubble — QCX-5b
 *
 * Shared chat bubble for the dashboard and the Widget Room preview.
 * Variants: user / assistant / system / error. `html` takes precedence
 * over `children` so callers that have already rendered markdown
 * can pass sanitised HTML. Unknown roles fall back to assistant.
 *
 * Visual tokens live in ./glass-chat.css.
 */

import './glass-chat.css';

const ROLES = new Set(['user', 'assistant', 'system', 'error']);

export function GlassChatBubble({
  role = 'assistant',
  html,
  children,
  className = '',
  ...rest
}) {
  const safeRole = ROLES.has(role) ? role : 'assistant';
  const aria = safeRole === 'error' ? { 'aria-live': 'polite' } : {};
  const classes = ['gcb', `gcb--${safeRole}`, 'gcb--enter', className].filter(Boolean).join(' ');
  return (
    <div
      className={classes}
      role="article"
      data-role={safeRole}
      {...aria}
      {...rest}
    >
      {html !== undefined
        ? <div className="gcb__body" dangerouslySetInnerHTML={{ __html: html }} />
        : <div className="gcb__body">{children}</div>}
    </div>
  );
}
