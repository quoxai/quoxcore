/** "How sure I am": always rendered, never hidden when everything is fine. */
import { Section, Note } from './lucidUi'

function names(list) {
  return (list || []).map((x) => (typeof x === 'string' ? x : x.label || x.feed || x.name || x.ref || JSON.stringify(x)))
}

export default function LucidBlindSpots({ cannotSee }) {
  const cs = cannotSee || {}
  const cov = cs.coverage || { live: 0, expected: 0 }
  const silent = names(cs.silent)
  const failing = names(cs.failing)
  const stale = names(cs.stale)
  const unwired = names(cs.unwired)
  return (
    <Section title="How sure I am">
      <Note>{cov.live} of {cov.expected} sources reporting.</Note>
      {failing.length > 0 && <Note>Failing: {failing.join(', ')}.</Note>}
      {silent.length > 0 && <Note>Gone quiet: {silent.join(', ')}.</Note>}
      {stale.length > 0 && <Note>Possibly out of date: {stale.join(', ')}.</Note>}
      {unwired.length > 0 && <Note>Not connected: {unwired.join(', ')}.</Note>}
      {!failing.length && !silent.length && !stale.length && !unwired.length && (
        <Note>Nothing I know of is failing or missing. I can only speak for what is connected.</Note>
      )}
    </Section>
  )
}
