/**
 * SuggestionChips — horizontal row of follow-up suggestion pills below assistant messages.
 *
 * Props:
 *   chips      — Array<{ label, query, icon }>
 *   onChipClick — (query: string) => void
 */

import { memo } from 'react';
import './SuggestionChips.css';

const ICON_CHARS = {
  package: '\u{1F4E6}',
  play: '\u25B6',
  refresh: '\u21BB',
  'file-text': '\u{1F4C4}',
  git: '\u{1F500}',
  terminal: '>_',
  'check-circle': '\u2714',
  'help-circle': '?',
  'message-circle': '\u{1F4AC}',
};

function SuggestionChips({ chips, onChipClick, hidden }) {
  if (!chips || chips.length === 0) return null;

  return (
    <div className={`suggestion-chips${hidden ? ' suggestion-chips--hidden' : ''}`}>
      {chips.map((chip, i) => (
        <button
          key={`${chip.label}-${i}`}
          className="suggestion-chip"
          onClick={() => onChipClick(chip.query)}
          title={chip.query}
          disabled={hidden}
        >
          <span className="suggestion-chip__icon">{ICON_CHARS[chip.icon] || '\u{1F4AC}'}</span>
          <span className="suggestion-chip__label">{chip.label}</span>
        </button>
      ))}
    </div>
  );
}

export default memo(SuggestionChips);
