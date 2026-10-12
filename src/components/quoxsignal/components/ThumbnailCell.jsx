import { useState } from 'react';
import { api } from '../lib/api.js';
import PlatformMark from './PlatformMark.jsx';

/* Matches .qx-thumb's fixed box in qx-components.css — explicit width/height
   attrs so the browser reserves the space before the image loads, the same
   reflow guard as Avatar. */
const THUMB_W = 56;
const THUMB_H = 40;

/**
 * Fixed-width feed thumbnail column, kept deliberately separate from the
 * source column (Avatar) so a row's height stays dense-list-sane rather than
 * doubling into a gallery card.
 *
 * `has_thumbnail: false` is the common case (most items haven't reached a
 * visual stage yet) and a 404 from the cached image endpoint is equally
 * normal — both render the same quiet placeholder, never a broken-image icon,
 * so the column never collapses and rows never jump as thumbnails arrive.
 */
export default function ThumbnailCell({ itemId, hasThumbnail, platform }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(hasThumbnail && itemId && !failed);

  return (
    <span className="qx-thumb" data-testid="signal-thumbnail">
      {showImage ? (
        <img
          src={api.itemThumbnailUrl(itemId)}
          alt=""
          width={THUMB_W}
          height={THUMB_H}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          /* Show WHERE it came from rather than a picture-frame glyph. Thumbnails land for
             about 95% of social items and 0% of web feed items, because an RSS or JSON entry
             often carries no per-item image and never will. For those sources the empty slot
             is permanent, so a "missing image" icon states something false. The platform mark
             is true, and it is the useful thing to know when scanning a mixed feed. */
          className="qx-thumb__placeholder" data-testid="signal-thumbnail-placeholder">
          <PlatformMark platform={platform} size={22} />
        </span>
      )}
    </span>
  );
}
