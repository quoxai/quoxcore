/**
 * loopStuckDetector.js — DEVSUITE-DEVMODE QLoop Observer/Knot: objective-level
 * stuck / oscillation detection.
 *
 * A native agentic loop (claude -p / codex exec) can wedge: repeating the same
 * failing tool call, ping-ponging between two actions, or monologuing without
 * acting. OpenHands has a process-local StuckDetector for exactly this; QLoop
 * ports the same PATTERNS up to the OBJECTIVE level, where every turn is
 * already a WARD-witnessed event — so a detected stuck state isn't just a local
 * heuristic, it's an evidence-backed Observer finding that can escalate or
 * interrupt (the "Knot inherits interrupt" decision, DEVSUITE-DEVMODE plan).
 *
 * This is the PURE detector: feed it normalized loop turns, it returns a
 * verdict when a stuck pattern crosses threshold. It holds no I/O — wiring
 * (WARD witness, kill/interrupt, objective status) lives in the consumer.
 *
 * Patterns (each configurable threshold, default 3 repeats):
 *   repeating_action_result  — same tool+args followed by the same result
 *   repeating_action_error   — same tool+args followed by an error result
 *   oscillation              — strict A,B,A,B,... alternation of two actions
 *   monologue                — same assistant text repeated with no tool use
 *
 * A "turn" fed to observe() is the loop's normalized shape, matching
 * loopDispatch.normalizeLoopEvent's inputs plus a couple of fields the raw
 * event carries:
 *   { kind: 'tool_use', tool, argsKey, isError }   // isError from the paired result
 *   { kind: 'assistant', text }
 *   { kind: 'result' | 'other' }                    // ignored for detection
 */

const DEFAULT_THRESHOLD = 3

function normalizeText(t) {
  return String(t || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Create a stuck detector. observe(turn) returns null while healthy, or a
 * verdict object { pattern, detail, count } the first time a pattern crosses
 * threshold. After firing it keeps the window so a persistent stuck state is
 * reported once per crossing, not every subsequent turn (the consumer decides
 * whether to interrupt on the first verdict).
 */
function createStuckDetector({ threshold = DEFAULT_THRESHOLD } = {}) {
  // Keep just enough history: the last few actionable turns.
  const maxHistory = Math.max(threshold * 2 + 2, 8)
  const actions = [] // { sig, isError } for tool_use turns
  const assistantTexts = []
  let firedFor = null // signature we already reported, to de-dup consecutive fires

  function push(arr, v) {
    arr.push(v)
    if (arr.length > maxHistory) arr.shift()
  }

  function tailAllEqual(arr, n, eq) {
    if (arr.length < n) return false
    const last = arr[arr.length - 1]
    for (let i = arr.length - n; i < arr.length; i++) {
      if (!eq(arr[i], last)) return false
    }
    return true
  }

  function detectOscillation() {
    // Strict alternation A,B,A,B over the last (threshold*2) actions, A!==B.
    const n = threshold * 2
    if (actions.length < n) return null
    const slice = actions.slice(actions.length - n).map(a => a.sig)
    const a = slice[0]
    const b = slice[1]
    if (a === b) return null
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] !== (i % 2 === 0 ? a : b)) return null
    }
    return { pattern: 'oscillation', detail: `alternating between two actions ${threshold}x`, count: n, sig: `osc:${a}|${b}` }
  }

  return {
    /**
     * @param {{kind:string, tool?:string, argsKey?:string, isError?:boolean, text?:string}} turn
     * @returns {null | {pattern:string, detail:string, count:number}}
     */
    observe(turn) {
      if (!turn || typeof turn !== 'object') return null

      if (turn.kind === 'tool_use') {
        const sig = `${turn.tool || 'tool'}::${turn.argsKey || ''}`
        push(actions, { sig, isError: !!turn.isError })
        // A tool use breaks a monologue streak.
        assistantTexts.length = 0

        // repeating_action_error: same action + error, threshold times.
        if (tailAllEqual(actions, threshold, (x, y) => x.sig === y.sig && x.isError && y.isError)) {
          const v = { pattern: 'repeating_action_error', detail: `same tool call failing ${threshold}x: ${sig}`, count: threshold, sig: `err:${sig}` }
          return fire(v)
        }
        // repeating_action_result: same action repeated (non-error), threshold times.
        if (tailAllEqual(actions, threshold, (x, y) => x.sig === y.sig)) {
          const v = { pattern: 'repeating_action_result', detail: `same tool call repeated ${threshold}x with no change: ${sig}`, count: threshold, sig: `rep:${sig}` }
          return fire(v)
        }
        const osc = detectOscillation()
        if (osc) return fire(osc)
        return null
      }

      if (turn.kind === 'assistant') {
        const norm = normalizeText(turn.text)
        if (!norm) return null
        push(assistantTexts, norm)
        if (tailAllEqual(assistantTexts, threshold, (x, y) => x === y)) {
          const v = { pattern: 'monologue', detail: `assistant repeated the same message ${threshold}x without acting`, count: threshold, sig: `mono:${norm.slice(0, 40)}` }
          return fire(v)
        }
        return null
      }

      // result/other: a real result clears the fire de-dup so a NEW stuck
      // state later can fire again.
      if (turn.kind === 'result') firedFor = null
      return null
    },

    /**
     * Mark the most recent action as having errored (claude reports tool
     * results in a separate later `user` event, so the error is known only
     * after observe() saw the tool_use). Re-checks the error pattern and
     * returns a verdict if flagging pushed it over threshold, else null.
     */
    flagLastActionError() {
      if (actions.length === 0) return null
      actions[actions.length - 1].isError = true
      const sig = actions[actions.length - 1].sig
      if (tailAllEqual(actions, threshold, (x, y) => x.sig === y.sig && x.isError && y.isError)) {
        return fire({ pattern: 'repeating_action_error', detail: `same tool call failing ${threshold}x: ${sig}`, count: threshold, sig: `err:${sig}` })
      }
      return null
    },

    reset() {
      actions.length = 0
      assistantTexts.length = 0
      firedFor = null
    },
  }

  function fire(v) {
    if (firedFor === v.sig) return null // already reported this exact stuck state
    firedFor = v.sig
    return { pattern: v.pattern, detail: v.detail, count: v.count }
  }
}

/**
 * Derive the detector-turn shape from a raw stream-json loop event plus the
 * error state of its paired result (the consumer tracks pairing by
 * tool_use_id). Kept here so the consumer and tests share one mapping.
 */
function argsKeyFor(event) {
  // A stable-ish signature of a tool call's arguments. Claude events carry the
  // input under message.content[].input; codex command_execution under command.
  try {
    if (event?.command) return String(event.command).slice(0, 200)
    const content = event?.message?.content
    if (Array.isArray(content)) {
      const tu = content.find(c => c?.type === 'tool_use')
      if (tu?.input) return JSON.stringify(tu.input).slice(0, 200)
    }
  } catch { /* fall through */ }
  return ''
}

export { createStuckDetector, argsKeyFor, DEFAULT_THRESHOLD }
