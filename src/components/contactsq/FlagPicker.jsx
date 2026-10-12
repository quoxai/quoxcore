/**
 * FlagPicker: the twelve flags as compact coloured toggle chips in three groups (Blocks contact / Needs a
 * person's approval / Labels only). Lit = on. The explanation of each flag is a tooltip (hover or keyboard focus)
 * plus one "What do these do?" disclosure; there are no inline paragraphs. Controlled: values in, onChange out.
 */
import { flagLabel } from './lib/reasonCodes'
import { chipClass, flagHue, groupFlags } from './lib/chips'
import {
  AlertIcon, BotIcon, ChatOffIcon, ChildIcon, FlowerIcon, LockIcon, MailOffIcon, MegaphoneIcon, PhoneOffIcon, StarIcon, UserIcon, LinkIcon,
} from './icons'

export const FLAG_ICON = {
  do_not_call: PhoneOffIcon, do_not_sms: ChatOffIcon, do_not_email: MailOffIcon, do_not_market: MegaphoneIcon, human_only: UserIcon,
  deceased: FlowerIcon, minor: ChildIcon, complainant: AlertIcon, ai_disclosure_required: BotIcon, vip: StarIcon, legal_hold: LockIcon, source_removed: LinkIcon,
}
const GROUP_HINT = {
  high: 'Nothing is sent or dialled while these are on.',
  medium: 'A person approves each approach, or the call changes.',
  info: 'No effect on whether we can reach them.',
}

export default function FlagPicker({ values, onChange }) {
  const toggle = (key) => onChange(values.includes(key) ? values.filter((k) => k !== key) : [...values, key])
  const groups = groupFlags()
  return (
    <div className="qx-stack qx-stack--compact" role="group" aria-label="Flags">
      {groups.map((g) => {
        const on = g.flags.filter((f) => values.includes(f.key)).length
        return (
          <div key={g.severity} className="qx-stack qx-stack--tight" role="group" aria-label={g.label}>
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <strong>{g.label}</strong>
              {on ? <span className={chipClass(flagHue(g.flags[0].key), { size: 'xs' })} aria-label={`${on} on`}>{on} on</span> : null}
              <span className="qx-hint qx-hint--sm">{GROUP_HINT[g.severity]}</span>
            </div>
            <div className="qx-row qx-row--wrap qx-row--tight">
              {g.flags.map((f) => {
                const Icon = FLAG_ICON[f.key]
                const lit = values.includes(f.key)
                return (
                  <button key={f.key} type="button" aria-pressed={lit} data-tip={f.help}
                    className={`${chipClass(flagHue(f.key), { size: '', variant: 'toggle' })} qx-tip qx-tip--wrap`} onClick={() => toggle(f.key)}>
                    {Icon ? <Icon /> : null}{f.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
      {values.filter((k) => !groups.some((g) => g.flags.some((f) => f.key === k))).map((k) => (
        <span key={k} className={chipClass('blue', { variant: 'static' })} title="A flag this screen does not know about; saved as is.">{flagLabel(k)}</span>
      ))}
      <details className="qx-disclosure">
        <summary className="qx-disclosure__head">What do these flags do? <span className="qx-disclosure__chev">▸</span></summary>
        <div className="qx-disclosure__body qx-stack qx-stack--tight">
          {groups.map((g) => (
            <div key={g.severity}>
              <strong>{g.label}</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {g.flags.map((f) => <li key={f.key}><strong>{f.label}.</strong> {f.help}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}
