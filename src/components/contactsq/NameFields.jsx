/**
 * Person name fields, laid out by importance: Title, Given, Middle, Family, Suffix on one line (title and suffix are
 * short dropdowns of common options, blank by default), then Nickname; pronunciation and a display-name override sit
 * in a collapsed block. Under 560px (beside the agent panel) the line wraps into two.
 */
import { Field, FormGrid } from './shared'

export const TITLES = ['Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Dr', 'Prof', 'Rev', 'Sir', 'Dame', 'Lord', 'Lady']
export const SUFFIXES = ['Jr', 'Sr', 'II', 'III', 'IV', 'PhD', 'MD', 'KC', 'CBE', 'OBE', 'MBE', 'Esq']

/** Options for a dropdown: blank first, the common list, and the current value kept when it is not in the list (imported data). */
export function optionsWith(list, current) {
  const v = String(current || '').trim()
  return v && !list.some((x) => x.toLowerCase() === v.toLowerCase()) ? [...list, v] : list
}

export default function NameFields({ value, onChange, children, autoFocus }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value })
  const input = (k, extra = {}) => <input className="qx-input" value={value[k] || ''} onChange={set(k)} maxLength={100} autoComplete="off" {...extra} />
  const select = (k, list, label) => {
    const cur = value[k] || ''
    const match = list.find((x) => x.toLowerCase() === cur.toLowerCase()) || cur
    return (
      <select className="qx-select" value={match} onChange={set(k)} aria-label={label}>
        <option value="">None</option>
        {optionsWith(list, cur).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  return (
    <div className="qx-stack qx-stack--compact">
      <FormGrid>
        <Field label="Title" span={2} spanSm={4}>{select('prefix', TITLES, 'Title')}</Field>
        <Field label="Given name" span={3} spanSm={8}>{input('given', { autoFocus })}</Field>
        <Field label="Middle" span={2} spanSm={4}>{input('middle')}</Field>
        <Field label="Family name" span={3} spanSm={8}>{input('family')}</Field>
        <Field label="Suffix" span={2} spanSm={4}>{select('suffix', SUFFIXES, 'Suffix')}</Field>
        <Field label="Nickname" hint="Agents greet them with this." span={5} spanSm={8}>{input('nickname')}</Field>
      </FormGrid>
      <details className="qx-disclosure">
        <summary className="qx-disclosure__head">Pronunciation and display name <span className="qx-disclosure__chev">▸</span></summary>
        <div className="qx-disclosure__body qx-stack qx-stack--compact">
          <FormGrid>
            <Field label="Given name, as said" hint="Phonetic, for voice agents." span={6}>{input('phonetic_given')}</Field>
            <Field label="Family name, as said" span={6}>{input('phonetic_family')}</Field>
          </FormGrid>
          {children}
          <FormGrid>
            <Field label="Display name override" hint="Leave blank to build the name from the parts above." span={8}>{input('override')}</Field>
          </FormGrid>
        </div>
      </details>
    </div>
  )
}
