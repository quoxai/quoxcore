/**
 * Edit form. Sends only what changed. Flat sections (identity, classification, flags, quiet hours):
 * relationships and flags show only what is chosen, with one "Add" menu for the rest.
 */
import { useState } from 'react'
import { api, isUnavailable } from './lib/api'
import { RELATIONSHIPS, explainError, labelOf } from './lib/reasonCodes'
import { relationshipHue } from './lib/chips'
import { cardName, hasNameParts, hasStructuredName, namePatchFrom, nameFormFrom, splitFullName } from './lib/names'
import { ChoiceTags, Field, FormGrid, Section, TagInput, Unavailable } from './shared'
import NameFields from './NameFields'
import FlagPicker from './FlagPicker'
import { CheckIcon, SaveIcon, SplitIcon, XIcon } from './icons'

const sameSet = (a = [], b = []) => a.length === b.length && a.every((x) => b.includes(x))
const asTags = (t) => (Array.isArray(t) ? t : String(t || '').split(',')).map((x) => x.trim()).filter(Boolean)

export function buildPatch(card, f) {
  const p = {}
  if (hasStructuredName(card) && f.name) Object.assign(p, namePatchFrom(card, f.name))
  else if (f.display_name.trim() !== card.display_name) p.display_name = f.display_name.trim()
  if (f.org_name !== undefined && card.kind !== 'organisation') {
    const name = f.org_name.trim()
    const role = (f.org_role || '').trim()
    if (name !== (card.org?.name || '') || (name && role !== (card.org?.role || ''))) p.organisation = name ? { name, role: role || null } : null
  }
  if ((f.relationship_primary || null) !== (card.relationship_primary || null)) p.relationship_primary = f.relationship_primary || null
  if (!sameSet(f.relationships, card.relationships || [])) p.relationships = f.relationships
  if ((f.lifecycle_stage.trim() || null) !== (card.lifecycle_stage || null)) p.lifecycle_stage = f.lifecycle_stage.trim() || null
  const tags = asTags(f.tags)
  if (!sameSet(tags, card.tags || [])) p.tags = tags
  if (!sameSet(f.flags, card.flags || [])) p.flags = f.flags
  if (f.preferred_name.trim()) p.preferred_name = f.preferred_name.trim()
  if (f.pronunciation.trim()) p.pronunciation = f.pronunciation.trim()
  if (f.quiet === 'custom') {
    const qh = { start: f.qh_start, end: f.qh_end, ...(f.qh_tz.trim() ? { tz: f.qh_tz.trim() } : {}) }
    if (JSON.stringify(qh) !== JSON.stringify(card.quiet_hours || null)) p.quiet_hours = qh
  } else if (card.quiet_hours) p.quiet_hours = null
  return p
}

const REL_OPTIONS = RELATIONSHIPS.map((r) => ({ key: r, label: labelOf([], r) }))

const BLANK_PARTS = { prefix: '', given: '', middle: '', family: '', suffix: '', nickname: '', phonetic_given: '', phonetic_family: '', override: '' }

/** The parts to PUT for a confirmed split: only the five written parts that are not empty (the server derives the display name). */
export function splitPatch(parts) {
  const name = {}
  ;['prefix', 'given', 'middle', 'family', 'suffix'].forEach((k) => { if (String(parts[k] || '').trim()) name[k] = String(parts[k]).trim() })
  return Object.keys(name).length ? { name } : {}
}

/**
 * "Split name": for a person whose name is still ONE field (no parts yet, e.g. imported from another address book).
 * It only proposes a split from the display name; nothing is saved until the person edits the parts and confirms.
 */
export function SplitNameHelper({ card, onSaved }) {
  const current = cardName(card)
  const [proposal, setProposal] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  if (!current) return null
  const confirm = async () => {
    const patch = splitPatch(proposal)
    if (!patch.name) return
    setBusy(true); setErr(null)
    try { await api.updateContact(card.id, patch); setProposal(null); onSaved() } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  if (!proposal) {
    return (
      <div className="qx-banner qx-banner--info" role="note" data-testid="split-name">
        <span>This name is one field: <strong>{current}</strong>. Split it into title, given, middle, family and suffix so it can be sorted, searched and greeted properly.</span>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setProposal({ ...BLANK_PARTS, ...splitFullName(current) })}><SplitIcon />Split name</button>
      </div>
    )
  }
  return (
    <div className="qx-stack qx-stack--compact" role="group" aria-label="Confirm name split">
      <div className="qx-banner qx-banner--warn" role="status">Check each part, correct anything that is wrong, then confirm. Nothing is saved until you do.</div>
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      <NameFields value={proposal} onChange={setProposal} />
      <div className="qx-row qx-row--end qx-row--tight">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setProposal(null)}><XIcon />Cancel</button>
        <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy || !splitPatch(proposal).name} onClick={confirm}><CheckIcon />{busy ? 'Saving' : 'Confirm split'}</button>
      </div>
    </div>
  )
}

export default function ContactEdit({ card, onSaved }) {
  const qh = card.quiet_hours
  const structured = hasStructuredName(card)
  const [f, setF] = useState({
    display_name: cardName(card) || '',
    name: nameFormFrom(card),
    relationship_primary: card.relationship_primary || '',
    relationships: card.relationships || [],
    lifecycle_stage: card.lifecycle_stage || '',
    tags: card.tags || [],
    flags: card.flags || [],
    preferred_name: '', pronunciation: '',
    org_name: card.org?.name || '', org_role: card.org?.role || '',
    quiet: qh ? 'custom' : 'default', qh_start: qh?.start || '21:00', qh_end: qh?.end || '08:00', qh_tz: qh?.tz || '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [saved, setSaved] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    const patch = buildPatch(card, f)
    if (!Object.keys(patch).length) { setSaved(true); return }
    setBusy(true); setErr(null); setSaved(false)
    try { await api.updateContact(card.id, patch); setSaved(true); onSaved() } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }

  if (err && isUnavailable(err)) return <Unavailable what="Editing" />

  return (
    <div className="qx-stack">
    {/* Outside the form: pressing Enter in a proposed part must not submit the edit form. */}
    {structured && !hasNameParts(card) && !card.display_name_override ? <SplitNameHelper card={card} onSaved={onSaved} /> : null}
    <form className="qx-stack" onSubmit={submit} aria-label="Edit contact">
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      {saved && !err ? <div className="qx-banner qx-banner--success" role="status">Saved.</div> : null}

      <Section title="Name">
        {structured ? (
          <NameFields value={f.name} onChange={(name) => setF((s) => ({ ...s, name }))}>
            <FormGrid>
              <Field label="Preferred name" hint="What an agent should call them. Leave blank to keep the current one." span={6}><input className="qx-input" value={f.preferred_name} onChange={(e) => setF({ ...f, preferred_name: e.target.value })} /></Field>
              <Field label="Pronunciation note" hint="Leave blank to keep the current one." span={6}><input className="qx-input" value={f.pronunciation} onChange={(e) => setF({ ...f, pronunciation: e.target.value })} /></Field>
            </FormGrid>
          </NameFields>
        ) : (
          <FormGrid>
            <Field label="Name" span={6} spanSm={12}><input className="qx-input" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} required /></Field>
            <Field label="Preferred name" hint="What an agent should call them. Leave blank to keep the current one." span={3} spanSm={6}><input className="qx-input" value={f.preferred_name} onChange={(e) => setF({ ...f, preferred_name: e.target.value })} /></Field>
            <Field label="Pronunciation" hint="Leave blank to keep the current one." span={3} spanSm={6}><input className="qx-input" value={f.pronunciation} onChange={(e) => setF({ ...f, pronunciation: e.target.value })} /></Field>
          </FormGrid>
        )}
      </Section>

      {card.kind !== 'organisation' ? (
        <>
          <div className="qx-divider" />
          <Section title="Organisation">
            <FormGrid>
              <Field label="Organisation" hint="Where they work, or their own business. Leave blank for none." span={7} spanSm={12}><input className="qx-input" value={f.org_name} onChange={(e) => setF({ ...f, org_name: e.target.value })} aria-label="Organisation" /></Field>
              <Field label="Job title" span={5} spanSm={12}><input className="qx-input" value={f.org_role} onChange={(e) => setF({ ...f, org_role: e.target.value })} aria-label="Job title" disabled={!f.org_name.trim()} /></Field>
            </FormGrid>
          </Section>
        </>
      ) : null}

      <div className="qx-divider" />
      <Section title="Relationship and tags">
        <FormGrid>
          <Field label="Main relationship" span={5} spanSm={12}>
            <select className="qx-select" value={f.relationship_primary} onChange={(e) => setF({ ...f, relationship_primary: e.target.value })}>
              <option value="">Not set</option>
              {RELATIONSHIPS.map((r) => <option key={r} value={r}>{labelOf([], r)}</option>)}
            </select>
          </Field>
          <Field label="Lifecycle stage" hint="For example lead, onboarding, active, lapsed." span={7} spanSm={12}><input className="qx-input" value={f.lifecycle_stage} onChange={(e) => setF({ ...f, lifecycle_stage: e.target.value })} /></Field>
        </FormGrid>
        <div className="qx-field">
          <span className="qx-field__label">Also</span>
          <ChoiceTags options={REL_OPTIONS} values={f.relationships} onChange={(relationships) => setF({ ...f, relationships })} addLabel="Add relationship" noun="relationship" hueOf={relationshipHue} emptyText="No other relationships." />
        </div>
        <div className="qx-field">
          <span className="qx-field__label">Tags</span>
          <TagInput values={asTags(f.tags)} onChange={(tags) => setF({ ...f, tags })} />
          <span className="qx-field__hint">Press Enter to add. Tags never change who can be reached.</span>
        </div>
      </Section>

      <div className="qx-divider" />
      <Section title="Flags">
        <FlagPicker values={f.flags} onChange={(flags) => setF({ ...f, flags })} />
      </Section>

      <div className="qx-divider" />
      <Section title="Quiet hours">
        <div className="qx-seg" role="group" aria-label="Quiet hours mode">
          <button type="button" className={`qx-seg__btn${f.quiet === 'default' ? ' qx-seg__btn--active' : ''}`} onClick={() => setF({ ...f, quiet: 'default' })}>Use org default</button>
          <button type="button" className={`qx-seg__btn${f.quiet === 'custom' ? ' qx-seg__btn--active' : ''}`} onClick={() => setF({ ...f, quiet: 'custom' })}>Custom for this person</button>
        </div>
        {f.quiet === 'custom' ? (
          <FormGrid>
            <Field label="From" span={3} spanSm={6}><input type="time" className="qx-input" value={f.qh_start} onChange={(e) => setF({ ...f, qh_start: e.target.value })} /></Field>
            <Field label="Until" span={3} spanSm={6}><input type="time" className="qx-input" value={f.qh_end} onChange={(e) => setF({ ...f, qh_end: e.target.value })} /></Field>
            <Field label="Timezone" hint="For example Europe/London" span={6} spanSm={12}><input className="qx-input" value={f.qh_tz} onChange={(e) => setF({ ...f, qh_tz: e.target.value })} /></Field>
          </FormGrid>
        ) : null}
      </Section>

      <div className="qx-row qx-row--end">
        <button type="submit" className="qx-btn qx-btn--primary" disabled={busy}><SaveIcon />{busy ? 'Saving' : 'Save changes'}</button>
      </div>
    </form>
    </div>
  )
}
