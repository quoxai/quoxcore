/** Formatting toolbar for Edit/Split mode. Buttons act on the textarea selection via onAction(id). */
import {
  BoldIcon, ItalicIcon, StrikeIcon, H1Icon, H2Icon, H3Icon, ListIcon, ListOrderedIcon, CheckSquareIcon,
  QuoteIcon, CodeIcon, CodeBlockIcon, LinkIcon, NoteLinkIcon, HrIcon, PaperclipIcon, CameraIcon,
} from './icons'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const MOD = isMac ? 'Cmd' : 'Ctrl'

const GROUP_HUES = ['sky', 'violet', 'teal', 'amber', 'fuchsia', 'green']
const GROUPS = [
  [['bold', 'Bold', `${MOD}+B`, BoldIcon], ['italic', 'Italic', `${MOD}+I`, ItalicIcon], ['strike', 'Strikethrough', null, StrikeIcon]],
  [['h1', 'Heading 1', null, H1Icon], ['h2', 'Heading 2', null, H2Icon], ['h3', 'Heading 3', null, H3Icon]],
  [['ul', 'Bulleted list', `${MOD}+Shift+8`, ListIcon], ['ol', 'Numbered list', `${MOD}+Shift+7`, ListOrderedIcon], ['check', 'Checklist', `${MOD}+Shift+9`, CheckSquareIcon]],
  [['quote', 'Quote', null, QuoteIcon], ['code', 'Inline code', null, CodeIcon], ['codeblock', 'Code block', null, CodeBlockIcon]],
  [['link', 'Link', `${MOD}+K`, LinkIcon], ['notelink', 'Link to a note ([[)', null, NoteLinkIcon], ['hr', 'Horizontal rule', null, HrIcon]],
  [['attach', 'Attach files or images', null, PaperclipIcon], ['camera', 'Take photo', null, CameraIcon]],
]

export default function NotesQToolbar({ onAction, isActive }) {
  return (
    <div className="nq-toolbar qx-row qx-row--wrap qx-row--tight" role="toolbar" aria-label="Formatting">
      {GROUPS.map((g, gi) => (
        <div key={gi} className={`qx-seg qx-seg--tint qx-tint--${GROUP_HUES[gi]}`} role="group">
          {g.map(([id, label, key, Icon]) => (
            <button key={id} type="button" className={`qx-seg__btn qx-tint__btn${isActive?.(id) ? ' qx-seg__btn--active' : ''}`} aria-label={label} aria-pressed={isActive ? !!isActive(id) : undefined} title={key ? `${label} (${key})` : label}
              // mousedown preventDefault keeps the textarea selection while clicking.
              onMouseDown={(e) => e.preventDefault()} onClick={() => onAction(id)}>
              <Icon size={18} strokeWidth={2.4} />
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
