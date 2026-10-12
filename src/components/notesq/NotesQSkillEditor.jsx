/**
 * Skill editor in the NotesQ doc pane. Skills stay owned by quoxflow: this is an editing surface over
 * the same client the Skills page uses, never a copy. No autosave: an explicit Save sends only bodyMd
 * through the governed patch flow (firewall, crystals, tests, audit trail).
 *
 * Modes: Markdown and Read. Rich is deliberately not offered: skill bodies carry frontmatter-style
 * structure and code samples that a rich round trip must never rewrite, and a skill save is a
 * governed, versioned patch, not a cheap autosave.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getQuoxSkillById, updateQuoxSkill, listSkillPatches, revertSkill } from '../../services/quoxflowClient'
import NotesQMarkdown from './NotesQMarkdown'
import { tagChipClass } from './lib/tagHue'
import { relativeTime } from './lib/listQuery'
import { skillBody, editionChipClass, sourceNoteId, findingsOf } from './lib/skillsView'
import { ChevronLeftIcon, CodeIcon, EyeIcon, CheckIcon, RefreshIcon, RestoreIcon, XIcon, BookOpenIcon } from './icons'

function SkillRail({ skill, dirty, reloadTick, onReverted, onOpenNote }) {
  const [hist, setHist] = useState(null)
  const [histErr, setHistErr] = useState('')
  const [target, setTarget] = useState(null)
  const [busy, setBusy] = useState(false)
  const [revErr, setRevErr] = useState('')
  useEffect(() => {
    let live = true
    setHist(null); setHistErr('')
    listSkillPatches(skill.id)
      .then((d) => { if (live) setHist(Array.isArray(d?.patches) ? d.patches : []) })
      .catch((e) => { if (live) setHistErr(e?.message || 'Could not load history.') })
    return () => { live = false }
  }, [skill.id, skill.version, reloadTick])
  const doRevert = async () => {
    setBusy(true); setRevErr('')
    try {
      await revertSkill(skill.id, { toVersion: target, reason: 'reverted from NotesQ' })
      setTarget(null)
      await onReverted()
    } catch (e) { setRevErr(e?.message || 'Revert failed.') } finally { setBusy(false) }
  }
  const tags = Array.isArray(skill.tags) ? skill.tags : []
  const agents = Array.isArray(skill.bestForAgents) ? skill.bestForAgents : []
  const fromNote = sourceNoteId(skill)
  return (
    <>
      <div className="qx-card qx-card--compact qx-stack qx-stack--tight">
        <div className="qx-section-title">Properties</div>
        <dl className="qx-stack qx-stack--tight" style={{ margin: 0 }}>
          <div><dt className="qx-hint qx-hint--sm">Category</dt><dd style={{ margin: 0 }}>{skill.category || 'none'}</dd></div>
          <div><dt className="qx-hint qx-hint--sm">Edition</dt><dd style={{ margin: 0 }}>{skill.edition || 'experimental'}</dd></div>
          <div><dt className="qx-hint qx-hint--sm">Version</dt><dd style={{ margin: 0 }}>v{skill.version}</dd></div>
          <div><dt className="qx-hint qx-hint--sm">License</dt><dd style={{ margin: 0 }}>{skill.license || 'undeclared'}</dd></div>
          <div><dt className="qx-hint qx-hint--sm">Required tools</dt><dd style={{ margin: 0 }}>{Array.isArray(skill.requiredTools) ? skill.requiredTools.length : 0}</dd></div>
        </dl>
        <div className="qx-hint qx-hint--sm">Tags</div>
        <div className="qx-row qx-row--wrap qx-row--tight">
          {tags.length ? tags.map((t) => <span key={t} className={tagChipClass(t)}>#{t}</span>) : <span className="qx-hint qx-hint--sm">none</span>}
        </div>
        <div className="qx-hint qx-hint--sm">Best for agents</div>
        <div className="qx-row qx-row--wrap qx-row--tight">
          {agents.length ? agents.map((a) => <span key={a} className="qx-chip qx-chip--xs qx-chip--static">{a}</span>) : <span className="qx-hint qx-hint--sm">any</span>}
        </div>
        {fromNote ? (
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => onOpenNote(fromNote)}><BookOpenIcon /> From note</button>
        ) : null}
      </div>
      <div className="qx-card qx-card--compact qx-stack qx-stack--tight">
        <div className="qx-section-title">History</div>
        {histErr ? <div className="qx-banner qx-banner--error" role="alert">{histErr}</div> : null}
        {hist && hist.length === 0 ? <div className="qx-hint qx-hint--sm">No patch history yet. This skill is at v{skill.version}.</div> : null}
        {revErr ? <div className="qx-banner qx-banner--error" role="alert">{revErr}</div> : null}
        {(hist || []).map((p, i) => {
          const current = i === 0 && p.toVersion === skill.version
          return (
            <div key={p.id || i} className="qx-stack qx-stack--tight" data-testid="skill-patch">
              <div className="qx-row qx-row--apart qx-row--tight">
                <strong>v{p.toVersion}</strong>
                <span className="qx-hint qx-hint--sm">{relativeTime(p.createdAt)}</span>
              </div>
              {p.reason ? <div className="qx-hint qx-hint--sm">{p.reason}</div> : null}
              {current ? <span className="qx-pill qx-pill--xs qx-pill--info">current</span> : target === p.toVersion ? (
                <div className="qx-stack qx-stack--tight" role="group" aria-label={`Confirm revert to v${p.toVersion}`}>
                  <div className="qx-hint qx-hint--sm">Revert this skill to v{p.toVersion}? This creates a new version.</div>
                  <div className="qx-row qx-row--tight">
                    <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy} onClick={doRevert}><CheckIcon /> Confirm revert</button>
                    <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => setTarget(null)}><XIcon /> Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={dirty}
                  title={dirty ? 'Save or discard your edits first' : `Revert to v${p.toVersion}`}
                  onClick={() => { setTarget(p.toVersion); setRevErr('') }}><RestoreIcon /> Revert to this version</button>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

export default function NotesQSkillEditor({ skillId, onDirtyChange, onBack, onOpenNote, onChanged }) {
  const [skill, setSkill] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [body, setBody] = useState('')
  const [mode, setMode] = useState('markdown')
  const [saving, setSaving] = useState(false)
  const [stale, setStale] = useState(null)
  const [saveErr, setSaveErr] = useState('')
  const [findings, setFindings] = useState([])
  const [savedMsg, setSavedMsg] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  const base = useRef('')

  const load = useCallback(async () => {
    setLoadErr('')
    try {
      const s = await getQuoxSkillById(skillId)
      if (!s) { setLoadErr('Skill not found.'); return }
      setSkill(s); setBody(skillBody(s)); base.current = skillBody(s)
      setStale(null); setSaveErr(''); setFindings([])
    } catch (e) { setLoadErr(e?.message || 'Could not load this skill.') }
  }, [skillId])
  useEffect(() => { load() }, [load])

  const dirty = !!skill && body !== base.current
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const save = async () => {
    setSaving(true); setSaveErr(''); setFindings([]); setSavedMsg('')
    try {
      const fresh = await getQuoxSkillById(skillId)
      if (fresh && fresh.version !== skill.version) { setStale({ from: skill.version, to: fresh.version }); return }
      const res = await updateQuoxSkill(skillId, { bodyMd: body })
      const next = res?.skill || (await getQuoxSkillById(skillId))
      if (next) setSkill(next)
      base.current = body
      setSavedMsg(`Saved as v${next?.version ?? ''}`.trim())
      setReloadTick((t) => t + 1)
      onChanged?.()
    } catch (e) {
      const f = findingsOf(e)
      setFindings(f)
      setSaveErr(e?.code === 'FIREWALL_BLOCKED' ? 'Not saved: the safety scan blocked this body.' : `Not saved. ${e?.message || 'Save failed.'}`)
    } finally { setSaving(false) }
  }

  const afterRevert = async () => {
    setSavedMsg('')
    await load()
    setReloadTick((t) => t + 1)
    onChanged?.()
  }

  if (loadErr) {
    return (
      <section className="nq-pane nq-pane--doc qx-card">
        <div className="qx-banner qx-banner--error" role="alert">
          <span>Could not load this skill. {loadErr}</span>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={load}><RefreshIcon /> Retry</button>
        </div>
      </section>
    )
  }
  if (!skill) {
    return (
      <section className="nq-pane nq-pane--doc qx-card" aria-busy="true"><div className="qx-skeleton qx-skeleton--line-lg" /><div className="qx-skeleton qx-skeleton--block" /></section>
    )
  }
  return (
    <div className="nq-pane nq-pane--doc nq-doc" data-rail="open">
      <div className="nq-doc__main">
        <header className="qx-card qx-card--bar nq-bar">
          <div className="nq-bar__id">
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm nq-back" onClick={onBack}><ChevronLeftIcon /> Skills</button>
            <strong className="nq-bar__title" title={skill.name}>{skill.name}</strong>
            <span className={editionChipClass(skill.edition)}>{skill.edition || 'experimental'}</span>
            <span className="qx-pill qx-pill--xs">v{skill.version}</span>
          </div>
          <div className="qx-seg nq-bar__mode" role="group" aria-label="Mode">
            <button type="button" className={`qx-seg__btn${mode === 'markdown' ? ' qx-seg__btn--active' : ''}`} onClick={() => setMode('markdown')} aria-label="Markdown"><CodeIcon /> <span className="nq-btn-label">Markdown</span></button>
            <button type="button" className={`qx-seg__btn${mode === 'read' ? ' qx-seg__btn--active' : ''}`} onClick={() => setMode('read')} aria-label="Read"><EyeIcon /> <span className="nq-btn-label">Read</span></button>
          </div>
          <div className="nq-bar__tools">
            <Link to="/skills" className="qx-btn qx-btn--ghost qx-btn--sm">Open in Skills library</Link>
            <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={!dirty || saving} onClick={save}><CheckIcon /> {saving ? 'Saving' : 'Save'}</button>
          </div>
        </header>
        {stale ? (
          <div className="qx-banner qx-banner--warn" role="alert">
            <span>This skill changed since you opened it (v{stale.from} to v{stale.to}). Reload to see it.</span>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={load}><RefreshIcon /> Reload</button>
          </div>
        ) : null}
        {saveErr ? (
          <div className="qx-banner qx-banner--error" role="alert">
            <div className="qx-stack qx-stack--tight">
              <span>{saveErr} Your edits are kept.</span>
              {findings.map((f, i) => (
                <span key={i} className="qx-hint qx-hint--sm" data-testid="skill-finding">{[f.severity, f.rule, f.message].filter(Boolean).join(': ')}</span>
              ))}
            </div>
          </div>
        ) : null}
        {savedMsg && !saveErr && !dirty ? <div className="qx-banner qx-banner--info" role="status">{savedMsg}</div> : null}
        <div className={`nq-doc__body qx-card qx-card--compact${mode === 'read' ? '' : ' nq-doc__body--edit'}`} data-mode={mode}>
          {mode === 'read' ? (
            body.trim() ? <NotesQMarkdown markdown={body} /> : <div className="qx-empty"><div className="qx-empty__title">This skill has no body</div></div>
          ) : (
            <div className="nq-edit"><div className="nq-edit__area"><div className="nq-edit__pane">
              <textarea className="qx-textarea qx-textarea--mono nq-editor" value={body} spellCheck={false} aria-label="Skill markdown"
                onChange={(e) => { setBody(e.target.value); setSavedMsg('') }} />
            </div></div></div>
          )}
        </div>
      </div>
      <div className="nq-doc__rail">
        <SkillRail skill={skill} dirty={dirty} reloadTick={reloadTick} onReverted={afterRevert} onOpenNote={onOpenNote} />
      </div>
    </div>
  )
}
