/**
 * GlassQuoxBranding — QCX-5d
 *
 * "Powered by Quox" seal. Returns null when hidden. Custom href falls
 * back to quox.ai when unsafe.
 */

import { isSafeUrl } from './_urlGuard';
import './glass-chat.css';

const DEFAULT_HREF = 'https://quox.ai';

export function GlassQuoxBranding({ hidden = false, href, label = 'Powered by QuoxChat' }) {
  if (hidden) return null;
  const safeHref = isSafeUrl(href) ? href : DEFAULT_HREF;
  return (
    <div className="gqb">
      <a href={safeHref} target="_blank" rel="noopener noreferrer">{label}</a>
    </div>
  );
}
