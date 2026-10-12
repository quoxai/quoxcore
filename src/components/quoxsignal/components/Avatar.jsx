import { useState } from 'react';
import { api } from '../lib/api.js';
import PlatformMark from './PlatformMark.jsx';

/* .qx-avatar's own --xs/--sm/--lg/--xl size vars, mirrored here so the
   explicit width/height attrs below reserve the right box before the image
   loads (loading="lazy" + no dimensions is what causes list reflow). */
const AVATAR_PX = { xs: 24, sm: 32, '': 40, lg: 56, xl: 80 };

/**
 * Source avatar, shared by the Feed's source column and the Sources list —
 * one component so both surfaces agree on what "no avatar yet" looks like.
 *
 * Renders the cached `GET /sources/:id/avatar` image when the source
 * serializer says `has_avatar`, otherwise a two-letter monogram tile on
 * `monogram_color`. A 404 from that endpoint is the normal "hasn't been
 * fetched/cached yet" case, not a broken-image error, so onError swaps
 * quietly back to the monogram rather than showing a broken-image icon.
 */
export default function Avatar({ sourceId, hasAvatar, monogram, monogramColor, platform, size = '', className = '' }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(hasAvatar && sourceId && !failed);
  const px = AVATAR_PX[size] ?? AVATAR_PX[''];
  const sizeClass = size ? ` qx-avatar--${size}` : '';

  return (
    <span
      className={`qx-avatar${sizeClass}${className ? ` ${className}` : ''}`}
      style={monogramColor ? { background: monogramColor } : undefined}
      data-testid="signal-avatar"
    >
      {/* With no real avatar, prefer the PLATFORM over a monogram. Only 2 of 6 live sources
          have an avatar (most platforms give us no profile image without a session), and the
          source label is rendered immediately beside this tile, so initials just restate what
          the reader can already see. The platform is not shown anywhere else in this column,
          so the mark adds a fact instead of echoing one. Monogram remains the fallback when
          the platform is unknown. */}
      {showImage ? (
        <img
          src={api.sourceAvatarUrl(sourceId)}
          alt=""
          width={px}
          height={px}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        platform ? (
          <PlatformMark platform={platform} size={px} />
        ) : (
          <span aria-hidden="true">{monogram || '?'}</span>
        )
      )}
    </span>
  );
}
