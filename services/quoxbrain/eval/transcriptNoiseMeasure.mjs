// ONE-BRAIN CX5 (F2): measurement only, not runtime. Reports how much of the
// text the transcript reader extracts is skill bodies / command wrappers /
// caveat blocks rather than prose. Prints COUNTS ONLY, never content.
//   node eval/transcriptNoiseMeasure.mjs [dir] [topN]
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { parseTranscriptFile, DEFAULT_TRANSCRIPT_DIR } from '../readers/transcriptReader.mjs'

const dir = process.argv[2] || DEFAULT_TRANSCRIPT_DIR
const topN = Number(process.argv[3]) || 5
const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f, size: statSync(join(dir, f)).size }))
  .sort((a, b) => b.size - a.size).slice(0, topN)

const WRAP = /<(command-name|command-message|command-args|local-command-stdout)>/
const totals = { total: 0, skill: 0, wrapper: 0, caveat: 0, launching: 0, reminder: 0, turns: 0, assistant: 0 }
for (const { f } of files) {
  const { turns } = await parseTranscriptFile(join(dir, f))
  for (const t of turns) {
    const n = t.text.length
    totals.total += n
    totals.turns += 1
    if (t.role !== 'user') { totals.assistant += n; continue }
    if (t.text.startsWith('Base directory for this skill:')) totals.skill += n
    else if (t.text.includes('<local-command-caveat>')) totals.caveat += n
    else if (WRAP.test(t.text)) totals.wrapper += n
    else if (t.text.startsWith('Launching skill:')) totals.launching += n
    else if (t.text.includes('<system-reminder>')) totals.reminder += n
  }
}
const noise = totals.skill + totals.wrapper + totals.caveat + totals.launching + totals.reminder
console.log(JSON.stringify({ files: files.length, ...totals, noise, prose: totals.total - noise,
  noiseShare: +(noise / totals.total).toFixed(4) }))
