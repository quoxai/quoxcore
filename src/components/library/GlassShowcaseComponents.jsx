/**
 * Glass Showcase Components — Adapted from quox-remotion library
 * Stripped of Remotion deps, uses CSS animations + requestAnimationFrame
 * All colours comply with Glass Design System (no grey text, min 0.6 opacity)
 */
import { useState, useEffect, useRef } from 'react'

const M = "'JetBrains Mono','Fira Code',monospace"
const F = "'Inter',system-ui,sans-serif"

// ─── Shared: useAnimFrame hook ───
function useAnimFrame(active = true) {
  const [f, setF] = useState(0)
  useEffect(() => {
    if (!active) return
    let id, last = 0
    const tick = (t) => { if (t - last > 33) { setF(v => v + 1); last = t } id = requestAnimationFrame(tick) }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [active])
  return f
}

function lerp(f, start, end, from, to) {
  const t = Math.max(0, Math.min(1, (f - start) / (end - start)))
  return from + t * (to - from)
}

// Glass wrapper for panels inside showcase
const GP = ({ children, style = {} }) => (
  <div style={{
    backdropFilter: 'var(--glass-blur-strong)', WebkitBackdropFilter: 'var(--glass-blur-strong)',
    background: 'linear-gradient(145deg,rgba(255,255,255,0.02) 0%,rgba(255,255,255,0.005) 100%)',
    borderTop: '1px solid rgba(255,255,255,0.40)', borderLeft: '1px solid rgba(255,255,255,0.31)',
    borderRight: '1px solid transparent', borderBottom: '1px solid transparent',
    borderRadius: 12, boxShadow: '0 5px 19px rgba(0,0,0,0.35),0 2px 4px rgba(0,0,0,0.2),inset 0 1px 2px rgba(255,255,255,0.08)',
    position: 'relative', overflow: 'hidden', padding: 16, ...style
  }}>
    <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none', background: 'linear-gradient(105deg,rgba(255,255,255,0.05) 0%,transparent 35%,transparent 65%,rgba(255,255,255,0.01) 100%)' }} />
    <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
  </div>
)

// ═══════════════════════════════════════════════════════════════
// 1. EVIDENCE CHAIN BROWSER
// ═══════════════════════════════════════════════════════════════
const ECB_TYPES = {
  execution_result: { color: '#30ff90', label: 'Execution Result' },
  approval_request: { color: '#f59e0b', label: 'Approval Request' },
  approval_decision: { color: '#3b82f6', label: 'Approval Decision' },
  policy_evaluation: { color: '#a855f7', label: 'Policy Evaluation' },
  node_output: { color: '#6366f1', label: 'Node Output' },
  error: { color: '#ef4444', label: 'Error' },
  audit_trail: { color: '#06b6d4', label: 'Audit Trail' },
}

const ECB_DATA = [
  { type: 'approval_request', ts: '14:30:01', actor: 'VULCAN', content: 'Deploy quox-api v2.4.1 to production (edge-01, edge-02)' },
  { type: 'policy_evaluation', ts: '14:30:02', actor: 'AOCL PolicyEngine', content: 'Policy deploy.production.require_approval: ENFORCED. Two-person rule active.' },
  { type: 'approval_decision', ts: '14:31:15', actor: 'admin@example.com', content: 'APPROVED. Changelog reviewed, tests passing, staging verified.' },
  { type: 'node_output', ts: '14:31:18', actor: 'QuoxFlow/deploy-node', content: 'Pulling image quoxai/quox-api:2.4.1 on edge-01... done (14s)' },
  { type: 'node_output', ts: '14:31:35', actor: 'QuoxFlow/deploy-node', content: 'Pulling image quoxai/quox-api:2.4.1 on edge-02... done (11s)' },
  { type: 'execution_result', ts: '14:31:48', actor: 'QuoxFlow', content: 'Deployment complete. Health checks passed on both hosts. Rolling restart successful.' },
  { type: 'audit_trail', ts: '14:31:49', actor: 'VOLT Ledger', content: 'VOLT entry #4891 recorded. Hash: 8f3a2c...d71e. Chain verified. WARD receipt issued.' },
]

export function EvidenceChainBrowser() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>EVIDENCE CHAIN BROWSER</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontFamily: M, fontSize: 10, marginBottom: 6 }}>
        <span style={{ color: '#06b6d4' }}>wf-deploy-prod-0x7a3f</span>
        <span style={{ color: 'rgba(255,255,255,0.6)' }}>|</span>
        <span style={{ color: 'rgba(255,255,255,0.7)' }}>7 entries</span>
        <span style={{ color: 'rgba(255,255,255,0.6)' }}>|</span>
        <span style={{ color: 'rgba(255,255,255,0.7)' }}>14:30:01 — 14:31:49</span>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {Object.entries(ECB_TYPES).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: v.color, opacity: 0.8 }} />
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{v.label}</span>
          </div>
        ))}
      </div>
      <div style={{ position: 'relative', paddingLeft: 28 }}>
        <div style={{ position: 'absolute', left: 12, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.06)' }} />
        {ECB_DATA.map((ev, i) => {
          const t = ECB_TYPES[ev.type] || { color: '#fff', label: ev.type }
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          return (
            <div key={i} style={{ position: 'relative', marginBottom: 10, opacity: op, transform: `translateY(${lerp(f, i * 3, i * 3 + 6, 8, 0)}px)` }}>
              <div style={{ position: 'absolute', left: -22, top: 10, width: 8, height: 8, borderRadius: '50%', background: t.color, opacity: 0.8, boxShadow: `0 0 6px ${t.color}44` }} />
              <div style={{ position: 'absolute', left: -14, top: 13, width: 14, height: 1, background: `${t.color}44` }} />
              <GP style={{ padding: '10px 14px', borderTopColor: `${t.color}30` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <span style={{ fontFamily: M, fontSize: 9, padding: '2px 8px', borderRadius: 4, background: `${t.color}18`, color: t.color, fontWeight: 600 }}>{t.label}</span>
                  <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{ev.ts}</span>
                </div>
                <div style={{ fontFamily: F, fontSize: 12, color: '#fff', marginBottom: 5, lineHeight: 1.4 }}>{ev.content}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>
                  <span>Actor: {ev.actor}</span>
                </div>
              </GP>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 2. DELEGATION RADAR
// ═══════════════════════════════════════════════════════════════
const DR_AGENTS = [
  { id: 'sentinel', name: 'WARDEN', score: 87, color: '#10b981', signals: { mention: 50, capability: 10, tool: 5, workflow: 14, domain: 8 } },
  { id: 'cipher', name: 'CIPHER', score: 72, color: '#f59e0b', signals: { mention: 0, capability: 15, tool: 12, workflow: 20, domain: 25 } },
  { id: 'forge', name: 'VULCAN', score: 38, color: '#3b82f6', signals: { mention: 0, capability: 8, tool: 15, workflow: 10, domain: 5 } },
  { id: 'atlas', name: 'HYPERION', score: 31, color: '#8b5cf6', signals: { mention: 0, capability: 5, tool: 6, workflow: 10, domain: 10 } },
  { id: 'meshnet', name: 'MESHNET', score: 44, color: '#06b6d4', signals: { mention: 0, capability: 5, tool: 12, workflow: 12, domain: 15 } },
  { id: 'netwatch', name: 'NETWATCH', score: 52, color: '#ec4899', signals: { mention: 0, capability: 8, tool: 10, workflow: 14, domain: 20 } },
  { id: 'codex', name: 'CODEX', score: 25, color: '#6366f1', signals: { mention: 0, capability: 10, tool: 5, workflow: 5, domain: 5 } },
  { id: 'nova', name: 'DAEDALUS', score: 42, color: '#14b8a6', signals: { mention: 0, capability: 12, tool: 8, workflow: 12, domain: 10 } },
]
const DR_SIGNALS = { mention: { label: 'Mention', color: '#38bdf8' }, capability: { label: 'Capability', color: '#10b981' }, tool: { label: 'Tool Match', color: '#f59e0b' }, workflow: { label: 'Workflow', color: '#a855f7' }, domain: { label: 'Domain', color: '#ec4899' } }

export function DelegationRadar() {
  const f = useAnimFrame()
  const size = 320, r = size / 2, innerR = 25, maxR = r - 40
  const sorted = [...DR_AGENTS].sort((a, b) => b.score - a.score)
  const top = sorted[0], second = sorted[1], gap = top.score - second.score
  const reveal = lerp(f, 0, 20, 0, 1)
  const scoreR = lerp(f, 10, 30, 0, 1)
  const pulse = 0.7 + Math.sin(f * 0.08) * 0.3

  const positions = DR_AGENTS.map((a, i) => {
    const angle = (i / DR_AGENTS.length) * Math.PI * 2 - Math.PI / 2
    const dist = innerR + (a.score / 100) * (maxR - innerR) * scoreR
    return { ...a, angle, x: r + Math.cos(angle) * dist, y: r + Math.sin(angle) * dist, lx: r + Math.cos(angle) * (maxR + 20), ly: r + Math.sin(angle) * (maxR + 20), px: r + Math.cos(angle) * maxR, py: r + Math.sin(angle) * maxR }
  })

  const fillPts = positions.map(a => `${a.x},${a.y}`).join(' ')

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', inset: 0 }}>
          {[25, 50, 75, 100].map((pct, i) => {
            const rr = innerR + (pct / 100) * (maxR - innerR)
            return <g key={i}><circle cx={r} cy={r} r={rr} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={0.8} opacity={reveal} /><text x={r + 4} y={r - rr + 12} fill="rgba(255,255,255,0.6)" fontSize={8} fontFamily={M} opacity={reveal}>{pct}</text></g>
          })}
          {positions.map((a, i) => <line key={i} x1={r} y1={r} x2={a.px} y2={a.py} stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} opacity={reveal} />)}
          <polygon points={fillPts} fill={top.color} opacity={0.1} stroke={top.color} strokeWidth={1.2} strokeOpacity={0.3} />
          {positions.map((a, i) => {
            const isTop = a.id === top.id
            return <circle key={i} cx={a.x} cy={a.y} r={isTop ? 5 : 3} fill={a.color} opacity={isTop ? pulse : 0.7} />
          })}
        </svg>
        {positions.map((a, i) => {
          const isTop = a.id === top.id
          const deg = (a.angle * 180) / Math.PI
          const isRight = deg > -90 && deg < 90
          return <div key={i} style={{ position: 'absolute', left: a.lx, top: a.ly, transform: `translate(${isRight ? '0%' : '-100%'},-50%)`, fontFamily: M, fontSize: isTop ? 10 : 8, color: isTop ? a.color : 'rgba(255,255,255,0.7)', fontWeight: isTop ? 700 : 400, whiteSpace: 'nowrap', opacity: reveal }}>{a.name} <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 8 }}>{Math.round(a.score * scoreR)}</span></div>
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 200, opacity: lerp(f, 15, 30, 0, 1) }}>
        <GP>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>SELECTED AGENT</div>
          <div style={{ fontFamily: F, fontSize: 18, fontWeight: 700, color: top.color }}>{top.name}</div>
          <div style={{ fontFamily: M, fontSize: 12, color: '#fff', marginTop: 2 }}>Score: {Math.round(top.score * scoreR)} / 100</div>
        </GP>
        <GP>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 8 }}>SIGNAL BREAKDOWN</div>
          {Object.entries(top.signals).map(([k, v], si) => {
            const barW = lerp(f, 20 + si * 3, 35 + si * 3, 0, (v / top.score) * 100)
            return <div key={k} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 9, marginBottom: 2 }}>
                <span style={{ color: DR_SIGNALS[k].color }}>{DR_SIGNALS[k].label}</span>
                <span style={{ color: 'rgba(255,255,255,0.7)' }}>+{v}</span>
              </div>
              <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${barW}%`, height: '100%', borderRadius: 2, background: DR_SIGNALS[k].color, opacity: 0.7 }} />
              </div>
            </div>
          })}
        </GP>
        <GP style={{ borderTopColor: 'rgba(249,115,22,0.3)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>CONFIDENCE GAP</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: F, fontSize: 24, fontWeight: 700, color: '#f59e0b' }}>{Math.round(gap * scoreR)}</span>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>pts between {top.name} and {second.name}</span>
          </div>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 3. SWIMLANE DIAGRAM
// ═══════════════════════════════════════════════════════════════
const SL_LANES = [
  { name: 'CommanderQ', color: '#06b6d4', runs: [{ start: 0, end: 15, label: 'Triage', status: 'success' }, { start: 35, end: 55, label: 'Synthesize', status: 'success' }] },
  { name: 'WARDEN', color: '#22c55e', runs: [{ start: 12, end: 30, label: 'Scan network', status: 'success' }] },
  { name: 'DAEDALUS', color: '#a855f7', runs: [{ start: 18, end: 38, label: 'Analyze logs', status: 'warning' }, { start: 42, end: 58, label: 'Generate report', status: 'success' }] },
  { name: 'CIPHER', color: '#f59e0b', runs: [{ start: 28, end: 44, label: 'Decrypt payload', status: 'error' }] },
]
const SL_HANDOFFS = [
  { from: 0, to: 1, time: 12, label: 'delegate scan' },
  { from: 1, to: 2, time: 18, label: 'pass findings' },
  { from: 2, to: 3, time: 28, label: 'decrypt request' },
]

export function SwimlaneDiagram() {
  const f = useAnimFrame()
  const total = 60, laneH = 50, labelW = 100, w = 700, h = SL_LANES.length * laneH + 60
  const timeW = w - labelW - 10
  const tx = t => labelW + (t / total) * timeW
  const ly = i => 30 + i * laneH + laneH / 2
  const sweepX = lerp(f, 0, 50, 0, total)

  return (
    <div style={{ position: 'relative', width: w, height: h }}>
      <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }}>
        {Array.from({ length: 7 }, (_, i) => {
          const t = (total / 6) * i, x = tx(t)
          return <g key={i}><line x1={x} y1={20} x2={x} y2={h - 20} stroke="rgba(255,255,255,0.06)" /><text x={x} y={16} fill="rgba(255,255,255,0.7)" fontSize={9} fontFamily="monospace" textAnchor="middle">{Math.round(t)}s</text></g>
        })}
        {SL_LANES.map((lane, li) => {
          const y = ly(li)
          return <g key={li}><line x1={labelW - 10} y1={y + laneH / 2} x2={w - 10} y2={y + laneH / 2} stroke="rgba(255,255,255,0.04)" /><text x={8} y={y + 4} fill={lane.color} fillOpacity={0.9} fontSize={11} fontFamily="monospace" fontWeight={600}>{lane.name}</text></g>
        })}
        {SL_LANES.map((lane, li) => lane.runs.map((run, ri) => {
          const x1 = tx(run.start), x2 = tx(run.end), y = ly(li)
          const reveal = lerp(sweepX, run.start, run.end, 0, 1)
          const bw = (x2 - x1) * reveal
          return <g key={`${li}-${ri}`}><rect x={x1} y={y - 10} width={bw} height={20} rx={4} fill={lane.color} fillOpacity={0.2} stroke={lane.color} strokeOpacity={0.4} strokeWidth={1} />{reveal > 0.3 && <text x={x1 + 6} y={y + 4} fill="#fff" fontSize={9} fontFamily="monospace" opacity={lerp(reveal, 0.3, 0.6, 0, 1)}>{run.label}</text>}{run.status === 'error' && reveal > 0.8 && <circle cx={x1 + bw - 10} cy={y} r={3} fill="#ef4444" fillOpacity={0.8 + Math.sin(f * 0.15) * 0.2} />}</g>
        }))}
        {SL_HANDOFFS.map((ho, hi) => {
          const x = tx(ho.time), y1 = ly(ho.from), y2 = ly(ho.to)
          const visible = sweepX >= ho.time
          if (!visible) return null
          const dir = y2 > y1 ? 1 : -1, co = 20 * dir
          return <g key={hi} opacity={0.7}><path d={`M ${x} ${y1} C ${x + co} ${y1},${x + co} ${y2},${x} ${y2}`} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={1.5} strokeDasharray="4 3" /><polygon points={`${x},${y2} ${x - 3},${y2 - 5 * dir} ${x + 3},${y2 - 5 * dir}`} fill="rgba(255,255,255,0.7)" />{ho.label && <text x={x + co + 4} y={(y1 + y2) / 2 + 3} fill="rgba(255,255,255,0.7)" fontSize={8} fontFamily="monospace">{ho.label}</text>}</g>
        })}
        {sweepX < total && <line x1={tx(sweepX)} y1={20} x2={tx(sweepX)} y2={h - 20} stroke="rgba(6,182,212,0.3)" strokeWidth={1} />}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 4. SANKEY FLOW
// ═══════════════════════════════════════════════════════════════
const SK_NODES = [
  { id: 'query', label: 'User Query', color: '#38bdf8', value: 4200, col: 0 },
  { id: 'aocl', label: 'AOCL Layers', color: '#a78bfa', value: 3100, col: 1 },
  { id: 'memory', label: 'Memory', color: '#34d399', value: 800, col: 1 },
  { id: 'tools', label: 'Tools', color: '#f59e0b', value: 1400, col: 1 },
  { id: 'response', label: 'Response', color: '#6366f1', value: 2800, col: 2 },
  { id: 'volt', label: 'VOLT Record', color: '#ec4899', value: 900, col: 2 },
  { id: 'evidence', label: 'Evidence', color: '#22d3ee', value: 500, col: 2 },
]
const SK_FLOWS = [
  { from: 'query', to: 'aocl', value: 3100 }, { from: 'query', to: 'memory', value: 800 }, { from: 'query', to: 'tools', value: 300 },
  { from: 'aocl', to: 'response', value: 2000 }, { from: 'aocl', to: 'tools', value: 1100 },
  { from: 'memory', to: 'response', value: 500 }, { from: 'memory', to: 'evidence', value: 300 },
  { from: 'tools', to: 'response', value: 300 }, { from: 'tools', to: 'volt', value: 900 }, { from: 'tools', to: 'evidence', value: 200 },
]

export function SankeyFlow() {
  const f = useAnimFrame()
  const w = 650, h = 380, pad = 50, nodeW = 110, nodeH = 32
  const colX = [pad + 50, w / 2, w - pad - 50]
  const colGroups = [[], [], []]
  SK_NODES.forEach(n => colGroups[n.col].push(n))

  const positions = {}
  colGroups.forEach((group, ci) => {
    const totalH = group.length * nodeH + (group.length - 1) * 20
    const startY = (h - totalH) / 2
    group.forEach((n, i) => { positions[n.id] = { x: colX[ci], y: startY + i * (nodeH + 20), color: n.color, label: n.label, value: n.value } })
  })

  const outOff = {}, inOff = {}
  SK_NODES.forEach(n => { outOff[n.id] = 0; inOff[n.id] = 0 })
  const maxV = Math.max(...SK_FLOWS.map(f => f.value), 1)

  const nodeOp = lerp(f, 0, 10, 0, 1)

  return (
    <div style={{ position: 'relative', width: w, height: h }}>
      <div style={{ position: 'absolute', top: 10, left: 16, fontFamily: F, fontSize: 12, color: '#fff', letterSpacing: 1.5, textTransform: 'uppercase', opacity: nodeOp }}>Token Flow — Sankey</div>
      <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }}>
        {SK_FLOWS.map((fl, i) => {
          const src = positions[fl.from], dst = positions[fl.to]
          if (!src || !dst) return null
          const bandW = Math.max(2, (fl.value / maxV) * 24)
          const sx = src.x + nodeW / 2 + 10, sy = src.y + nodeH / 2 + outOff[fl.from]
          const dx = dst.x - nodeW / 2 - 10, dy = dst.y + nodeH / 2 + inOff[fl.to]
          outOff[fl.from] += bandW * 0.35
          inOff[fl.to] += bandW * 0.35
          const cx = (sx + dx) / 2
          const draw = lerp(f, 5 + i * 4, 25 + i * 4, 0, 1)
          return <g key={i}><path d={`M ${sx} ${sy} C ${cx} ${sy},${cx} ${dy},${dx} ${dy}`} fill="none" stroke={src.color} strokeWidth={bandW} strokeOpacity={0.25} strokeLinecap="round" strokeDasharray={800} strokeDashoffset={800 * (1 - draw)} /><path d={`M ${sx} ${sy} C ${cx} ${sy},${cx} ${dy},${dx} ${dy}`} fill="none" stroke={src.color} strokeWidth={Math.max(1, bandW * 0.2)} strokeOpacity={0.6} strokeLinecap="round" strokeDasharray={800} strokeDashoffset={800 * (1 - draw)} /></g>
        })}
        {Object.entries(positions).map(([id, p]) => (
          <g key={id} opacity={nodeOp} transform={`translate(${p.x},${p.y})`}>
            <rect x={-nodeW / 2} y={0} width={nodeW} height={nodeH} rx={6} fill={`${p.color}18`} stroke={p.color} strokeWidth={1.5} />
            <text x={0} y={nodeH / 2 - 1} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontFamily={F} fontSize={11} fontWeight={500}>{p.label}</text>
            <text x={0} y={nodeH + 14} textAnchor="middle" fill={p.color} fontFamily={M} fontSize={10} opacity={0.9}>{p.value.toLocaleString()}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 5. TRACE WATERFALL
// ═══════════════════════════════════════════════════════════════
const TW_LAYERS = [
  { id: 'L0', name: 'INGRESS', color: '#64748b', ms: 2, skip: false },
  { id: 'L1', name: 'IDENTITY', color: '#3b82f6', ms: 0, skip: true },
  { id: 'L2', name: 'ROUTE', color: '#06b6d4', ms: 15, skip: false },
  { id: 'L3', name: 'POLICY', color: '#f59e0b', ms: 42, skip: false },
  { id: 'L4', name: 'PLAN', color: '#a855f7', ms: 0, skip: true },
  { id: 'L5', name: 'CONTEXT', color: '#8b5cf6', ms: 120, skip: false },
  { id: 'L6', name: 'SHAPE', color: '#6366f1', ms: 0, skip: true },
  { id: 'L7', name: 'DELEGATE', color: '#f97316', ms: 1890, skip: false },
  { id: 'L8', name: 'VERIFY', color: '#14b8a6', ms: 15, skip: false },
  { id: 'L9', name: 'ASSEMBLE', color: '#22c55e', ms: 22, skip: false },
  { id: 'L10', name: 'AUDIT', color: '#64748b', ms: 18, skip: false },
]

export function TraceWaterfall() {
  const f = useAnimFrame()
  const totalMs = 2300, labelW = 110, rowH = 28, gap = 4

  let cursor = 0
  const timeline = TW_LAYERS.map(l => { const s = cursor; cursor += l.ms; return { ...l, startMs: s } })

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>AOCL Trace Waterfall</div>
      {timeline.map((l, i) => {
        const op = lerp(f, i * 3, i * 3 + 6, 0, 1)
        const barScale = lerp(f, i * 3 + 2, i * 3 + 10, 0, 1)
        const barLeft = `${(l.startMs / totalMs) * 100}%`
        const barW = `${Math.max((l.ms / totalMs) * 100, 0) * barScale}%`
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', height: rowH, marginBottom: gap, opacity: op }}>
            <div style={{ width: labelW, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: l.color, opacity: l.skip ? 0.6 : 0.9, width: 26, textAlign: 'right' }}>{l.id}</span>
              <span style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: l.skip ? 'rgba(255,255,255,0.6)' : '#fff' }}>{l.name}</span>
            </div>
            <div style={{ position: 'relative', flex: 1, height: '100%', background: 'rgba(255,255,255,0.02)', borderRadius: 4 }}>
              {!l.skip && <div style={{ position: 'absolute', left: barLeft, top: 3, width: barW, height: rowH - 6, borderRadius: 4, background: `linear-gradient(90deg,${l.color}cc,${l.color}88)`, overflow: 'hidden' }}><div style={{ position: 'absolute', inset: 0, background: `radial-gradient(ellipse at 20% 50%,${l.color}40 0%,transparent 70%)` }} /></div>}
              {l.skip && <div style={{ position: 'absolute', left: barLeft, top: rowH / 2 - 1, width: 16, height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.1)' }} />}
              {!l.skip && barScale > 0.8 && <div style={{ position: 'absolute', left: `calc(${barLeft} + ${barW} + 6px)`, top: rowH / 2 - 7, fontFamily: M, fontSize: 10, fontWeight: 600, color: l.color, whiteSpace: 'nowrap' }}>{l.ms}ms</div>}
              {l.skip && <div style={{ position: 'absolute', left: `calc(${barLeft} + 22px)`, top: rowH / 2 - 7, fontFamily: M, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase' }}>skip</div>}
            </div>
          </div>
        )
      })}
      <div style={{ marginLeft: labelW, display: 'flex', justifyContent: 'space-between', marginTop: 6, fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>
        {[0, 460, 920, 1380, 1840, 2300].map(ms => <span key={ms}>{ms}ms</span>)}
      </div>
      <div style={{ textAlign: 'right', fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>total: {TW_LAYERS.reduce((s, l) => s + l.ms, 0)}ms</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 6. LAYER HEALTH MATRIX
// ═══════════════════════════════════════════════════════════════
const LHM_LAYERS = [
  { idx: 0, name: 'INGEST', color: '#64748b' }, { idx: 1, name: 'PARSE', color: '#3b82f6' },
  { idx: 2, name: 'VALIDATE', color: '#06b6d4' }, { idx: 3, name: 'CLASSIFY', color: '#f59e0b' },
  { idx: 4, name: 'ROUTE', color: '#a855f7' }, { idx: 5, name: 'ENRICH', color: '#8b5cf6' },
  { idx: 6, name: 'TRANSFORM', color: '#6366f1' }, { idx: 7, name: 'DELEGATE', color: '#f97316' },
  { idx: 8, name: 'EXECUTE', color: '#14b8a6' }, { idx: 9, name: 'RESPOND', color: '#22c55e' },
  { idx: 10, name: 'AUDIT', color: '#64748b' },
]
const LHM_SLOTS = Array.from({ length: 12 }, (_, h) => ({
  label: `${String(h).padStart(2, '0')}:00`,
  data: LHM_LAYERS.map(l => {
    const bad = l.idx === 7 && h >= 4 && h <= 6
    return { layerIdx: l.idx, errorRate: bad ? 0.2 + Math.random() * 0.15 : 0.01 + Math.random() * 0.04 }
  })
}))

export function LayerHealthMatrix() {
  const f = useAnimFrame()
  const cellW = 40, cellH = 24
  const hColor = er => er < 0.05 ? '#22c55e' : er < 0.15 ? '#f59e0b' : '#ef4444'
  const hOp = er => 0.3 + Math.min(er * 4, 0.7)

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', letterSpacing: 1, marginBottom: 4 }}>AOCL LAYER HEALTH MATRIX</div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 14, fontFamily: M }}>HEATMAP — 12 TIME SLOTS — 11 LAYERS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', marginLeft: 90 }}>
          {LHM_SLOTS.map((s, si) => <div key={si} style={{ width: cellW, textAlign: 'center', fontSize: 9, color: 'rgba(255,255,255,0.7)', fontFamily: M, opacity: lerp(f, si, si + 4, 0, 1) }}>{s.label}</div>)}
        </div>
        {LHM_LAYERS.map((layer, li) => (
          <div key={li} style={{ display: 'flex', alignItems: 'center', opacity: lerp(f, li * 2, li * 2 + 6, 0, 1) }}>
            <div style={{ width: 85, fontSize: 10, color: layer.color, fontFamily: M, textAlign: 'right', paddingRight: 5, fontWeight: 600 }}>L{layer.idx} {layer.name}</div>
            {LHM_SLOTS.map((slot, si) => {
              const d = slot.data.find(x => x.layerIdx === layer.idx) || { errorRate: 0 }
              return <div key={si} style={{ width: cellW - 2, height: cellH, margin: '0 1px', backgroundColor: hColor(d.errorRate), opacity: lerp(f, li * 2 + si, li * 2 + si + 4, 0, hOp(d.errorRate)), borderRadius: 2 }} />
            })}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, marginLeft: 90, marginTop: 10 }}>
        {[{ l: 'Healthy (<5%)', c: '#22c55e' }, { l: 'Degraded (5-15%)', c: '#f59e0b' }, { l: 'Failing (>15%)', c: '#ef4444' }].map(x => (
          <div key={x.l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 10, backgroundColor: x.c, borderRadius: 2, opacity: 0.7 }} />
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', fontFamily: M }}>{x.l}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 7. GAUGE CLUSTER
// ═══════════════════════════════════════════════════════════════
const GC_GAUGES = [
  { label: 'CPU', value: 23, max: 100, unit: '%', color: '#22c55e' },
  { label: 'MEM', value: 62, max: 100, unit: '%', color: '#f59e0b' },
  { label: 'Disk', value: 45, max: 100, unit: '%', color: '#22c55e' },
  { label: 'Network', value: 12, max: 100, unit: 'Mb/s', color: '#38bdf8' },
  { label: 'IOPS', value: 842, max: 2000, unit: '', color: '#a78bfa' },
]

function SingleGauge({ label, value, max, unit, color, size, delay = 0 }) {
  const f = useAnimFrame()
  const pct = Math.min(value / max, 1)
  const animPct = lerp(f, 3 + delay, 20 + delay, 0, pct)
  const r = (size - 12) / 2, circ = 2 * Math.PI * r
  const arcLen = (270 / 360) * circ, filled = arcLen * animPct
  const cx = size / 2, cy = size / 2
  const displayColor = pct < 0.6 ? '#22c55e' : pct < 0.85 ? '#f59e0b' : '#ef4444'
  const c = color || displayColor

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={8} strokeDasharray={`${arcLen} ${circ - arcLen}`} strokeLinecap="round" transform={`rotate(135 ${cx} ${cy})`} />
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth={8} strokeDasharray={`${filled} ${circ - filled}`} strokeLinecap="round" transform={`rotate(135 ${cx} ${cy})`} opacity={0.9} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: M, fontSize: size * 0.22, fontWeight: 700, color: '#fff', lineHeight: 1 }}>{Math.round(animPct * max)}</span>
          {unit && <span style={{ fontFamily: M, fontSize: size * 0.1, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>{unit}</span>}
        </div>
      </div>
      <span style={{ fontFamily: F, fontSize: Math.max(10, size * 0.09), color: 'rgba(255,255,255,0.8)', letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
    </div>
  )
}

export function GaugeCluster() {
  const big = GC_GAUGES[0], smalls = GC_GAUGES.slice(1, 5)
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 30, padding: '10px 0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        {smalls.slice(0, 2).map((g, i) => <SingleGauge key={g.label} {...g} size={100} delay={i * 4 + 4} />)}
      </div>
      <SingleGauge {...big} size={180} delay={0} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        {smalls.slice(2, 4).map((g, i) => <SingleGauge key={g.label} {...g} size={100} delay={i * 4 + 10} />)}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 8. ESCALATION LADDER
// ═══════════════════════════════════════════════════════════════
const EL_STAGES = [
  { time: 't+0', label: 'Assigned Team', action: 'Notified dev-team-2 via Slack', status: 'complete' },
  { time: 't+10m', label: 'Re-notify', action: 'Second notification sent with urgency bump', status: 'complete' },
  { time: 't+30m', label: 'Dept Admin', action: 'Escalating to department admin...', status: 'active' },
  { time: 't+60m', label: 'Org Admin', action: 'Notify organisation administrator', status: 'pending' },
  { time: 't+4h', label: 'Auto-action', action: 'Execute fallback policy FA-012', status: 'pending' },
]
const EL_COLORS = { complete: '#10b981', active: '#3b82f6', pending: 'rgba(255,255,255,0.6)' }

export function EscalationLadder() {
  const f = useAnimFrame()
  const currentStage = 2
  return (
    <GP style={{ maxWidth: 400 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 10, fontFamily: M, color: '#f59e0b', letterSpacing: 2, fontWeight: 700 }}>ESCALATION LADDER</span>
        <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.7)' }}>Stage {currentStage + 1}/{EL_STAGES.length}</span>
      </div>
      {EL_STAGES.map((stage, idx) => {
        const isComplete = stage.status === 'complete'
        const isActive = idx === currentStage
        const isPending = !isComplete && !isActive
        const sc = isComplete ? EL_COLORS.complete : isActive ? EL_COLORS.active : EL_COLORS.pending
        const op = lerp(f, idx * 3, idx * 3 + 6, 0, 1)
        const pulseOp = isActive ? 0.5 + Math.sin(f * 0.12) * 0.5 : 1
        const isLast = idx === EL_STAGES.length - 1
        return (
          <div key={idx} style={{ display: 'flex', gap: 10, opacity: op }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 20, flexShrink: 0 }}>
              <div style={{ width: isActive ? 14 : 10, height: isActive ? 14 : 10, borderRadius: '50%', backgroundColor: isComplete ? sc : 'transparent', border: `2px solid ${sc}`, opacity: pulseOp, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                {isComplete && <span style={{ fontSize: 7, color: '#06070c', fontWeight: 700 }}>✓</span>}
              </div>
              {!isLast && <div style={{ width: 2, flex: 1, minHeight: 24, background: isComplete ? `${EL_COLORS.complete}60` : 'rgba(255,255,255,0.08)' }} />}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 12, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10, fontFamily: M, fontWeight: 700, color: sc }}>{stage.time}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: isPending ? 'rgba(255,255,255,0.6)' : '#fff' }}>{stage.label}</span>
              </div>
              <div style={{ fontSize: 11, color: isPending ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.8)', marginTop: 3, lineHeight: 1.4 }}>{stage.action}</div>
            </div>
          </div>
        )
      })}
    </GP>
  )
}

// ═══════════════════════════════════════════════════════════════
// 9. NEURAL NETWORK
// ═══════════════════════════════════════════════════════════════
function seededRandom(seed) {
  let s = seed
  return () => { s = (s * 16807 + 0) % 2147483647; return (s - 1) / 2147483646 }
}

const NN_COLORS = ['#38bdf8', '#6366f1', '#a855f7', '#06b6d4', '#30ff90']

export function NeuralNetwork() {
  const f = useAnimFrame()
  const w = '100%', h = 350
  const rng = seededRandom(42)
  const particles = Array.from({ length: 25 }, (_, i) => ({
    id: i,
    x: rng() * 600,
    y: rng() * 320,
    r: 3 + rng() * 4,
    color: NN_COLORS[i % NN_COLORS.length],
    speed: 0.3 + rng() * 0.7,
    phase: rng() * Math.PI * 2,
  }))

  const getPos = (p) => ({
    x: p.x + Math.sin(f * 0.02 * p.speed + p.phase) * 20,
    y: p.y + Math.cos(f * 0.015 * p.speed + p.phase * 1.3) * 15,
  })

  const positions = particles.map(getPos)
  const reveal = lerp(f, 0, 20, 0, 1)

  const connections = []
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = positions[i].x - positions[j].x
      const dy = positions[i].y - positions[j].y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 200) {
        connections.push({ i, j, dist })
      }
    }
  }

  return (
    <div style={{ width: w, height: h, position: 'relative' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' }}>Neural Network — 25 Nodes</div>
      <svg width="100%" height={h - 20} viewBox="0 0 620 330" style={{ opacity: reveal }}>
        <defs>
          {particles.map((p, i) => (
            <radialGradient key={i} id={`nn-g${i}`}>
              <stop offset="0%" stopColor={p.color} stopOpacity={0.9} />
              <stop offset="100%" stopColor={p.color} stopOpacity={0} />
            </radialGradient>
          ))}
        </defs>
        {connections.map((c, ci) => {
          const opacity = Math.max(0, (1 - c.dist / 200) * 0.4)
          return (
            <line key={ci} x1={positions[c.i].x} y1={positions[c.i].y} x2={positions[c.j].x} y2={positions[c.j].y}
              stroke={particles[c.i].color} strokeWidth={1} strokeOpacity={opacity} />
          )
        })}
        {particles.map((p, i) => {
          const pos = positions[i]
          const pulse = 0.6 + Math.sin(f * 0.08 + p.phase) * 0.4
          return (
            <g key={i}>
              <circle cx={pos.x} cy={pos.y} r={p.r * 3} fill={`url(#nn-g${i})`} opacity={0.3 * pulse} />
              <circle cx={pos.x} cy={pos.y} r={p.r} fill={p.color} opacity={0.8 * pulse} />
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 10. RADAR SWEEP
// ═══════════════════════════════════════════════════════════════
const RS_BLIPS = [
  { name: 'edge-01', angle: 30, dist: 0.4, color: '#30ff90' },
  { name: 'edge-02', angle: 75, dist: 0.5, color: '#30ff90' },
  { name: 'edge-03', angle: 120, dist: 0.55, color: '#30ff90' },
  { name: 'edge-04', angle: 160, dist: 0.65, color: '#30ff90' },
  { name: 'hyp-01', angle: 210, dist: 0.7, color: '#f59e0b' },
  { name: 'hyp-02', angle: 250, dist: 0.75, color: '#f59e0b' },
  { name: 'hyp-03', angle: 290, dist: 0.8, color: '#f59e0b' },
  { name: 'gw-01', angle: 350, dist: 0.3, color: '#38bdf8' },
]

export function RadarSweep() {
  const f = useAnimFrame()
  const size = 320, cx = size / 2, cy = size / 2, maxR = size / 2 - 30
  const sweepAngle = (f * 3) % 360
  const sweepRad = (sweepAngle * Math.PI) / 180
  const reveal = lerp(f, 0, 15, 0, 1)

  const trailDots = Array.from({ length: 30 }, (_, i) => {
    const a = ((sweepAngle - i * 3 + 360) % 360) * Math.PI / 180
    const d = maxR * (0.2 + (i / 30) * 0.7)
    return { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, op: (1 - i / 30) * 0.4 }
  })

  return (
    <div style={{ width: size, height: size, position: 'relative' }}>
      <svg width={size} height={size} style={{ opacity: reveal }}>
        {/* Range rings */}
        {[0.25, 0.5, 0.75, 1.0].map((pct, i) => (
          <circle key={i} cx={cx} cy={cy} r={maxR * pct} fill="none" stroke="#30ff9015" strokeWidth={1} />
        ))}
        {/* Cross hair */}
        <line x1={cx} y1={cy - maxR} x2={cx} y2={cy + maxR} stroke="#30ff9010" strokeWidth={1} />
        <line x1={cx - maxR} y1={cy} x2={cx + maxR} y2={cy} stroke="#30ff9010" strokeWidth={1} />
        {/* Sweep line */}
        <line x1={cx} y1={cy}
          x2={cx + Math.cos(sweepRad) * maxR}
          y2={cy + Math.sin(sweepRad) * maxR}
          stroke="#30ff90" strokeWidth={2} strokeOpacity={0.7} />
        {/* Sweep trail dots */}
        {trailDots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={1.5} fill="#30ff90" opacity={d.op} />
        ))}
        {/* Blips */}
        {RS_BLIPS.map((blip, i) => {
          const a = (blip.angle * Math.PI) / 180
          const bx = cx + Math.cos(a) * maxR * blip.dist
          const by = cy + Math.sin(a) * maxR * blip.dist
          const angleDiff = Math.abs(((sweepAngle - blip.angle + 360) % 360))
          const swept = angleDiff < 30
          const brightness = swept ? 1 : 0.4
          return (
            <g key={i}>
              <circle cx={bx} cy={by} r={4} fill={blip.color} opacity={brightness} />
              {swept && <circle cx={bx} cy={by} r={8} fill="none" stroke={blip.color} strokeWidth={1} opacity={0.4} />}
              <text x={bx + 8} y={by + 3} fill="#fff" fontSize={8} fontFamily={M} opacity={0.8}>{blip.name}</text>
            </g>
          )
        })}
        {/* Center dot */}
        <circle cx={cx} cy={cy} r={3} fill="#30ff90" opacity={0.7 + Math.sin(f * 0.1) * 0.3} />
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 11. TOPOLOGY MAP
// ═══════════════════════════════════════════════════════════════
const TM_ICONS = { server: '▦', firewall: '◈', switch: '◇', cloud: '☁', agent: '⬡', database: '◉', core: '◆' }
const TM_NODES = [
  { id: 'internet', label: 'Internet', type: 'cloud', x: 325, y: 30, color: '#64748b' },
  { id: 'firewall', label: 'Firewall', type: 'firewall', x: 325, y: 100, color: '#ef4444' },
  { id: 'switch', label: 'Switch', type: 'switch', x: 325, y: 180, color: '#f59e0b' },
  { id: 'edge-01', label: 'edge-01', type: 'server', x: 100, y: 280, color: '#30ff90' },
  { id: 'edge-02', label: 'edge-02', type: 'server', x: 280, y: 280, color: '#30ff90' },
  { id: 'edge-03', label: 'edge-03', type: 'server', x: 460, y: 280, color: '#30ff90' },
  { id: 'quoxcore', label: 'QuoxCORE', type: 'core', x: 100, y: 400, color: '#a855f7' },
  { id: 'postgres', label: 'Postgres', type: 'database', x: 280, y: 400, color: '#3b82f6' },
  { id: 'qdrant', label: 'Qdrant', type: 'database', x: 460, y: 400, color: '#06b6d4' },
]
const TM_LINKS = [
  { from: 'internet', to: 'firewall' }, { from: 'firewall', to: 'switch' },
  { from: 'switch', to: 'edge-01' }, { from: 'switch', to: 'edge-02' }, { from: 'switch', to: 'edge-03' },
  { from: 'edge-01', to: 'quoxcore' }, { from: 'edge-02', to: 'postgres' }, { from: 'edge-03', to: 'qdrant' },
  { from: 'quoxcore', to: 'postgres' }, { from: 'quoxcore', to: 'qdrant' },
]

export function TopologyMap() {
  const f = useAnimFrame()
  const w = 650, h = 480
  const nodeMap = {}
  TM_NODES.forEach(n => { nodeMap[n.id] = n })
  const reveal = lerp(f, 0, 20, 0, 1)

  return (
    <div style={{ width: w, height: h, position: 'relative' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' }}>Network Topology</div>
      <svg width={w} height={h} style={{ opacity: reveal }}>
        {/* Links with traffic pulses */}
        {TM_LINKS.map((link, i) => {
          const from = nodeMap[link.from], to = nodeMap[link.to]
          if (!from || !to) return null
          const pulseT = ((f * 0.03 + i * 0.2) % 1)
          const px = from.x + (to.x - from.x) * pulseT
          const py = from.y + (to.y - from.y) * pulseT
          return (
            <g key={i}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="rgba(255,255,255,0.08)" strokeWidth={1.5} />
              <circle cx={px} cy={py} r={2.5} fill={from.color} opacity={0.7} />
            </g>
          )
        })}
        {/* Nodes */}
        {TM_NODES.map((n, i) => {
          const op = lerp(f, i * 2, i * 2 + 8, 0, 1)
          const icon = TM_ICONS[n.type] || '●'
          return (
            <g key={n.id} opacity={op}>
              <rect x={n.x - 30} y={n.y - 18} width={60} height={36} rx={8} fill={`${n.color}15`} stroke={n.color} strokeWidth={1.2} strokeOpacity={0.5} />
              <text x={n.x} y={n.y - 2} textAnchor="middle" fill={n.color} fontSize={16} opacity={0.9}>{icon}</text>
              <text x={n.x} y={n.y + 28} textAnchor="middle" fill="#fff" fontSize={10} fontFamily={M} fontWeight={600}>{n.label}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 12. HEX GRID
// ═══════════════════════════════════════════════════════════════
export function HexGrid() {
  const f = useAnimFrame()
  const cols = 14, rows = 6, hexSize = 24
  const hexW = hexSize * 2, hexH = Math.sqrt(3) * hexSize
  const w = cols * hexW * 0.75 + hexW * 0.25 + 20
  const h = rows * hexH + hexH * 0.5 + 20
  const reveal = lerp(f, 0, 15, 0, 1)

  const hexPoints = (cx, cy) => {
    const pts = []
    for (let a = 0; a < 6; a++) {
      const angle = (Math.PI / 3) * a - Math.PI / 6
      pts.push(`${cx + hexSize * Math.cos(angle)},${cy + hexSize * Math.sin(angle)}`)
    }
    return pts.join(' ')
  }

  const hexes = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = 10 + c * hexW * 0.75 + hexSize
      const cy = 10 + r * hexH + (c % 2 === 1 ? hexH / 2 : 0) + hexSize
      const dist = Math.sqrt((c - cols / 2) ** 2 + (r - rows / 2) ** 2)
      const wavePhase = dist * 0.5 - f * 0.08
      const active = Math.sin(wavePhase) > 0.3
      hexes.push({ cx, cy, active, dist, r, c })
    }
  }

  return (
    <div style={{ width: w, height: h, position: 'relative' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' }}>Hex Grid — Wave Pattern</div>
      <svg width={w} height={h} style={{ opacity: reveal }}>
        {hexes.map((hex, i) => {
          const stagger = lerp(f, hex.dist * 1.5, hex.dist * 1.5 + 8, 0, 1)
          return (
            <polygon key={i} points={hexPoints(hex.cx, hex.cy)}
              fill={hex.active ? '#a855f720' : '#06b6d408'}
              stroke={hex.active ? '#a855f7' : '#06b6d4'}
              strokeWidth={hex.active ? 1.2 : 0.5}
              strokeOpacity={hex.active ? 0.6 : 0.15}
              opacity={stagger} />
          )
        })}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 13. WORLD MAP
// ═══════════════════════════════════════════════════════════════
const WM_MARKERS = [
  { name: 'London', lat: 51.5, lon: -0.13, color: '#38bdf8' },
  { name: 'New York', lat: 40.7, lon: -74.0, color: '#a855f7' },
  { name: 'Paris', lat: 48.9, lon: 2.35, color: '#6366f1' },
  { name: 'Tokyo', lat: 35.7, lon: 139.7, color: '#30ff90' },
  { name: 'Sydney', lat: -33.9, lon: 151.2, color: '#f59e0b' },
  { name: 'Singapore', lat: 1.35, lon: 103.8, color: '#06b6d4' },
]
const WM_CONNECTIONS = [
  [0, 1], [0, 2], [0, 3], [1, 4], [3, 5], [2, 5],
]

function mercator(lat, lon, w, h) {
  const x = ((lon + 180) / 360) * w
  const latRad = (lat * Math.PI) / 180
  const y = h / 2 - (Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) * (h / 2) * 0.8
  return { x, y }
}

export function WorldMap() {
  const f = useAnimFrame()
  const w = 600, h = 300
  const reveal = lerp(f, 0, 15, 0, 1)

  // Approximate landmass dots
  const rng = seededRandom(99)
  const landDots = []
  const landAreas = [
    { latMin: 35, latMax: 70, lonMin: -10, lonMax: 40 },   // Europe
    { latMin: 25, latMax: 50, lonMin: -130, lonMax: -60 },  // N America
    { latMin: -35, latMax: 5, lonMin: -80, lonMax: -35 },   // S America
    { latMin: -10, latMax: 35, lonMin: 60, lonMax: 145 },   // Asia
    { latMin: -35, latMax: 10, lonMin: 10, lonMax: 50 },    // Africa
    { latMin: -45, latMax: -10, lonMin: 110, lonMax: 155 },  // Australia
  ]
  landAreas.forEach(area => {
    for (let i = 0; i < 30; i++) {
      const lat = area.latMin + rng() * (area.latMax - area.latMin)
      const lon = area.lonMin + rng() * (area.lonMax - area.lonMin)
      landDots.push(mercator(lat, lon, w, h))
    }
  })

  const markerPos = WM_MARKERS.map(m => ({ ...m, ...mercator(m.lat, m.lon, w, h) }))

  return (
    <div style={{ width: w, height: h, position: 'relative' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' }}>Global Presence</div>
      <svg width={w} height={h} style={{ opacity: reveal }}>
        {/* Land dots */}
        {landDots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={1.2} fill="rgba(255,255,255,0.1)" />
        ))}
        {/* Connections with curved arcs */}
        {WM_CONNECTIONS.map(([ai, bi], ci) => {
          const a = markerPos[ai], b = markerPos[bi]
          const mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - 30 - Math.abs(a.x - b.x) * 0.08
          const pulseT = ((f * 0.02 + ci * 0.3) % 1)
          const t = pulseT
          const px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * b.x
          const py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * my + t * t * b.y
          const lineOp = lerp(f, ci * 3, ci * 3 + 10, 0, 0.3)
          return (
            <g key={ci}>
              <path d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`} fill="none" stroke={a.color} strokeWidth={1} strokeOpacity={lineOp} />
              <circle cx={px} cy={py} r={2.5} fill={a.color} opacity={0.8} />
            </g>
          )
        })}
        {/* Markers */}
        {markerPos.map((m, i) => {
          const pulse = 0.6 + Math.sin(f * 0.1 + i) * 0.4
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          return (
            <g key={i} opacity={op}>
              <circle cx={m.x} cy={m.y} r={6} fill={m.color} opacity={0.2 * pulse} />
              <circle cx={m.x} cy={m.y} r={3} fill={m.color} opacity={0.8} />
              <text x={m.x} y={m.y - 10} textAnchor="middle" fill="#fff" fontSize={9} fontFamily={M} fontWeight={600}>{m.name}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 14. OSCILLOSCOPE
// ═══════════════════════════════════════════════════════════════
const OSC_CHANNELS = [
  { label: 'CPU', color: '#30ff90', freq: 0.08, amp: 40, noise: 8 },
  { label: 'Memory', color: '#06b6d4', freq: 0.04, amp: 30, noise: 5 },
  { label: 'Network', color: '#a855f7', freq: 0.12, amp: 25, noise: 12 },
]

export function Oscilloscope() {
  const f = useAnimFrame()
  const w = 600, h = 280, padY = 30, padX = 50
  const plotW = w - padX * 2, plotH = h - padY * 2
  const reveal = lerp(f, 0, 15, 0, 1)

  const rng = seededRandom(77 + f)

  return (
    <div style={{ width: w, height: h, position: 'relative' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' }}>Oscilloscope — 3 Channels</div>
      <svg width={w} height={h} style={{ opacity: reveal }}>
        {/* Grid */}
        {Array.from({ length: 9 }, (_, i) => {
          const x = padX + (plotW / 8) * i
          return <line key={`v${i}`} x1={x} y1={padY} x2={x} y2={h - padY} stroke="rgba(255,255,255,0.05)" strokeWidth={0.5} />
        })}
        {Array.from({ length: 7 }, (_, i) => {
          const y = padY + (plotH / 6) * i
          return <line key={`h${i}`} x1={padX} y1={y} x2={w - padX} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth={0.5} />
        })}
        {/* Border */}
        <rect x={padX} y={padY} width={plotW} height={plotH} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
        {/* Channels */}
        {OSC_CHANNELS.map((ch, ci) => {
          const baseY = padY + plotH * (0.25 + ci * 0.25)
          const rngCh = seededRandom(ci * 1000 + f)
          const points = Array.from({ length: 100 }, (_, xi) => {
            const x = padX + (xi / 99) * plotW
            const t = xi * ch.freq + f * 0.05
            const y = baseY + Math.sin(t) * ch.amp + Math.sin(t * 2.7) * ch.amp * 0.3 + (rngCh() - 0.5) * ch.noise
            return `${x},${y}`
          }).join(' ')
          return (
            <g key={ci}>
              <polyline points={points} fill="none" stroke={ch.color} strokeWidth={1.5} strokeOpacity={0.8} />
              <text x={padX - 6} y={baseY + 4} textAnchor="end" fill={ch.color} fontSize={9} fontFamily={M} fontWeight={600}>{ch.label}</text>
            </g>
          )
        })}
        {/* Time axis labels */}
        {Array.from({ length: 5 }, (_, i) => (
          <text key={i} x={padX + (plotW / 4) * i} y={h - 8} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize={8} fontFamily={M}>{(i * 250)}ms</text>
        ))}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 15. FLEET HEATMAP
// ═══════════════════════════════════════════════════════════════
const FH_HOSTS = [
  { name: 'edge-01', cpu: 12, role: 'Docker' },
  { name: 'edge-02', cpu: 8, role: 'Docker' },
  { name: 'edge-03', cpu: 65, role: 'Docker' },
  { name: 'edge-04', cpu: 23, role: 'Docker' },
  { name: 'hyp-01', cpu: 82, role: 'Proxmox' },
  { name: 'hyp-02', cpu: 45, role: 'Proxmox' },
  { name: 'hyp-03', cpu: 15, role: 'Proxmox' },
  { name: 'gw-01', cpu: 5, role: 'Bastion' },
  { name: 'nas01', cpu: 30, role: 'NAS' },
  { name: 'kuma01', cpu: 18, role: 'Monitor' },
  { name: 'grafana01', cpu: 42, role: 'Monitor' },
  { name: 'wazuh01', cpu: 55, role: 'SIEM' },
]

export function FleetHeatmap() {
  const f = useAnimFrame()
  const cellSize = 50
  const cols = 4
  const reveal = lerp(f, 0, 15, 0, 1)

  const cpuColor = (cpu) => cpu < 50 ? '#30ff90' : cpu < 80 ? '#f59e0b' : '#ef4444'

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Fleet Heatmap — {FH_HOSTS.length} Hosts</div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8, maxWidth: cols * (cellSize * 2.8 + 8) }}>
        {FH_HOSTS.map((host, i) => {
          const op = lerp(f, i * 2, i * 2 + 8, 0, 1)
          const c = cpuColor(host.cpu)
          // Sparkline data (seeded fake)
          const rng = seededRandom(i * 100)
          const spark = Array.from({ length: 12 }, () => Math.max(5, Math.min(95, host.cpu + (rng() - 0.5) * 30)))
          return (
            <GP key={i} style={{ padding: '8px 10px', borderTopColor: `${c}30`, opacity: op }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: '#fff' }}>{host.name}</span>
                <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: c }}>{host.cpu}%</span>
              </div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.7)', marginBottom: 6 }}>{host.role}</div>
              <svg width="100%" height={20} viewBox="0 0 48 20">
                <polyline points={spark.map((v, si) => `${si * 4},${20 - v * 0.2}`).join(' ')} fill="none" stroke={c} strokeWidth={1.5} opacity={0.8} />
              </svg>
            </GP>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
        {[{ l: '< 50% Normal', c: '#30ff90' }, { l: '50-80% Warning', c: '#f59e0b' }, { l: '> 80% Critical', c: '#ef4444' }].map(x => (
          <div key={x.l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: x.c, opacity: 0.7 }} />
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', fontFamily: M }}>{x.l}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 16. ORG TREE
// ═══════════════════════════════════════════════════════════════
const OT_TREE = {
  name: 'Quox LTD', color: '#a855f7', children: [
    { name: 'Engineering', color: '#38bdf8', children: [
      { name: 'Platform', color: '#06b6d4', children: [{ name: 'Adam', color: '#fff' }, { name: 'VULCAN', color: '#a855f7' }] },
      { name: 'Frontend', color: '#6366f1', children: [{ name: 'CODEX', color: '#6366f1' }] },
    ]},
    { name: 'Operations', color: '#30ff90', children: [
      { name: 'Infra', color: '#f59e0b', children: [{ name: 'WARDEN', color: '#ef4444' }, { name: 'HYPERION', color: '#f59e0b' }] },
      { name: 'DevOps', color: '#14b8a6', children: [{ name: 'MESHNET', color: '#06b6d4' }] },
    ]},
    { name: 'Security', color: '#ef4444', children: [
      { name: 'AppSec', color: '#ec4899', children: [{ name: 'CIPHER', color: '#f59e0b' }] },
      { name: 'NetSec', color: '#f97316', children: [{ name: 'NETWATCH', color: '#ec4899' }] },
    ]},
  ],
}

function flattenTree(node, depth = 0, parentId = null, index = 0) {
  const id = `${depth}-${index}`
  const flat = [{ ...node, depth, parentId, id }]
  if (node.children) {
    node.children.forEach((c, ci) => {
      flat.push(...flattenTree(c, depth + 1, id, ci))
    })
  }
  return flat
}

export function OrgTree() {
  const f = useAnimFrame()
  const w = 600, h = 400
  const nodes = flattenTree(OT_TREE)
  const reveal = lerp(f, 0, 15, 0, 1)

  // Layout: spread by depth
  const byDepth = {}
  nodes.forEach(n => { if (!byDepth[n.depth]) byDepth[n.depth] = []; byDepth[n.depth].push(n) })
  const maxDepth = Math.max(...Object.keys(byDepth).map(Number))
  const depthY = {}
  Object.keys(byDepth).forEach(d => { depthY[d] = 50 + (Number(d) / maxDepth) * (h - 100) })
  const positions = {}
  Object.entries(byDepth).forEach(([d, group]) => {
    const spacing = w / (group.length + 1)
    group.forEach((n, i) => {
      positions[n.id] = { x: spacing * (i + 1), y: depthY[d] }
    })
  })

  return (
    <div style={{ width: w, height: h, position: 'relative' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' }}>Organisation Tree</div>
      <svg width={w} height={h} style={{ opacity: reveal }}>
        {/* Edges */}
        {nodes.filter(n => n.parentId).map((n, i) => {
          const from = positions[n.parentId], to = positions[n.id]
          if (!from || !to) return null
          const my = (from.y + to.y) / 2
          const edgeOp = lerp(f, n.depth * 5, n.depth * 5 + 10, 0, 0.5)
          return (
            <path key={i} d={`M ${from.x} ${from.y} C ${from.x} ${my},${to.x} ${my},${to.x} ${to.y}`}
              fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={1.2} opacity={edgeOp} />
          )
        })}
        {/* Nodes */}
        {nodes.map((n, i) => {
          const pos = positions[n.id]
          if (!pos) return null
          const op = lerp(f, n.depth * 5, n.depth * 5 + 8, 0, 1)
          const isLeaf = !n.children
          return (
            <g key={i} opacity={op}>
              <rect x={pos.x - 35} y={pos.y - 12} width={70} height={24} rx={isLeaf ? 12 : 6}
                fill={`${n.color}15`} stroke={n.color} strokeWidth={1} strokeOpacity={0.5} />
              <text x={pos.x} y={pos.y + 4} textAnchor="middle" fill={isLeaf ? n.color : '#fff'}
                fontSize={isLeaf ? 9 : 10} fontFamily={M} fontWeight={isLeaf ? 500 : 700}>{n.name}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 17. ROUTER CONFIDENCE (Waterfall variant)
// ═══════════════════════════════════════════════════════════════
const RC_STAGES = [
  { label: 'Query', color: '#38bdf8', detail: '"install mha on edge-01"', conf: 1.0 },
  { label: 'Regex Match', color: '#f59e0b', detail: 'Pattern: /install.*mha.*on\\s+(\\S+)/', conf: 0.85 },
  { label: 'Semantic', color: '#a855f7', detail: 'Intent: infrastructure.deploy | Agent: WARDEN (0.87)', conf: 0.87 },
  { label: 'Decision', color: '#30ff90', detail: 'Route → WARDEN.install_mha(host="edge-01")', conf: 0.92 },
]

export function RouterConfidence() {
  const f = useAnimFrame()
  const w = 550, stageH = 70, gap = 10, connH = 30
  const totalH = RC_STAGES.length * stageH + (RC_STAGES.length - 1) * (gap + connH) + 40
  const reveal = lerp(f, 0, 15, 0, 1)

  return (
    <div style={{ width: w, position: 'relative', opacity: reveal }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Router Confidence — Waterfall</div>
      <svg width={w} height={totalH}>
        {RC_STAGES.map((stage, i) => {
          const y = 10 + i * (stageH + gap + connH)
          const op = lerp(f, i * 6, i * 6 + 10, 0, 1)
          const barW = lerp(f, i * 6 + 2, i * 6 + 12, 0, stage.conf) * (w - 160)
          return (
            <g key={i} opacity={op}>
              {/* Stage box */}
              <rect x={10} y={y} width={w - 20} height={stageH} rx={8} fill={`${stage.color}08`} stroke={stage.color} strokeWidth={1} strokeOpacity={0.3} />
              {/* Label */}
              <text x={24} y={y + 20} fill={stage.color} fontSize={12} fontFamily={M} fontWeight={700}>{stage.label}</text>
              {/* Detail */}
              <text x={24} y={y + 36} fill="rgba(255,255,255,0.8)" fontSize={10} fontFamily={M}>{stage.detail}</text>
              {/* Confidence bar */}
              <rect x={24} y={y + 48} width={w - 160} height={6} rx={3} fill="rgba(255,255,255,0.06)" />
              <rect x={24} y={y + 48} width={barW} height={6} rx={3} fill={stage.color} opacity={0.7} />
              <text x={w - 130 + 8} y={y + 55} fill={stage.color} fontSize={10} fontFamily={M} fontWeight={700}>{(stage.conf * 100).toFixed(0)}%</text>
              {/* Connector */}
              {i < RC_STAGES.length - 1 && (
                <g>
                  <line x1={w / 2} y1={y + stageH} x2={w / 2} y2={y + stageH + gap + connH}
                    stroke="rgba(255,255,255,0.15)" strokeWidth={1.5} strokeDasharray="4 3" />
                  <polygon points={`${w / 2},${y + stageH + gap + connH} ${w / 2 - 4},${y + stageH + gap + connH - 6} ${w / 2 + 4},${y + stageH + gap + connH - 6}`}
                    fill="rgba(255,255,255,0.4)" />
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 18. CAPABILITY MAP (Force layout)
// ═══════════════════════════════════════════════════════════════
const CM_AGENTS = [
  { id: 'sentinel', label: 'WARDEN', type: 'agent', color: '#ef4444' },
  { id: 'forge', label: 'VULCAN', type: 'agent', color: '#a855f7' },
  { id: 'atlas', label: 'HYPERION', type: 'agent', color: '#f59e0b' },
  { id: 'cipher', label: 'CIPHER', type: 'agent', color: '#f59e0b' },
  { id: 'nova', label: 'DAEDALUS', type: 'agent', color: '#14b8a6' },
]
const CM_TOOLS = [
  { id: 'ssh', label: 'SSH', type: 'tool', color: '#38bdf8' },
  { id: 'docker', label: 'Docker', type: 'tool', color: '#2496ed' },
  { id: 'git', label: 'Git', type: 'tool', color: '#f97316' },
  { id: 'scan', label: 'Scan', type: 'tool', color: '#ef4444' },
  { id: 'deploy', label: 'Deploy', type: 'tool', color: '#30ff90' },
  { id: 'monitor', label: 'Monitor', type: 'tool', color: '#06b6d4' },
  { id: 'logs', label: 'Logs', type: 'tool', color: '#8b5cf6' },
  { id: 'dns', label: 'DNS', type: 'tool', color: '#64748b' },
  { id: 'backup', label: 'Backup', type: 'tool', color: '#22c55e' },
  { id: 'certs', label: 'Certs', type: 'tool', color: '#ec4899' },
  { id: 'firewall', label: 'Firewall', type: 'tool', color: '#f59e0b' },
  { id: 'test', label: 'Test', type: 'tool', color: '#6366f1' },
]
const CM_WORKFLOWS = [
  { id: 'wf-deploy', label: 'Deploy Pipeline', type: 'workflow', color: '#30ff90' },
  { id: 'wf-scan', label: 'Security Sweep', type: 'workflow', color: '#ef4444' },
  { id: 'wf-backup', label: 'Backup Job', type: 'workflow', color: '#06b6d4' },
]
const CM_EDGES = [
  { from: 'sentinel', to: 'ssh', strength: 0.9 }, { from: 'sentinel', to: 'scan', strength: 1 }, { from: 'sentinel', to: 'firewall', strength: 0.8 },
  { from: 'forge', to: 'git', strength: 1 }, { from: 'forge', to: 'docker', strength: 0.9 }, { from: 'forge', to: 'deploy', strength: 0.8 }, { from: 'forge', to: 'test', strength: 0.7 },
  { from: 'atlas', to: 'monitor', strength: 1 }, { from: 'atlas', to: 'logs', strength: 0.9 }, { from: 'atlas', to: 'dns', strength: 0.5 },
  { from: 'cipher', to: 'certs', strength: 1 }, { from: 'cipher', to: 'firewall', strength: 0.7 }, { from: 'cipher', to: 'scan', strength: 0.6 },
  { from: 'nova', to: 'backup', strength: 0.8 }, { from: 'nova', to: 'deploy', strength: 0.6 }, { from: 'nova', to: 'monitor', strength: 0.5 },
  { from: 'forge', to: 'wf-deploy', strength: 0.9 }, { from: 'sentinel', to: 'wf-scan', strength: 0.95 }, { from: 'nova', to: 'wf-backup', strength: 0.85 },
]

export function CapabilityMap() {
  const f = useAnimFrame()
  const w = 600, h = 500, cx = w / 2, cy = h / 2
  const reveal = lerp(f, 0, 20, 0, 1)

  const allNodes = [...CM_AGENTS, ...CM_TOOLS, ...CM_WORKFLOWS]
  const positions = {}

  // Inner ring: agents
  CM_AGENTS.forEach((a, i) => {
    const angle = (i / CM_AGENTS.length) * Math.PI * 2 - Math.PI / 2
    const r = 80
    positions[a.id] = { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
  })
  // Outer ring: tools
  CM_TOOLS.forEach((t, i) => {
    const angle = (i / CM_TOOLS.length) * Math.PI * 2 - Math.PI / 2 + 0.15
    const r = 200
    positions[t.id] = { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
  })
  // Scattered: workflows
  CM_WORKFLOWS.forEach((wf, i) => {
    const angle = (i / CM_WORKFLOWS.length) * Math.PI * 2 + Math.PI / 6
    const r = 140
    positions[wf.id] = { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
  })

  const nodeMap = {}
  allNodes.forEach(n => { nodeMap[n.id] = n })

  return (
    <div style={{ width: w, height: h, position: 'relative' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' }}>Capability Map — Agents / Tools / Workflows</div>
      <svg width={w} height={h} style={{ opacity: reveal }}>
        {/* Edges */}
        {CM_EDGES.map((e, i) => {
          const from = positions[e.from], to = positions[e.to]
          if (!from || !to) return null
          const srcNode = nodeMap[e.from]
          return (
            <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke={srcNode ? srcNode.color : '#fff'} strokeWidth={e.strength * 2}
              strokeOpacity={0.15 + e.strength * 0.15} />
          )
        })}
        {/* Nodes */}
        {allNodes.map((n, i) => {
          const pos = positions[n.id]
          if (!pos) return null
          const op = lerp(f, i * 1.5, i * 1.5 + 8, 0, 1)
          const isAgent = n.type === 'agent'
          const isTool = n.type === 'tool'
          const isWf = n.type === 'workflow'
          const size = isAgent ? 20 : isTool ? 14 : 16
          return (
            <g key={n.id} opacity={op}>
              {isAgent && <circle cx={pos.x} cy={pos.y} r={size} fill={`${n.color}20`} stroke={n.color} strokeWidth={1.5} />}
              {isTool && <rect x={pos.x - size} y={pos.y - size} width={size * 2} height={size * 2} rx={3} fill={`${n.color}15`} stroke={n.color} strokeWidth={1} strokeOpacity={0.6} />}
              {isWf && <polygon points={`${pos.x},${pos.y - size} ${pos.x + size},${pos.y} ${pos.x},${pos.y + size} ${pos.x - size},${pos.y}`} fill={`${n.color}15`} stroke={n.color} strokeWidth={1} strokeOpacity={0.6} />}
              <text x={pos.x} y={pos.y + size + 14} textAnchor="middle" fill="#fff" fontSize={isAgent ? 10 : 8} fontFamily={M} fontWeight={isAgent ? 700 : 500}>{n.label}</text>
            </g>
          )
        })}
      </svg>
      <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
        {[{ l: '● Agent', s: 'circle' }, { l: '■ Tool', s: 'square' }, { l: '◆ Workflow', s: 'diamond' }].map(x => (
          <span key={x.l} style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.7)' }}>{x.l}</span>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 19. CONNECTION GRAPH
// ═══════════════════════════════════════════════════════════════
const CG_SERVICES = [
  { id: 'dashboard', label: 'Dashboard', x: 300, y: 50, color: '#38bdf8', type: 'service' },
  { id: 'collector', label: 'Collector', x: 150, y: 160, color: '#a855f7', type: 'service' },
  { id: 'auth', label: 'Auth', x: 450, y: 160, color: '#30ff90', type: 'service' },
  { id: 'memory', label: 'Memory', x: 80, y: 290, color: '#ec4899', type: 'service' },
  { id: 'quoxflow', label: 'QuoxFlow', x: 520, y: 290, color: '#f59e0b', type: 'service' },
  { id: 'postgres', label: 'Postgres', x: 220, y: 400, color: '#3b82f6', type: 'database' },
  { id: 'qdrant', label: 'Qdrant', x: 420, y: 400, color: '#06b6d4', type: 'database' },
]
const CG_EDGES = [
  { from: 'dashboard', to: 'collector', label: 'chat' },
  { from: 'dashboard', to: 'auth', label: 'JWT' },
  { from: 'collector', to: 'memory', label: 'store' },
  { from: 'collector', to: 'auth', label: 'verify' },
  { from: 'auth', to: 'postgres', label: 'users' },
  { from: 'memory', to: 'postgres', label: 'facts' },
  { from: 'memory', to: 'qdrant', label: 'vectors' },
  { from: 'quoxflow', to: 'postgres', label: 'state' },
  { from: 'dashboard', to: 'quoxflow', label: 'workflows' },
]

export function ConnectionGraph() {
  const f = useAnimFrame()
  const w = 600, h = 470
  const reveal = lerp(f, 0, 15, 0, 1)

  const nodeMap = {}
  CG_SERVICES.forEach(s => { nodeMap[s.id] = s })

  return (
    <div style={{ width: w, height: h, position: 'relative' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' }}>Service Connection Graph</div>
      <svg width={w} height={h} style={{ opacity: reveal }}>
        <defs>
          <marker id="cg-arrow" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
            <polygon points="0 0, 6 2, 0 4" fill="rgba(255,255,255,0.4)" />
          </marker>
        </defs>
        {/* Edges with animated dash */}
        {CG_EDGES.map((e, i) => {
          const from = nodeMap[e.from], to = nodeMap[e.to]
          if (!from || !to) return null
          const mx = (from.x + to.x) / 2
          const my = (from.y + to.y) / 2
          const dx = to.x - from.x, dy = to.y - from.y
          const len = Math.sqrt(dx * dx + dy * dy)
          const nx = -dy / len * 25, ny = dx / len * 25
          const cpx = mx + nx, cpy = my + ny
          const edgeOp = lerp(f, i * 3, i * 3 + 10, 0, 0.6)
          return (
            <g key={i}>
              <path d={`M ${from.x} ${from.y} Q ${cpx} ${cpy} ${to.x} ${to.y}`}
                fill="none" stroke={from.color} strokeWidth={1.5} strokeOpacity={edgeOp}
                strokeDasharray="6 4" strokeDashoffset={-f * 0.5 + i * 20}
                markerEnd="url(#cg-arrow)" />
              <text x={cpx} y={cpy - 6} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize={8} fontFamily={M}>{e.label}</text>
            </g>
          )
        })}
        {/* Nodes */}
        {CG_SERVICES.map((s, i) => {
          const op = lerp(f, i * 2, i * 2 + 8, 0, 1)
          const isDb = s.type === 'database'
          return (
            <g key={s.id} opacity={op}>
              {isDb ? (
                <g>
                  {/* Cylinder shape for databases */}
                  <ellipse cx={s.x} cy={s.y - 10} rx={28} ry={8} fill={`${s.color}15`} stroke={s.color} strokeWidth={1} strokeOpacity={0.5} />
                  <rect x={s.x - 28} y={s.y - 10} width={56} height={28} fill={`${s.color}10`} stroke="none" />
                  <line x1={s.x - 28} y1={s.y - 10} x2={s.x - 28} y2={s.y + 18} stroke={s.color} strokeWidth={1} strokeOpacity={0.5} />
                  <line x1={s.x + 28} y1={s.y - 10} x2={s.x + 28} y2={s.y + 18} stroke={s.color} strokeWidth={1} strokeOpacity={0.5} />
                  <ellipse cx={s.x} cy={s.y + 18} rx={28} ry={8} fill={`${s.color}15`} stroke={s.color} strokeWidth={1} strokeOpacity={0.5} />
                </g>
              ) : (
                <rect x={s.x - 35} y={s.y - 16} width={70} height={32} rx={8} fill={`${s.color}12`} stroke={s.color} strokeWidth={1.2} strokeOpacity={0.5} />
              )}
              <text x={s.x} y={s.y + (isDb ? 5 : 4)} textAnchor="middle" fill="#fff" fontSize={10} fontFamily={M} fontWeight={700}>{s.label}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 20. APPROVAL CARD
// ═══════════════════════════════════════════════════════════════
export function ApprovalCard() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const [status, setStatus] = useState('pending')

  const slaTotal = 300 // seconds
  const slaRemaining = Math.max(0, slaTotal - f * 2)
  const slaPct = slaRemaining / slaTotal
  const slaColor = slaPct > 0.5 ? '#30ff90' : slaPct > 0.2 ? '#f59e0b' : '#ef4444'

  const mins = Math.floor(slaRemaining / 60)
  const secs = Math.floor(slaRemaining % 60)

  return (
    <div style={{ maxWidth: 480, opacity: reveal }}>
      <GP style={{ padding: 0 }}>
        {/* Header */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: M, fontSize: 9, padding: '2px 8px', borderRadius: 4, background: 'rgba(239,115,22,0.15)', color: '#f97316', fontWeight: 700, letterSpacing: 1 }}>DEPLOYMENT</span>
            <span style={{ fontFamily: M, fontSize: 9, padding: '2px 8px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: '#ef4444', fontWeight: 700 }}>HIGH</span>
          </div>
          <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>APR-2847</span>
        </div>
        {/* Body */}
        <div style={{ padding: '14px 16px' }}>
          <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 6 }}>
            Deploy quox-api v2.4.1 to production
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#a855f720', border: '1px solid #a855f740', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#a855f7' }}>F</div>
            <span style={{ fontFamily: M, fontSize: 11, color: '#fff' }}>VULCAN</span>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>requested 2m ago</span>
          </div>
          <div style={{ fontFamily: F, fontSize: 12, color: 'rgba(255,255,255,0.8)', lineHeight: 1.5, marginBottom: 14 }}>
            Rolling deployment across edge-01 and edge-02. All tests passing (342/342). Staging verified. Changelog reviewed by CODEX. Two-person rule requires human approval.
          </div>
          {/* SLA countdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{ width: `${slaPct * 100}%`, height: '100%', borderRadius: 2, background: slaColor, transition: 'width 0.3s' }} />
            </div>
            <span style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: slaColor, minWidth: 50, textAlign: 'right' }}>
              {mins}:{String(secs).padStart(2, '0')}
            </span>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>SLA</span>
          </div>
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8 }}>
            <GP style={{ flex: 1, padding: '8px 12px', cursor: 'pointer', textAlign: 'center', borderTopColor: status === 'approved' ? 'rgba(48,255,144,0.5)' : 'rgba(48,255,144,0.2)', background: status === 'approved' ? 'rgba(48,255,144,0.1)' : undefined }}
              onClick={() => setStatus('approved')}>
              <span style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: '#30ff90', letterSpacing: 1 }}>✓ APPROVE</span>
            </GP>
            <GP style={{ flex: 1, padding: '8px 12px', cursor: 'pointer', textAlign: 'center', borderTopColor: status === 'denied' ? 'rgba(239,68,68,0.5)' : 'rgba(239,68,68,0.2)', background: status === 'denied' ? 'rgba(239,68,68,0.1)' : undefined }}
              onClick={() => setStatus('denied')}>
              <span style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: '#ef4444', letterSpacing: 1 }}>✕ DENY</span>
            </GP>
            <GP style={{ padding: '8px 12px', cursor: 'pointer', textAlign: 'center' }}
              onClick={() => setStatus('deferred')}>
              <span style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: '#f59e0b', letterSpacing: 1 }}>◇ DEFER</span>
            </GP>
          </div>
          {status !== 'pending' && (
            <div style={{ marginTop: 10, fontFamily: M, fontSize: 10, color: status === 'approved' ? '#30ff90' : status === 'denied' ? '#ef4444' : '#f59e0b', textAlign: 'center' }}>
              Status: {status.toUpperCase()}
            </div>
          )}
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 21. ORBITAL HUD
// ═══════════════════════════════════════════════════════════════
const ORBITAL_RINGS = [
  { radius: 60, speed: 0.4, color: '#38bdf8', type: 'metrics', data: ['CPU 12%','MEM 4.2G','NET 140Mb','DISK 62%','IOPS 842','TEMP 41°'] },
  { radius: 100, speed: -0.25, color: '#a855f7', type: 'agents', data: ['CommanderQ','VULCAN','MESHNET','NETWATCH','WARDEN','HYPERION','CODEX','COREY'] },
  { radius: 140, speed: 0.15, color: '#6366f1', type: 'status', data: ['●','●','●','●','○','●','●','●','●','●','●','●'] },
  { radius: 180, speed: -0.1, color: '#30ff90', type: 'protocols', data: ['AEE','AOCL','VOLT','WARD','AEE','AOCL','VOLT','WARD'] },
]

export function OrbitalHUD({ rings = ORBITAL_RINGS, centre, showReticle = true, intensity = 1.0, width = 400, height = 400 }) {
  const f = useAnimFrame()
  const cx = centre?.x ?? width / 2
  const cy = centre?.y ?? height / 2
  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      <svg style={{ position: 'absolute', inset: 0 }} viewBox={`0 0 ${width} ${height}`}>
        {rings.map((ring, ri) => {
          const rot = f * ring.speed
          return (
            <g key={ri}>
              <circle cx={cx} cy={cy} r={ring.radius} fill="none" stroke={ring.color} strokeWidth={0.5} opacity={0.08 * intensity} strokeDasharray={ring.type === 'status' ? '2 6' : 'none'} />
              <circle cx={cx} cy={cy} r={ring.radius} fill="none" stroke={ring.color} strokeWidth={4} opacity={0.02 * intensity} />
              {ring.data.map((item, di) => {
                const angle = (di / ring.data.length) * Math.PI * 2 + (rot * Math.PI / 180)
                const x = cx + Math.cos(angle) * ring.radius
                const y = cy + Math.sin(angle) * ring.radius
                const itemPulse = lerp(Math.sin(f * 0.05 + di * 0.8 + ri * 1.3) * 0.5 + 0.5, 0, 1, 0.5, 1.0) * intensity
                if (ring.type === 'status') {
                  const isActive = item === '●'
                  return (<g key={di}><circle cx={x} cy={y} r={4} fill={isActive ? ring.color : '#ef4444'} opacity={itemPulse * 0.8} />{isActive && <circle cx={x} cy={y} r={8} fill={ring.color} opacity={itemPulse * 0.1} />}</g>)
                }
                return (<g key={di}><circle cx={x} cy={y} r={ring.type === 'protocols' ? 18 : 14} fill={ring.color} opacity={0.04 * intensity} /><text x={x} y={y + 4} fontSize={ring.type === 'metrics' ? 9 : ring.type === 'protocols' ? 10 : 8} fontFamily={M} fontWeight={600} fill={ring.color} opacity={itemPulse * 0.8} textAnchor="middle" letterSpacing="0.5px">{item}</text></g>)
              })}
              {[0, 90, 180, 270].map(deg => {
                const a = (deg + rot) * Math.PI / 180
                const x1 = cx + Math.cos(a) * (ring.radius - 6), y1 = cy + Math.sin(a) * (ring.radius - 6)
                const x2 = cx + Math.cos(a) * (ring.radius + 6), y2 = cy + Math.sin(a) * (ring.radius + 6)
                return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke={ring.color} strokeWidth={1.5} opacity={0.15 * intensity} />
              })}
            </g>
          )
        })}
        {showReticle && <g>
          <line x1={cx - 20} y1={cy} x2={cx - 8} y2={cy} stroke="#38bdf8" strokeWidth={1.5} opacity={0.4 * intensity} />
          <line x1={cx + 8} y1={cy} x2={cx + 20} y2={cy} stroke="#38bdf8" strokeWidth={1.5} opacity={0.4 * intensity} />
          <line x1={cx} y1={cy - 20} x2={cx} y2={cy - 8} stroke="#38bdf8" strokeWidth={1.5} opacity={0.4 * intensity} />
          <line x1={cx} y1={cy + 8} x2={cx} y2={cy + 20} stroke="#38bdf8" strokeWidth={1.5} opacity={0.4 * intensity} />
          <circle cx={cx} cy={cy} r={3} fill="#38bdf8" opacity={lerp(Math.sin(f * 0.06) * 0.5 + 0.5, 0, 1, 0.4, 0.9) * intensity} />
          {[0, 1, 2, 3].map(i => {
            const a = (i * 90 + f * 0.8) * Math.PI / 180
            return <line key={i} x1={cx + Math.cos(a) * 30} y1={cy + Math.sin(a) * 30} x2={cx + Math.cos(a) * 45} y2={cy + Math.sin(a) * 45} stroke="#a855f7" strokeWidth={1} opacity={0.2 * intensity} />
          })}
        </g>}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 22. SECURITY SHIELD
// ═══════════════════════════════════════════════════════════════
const SHIELD_LAYERS = [
  { name: 'FIREWALL', color: '#ef4444', strength: 1.0 },
  { name: 'IDENTITY', color: '#f59e0b', strength: 0.95 },
  { name: 'POLICY', color: '#38bdf8', strength: 1.0 },
  { name: 'ENCRYPT', color: '#a855f7', strength: 0.88 },
  { name: 'AUDIT', color: '#30ff90', strength: 1.0 },
]

const hexPoints = (cx, cy, r) => Array.from({ length: 6 }, (_, i) => {
  const angle = (Math.PI / 3) * i - Math.PI / 6
  return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`
}).join(' ')

export function SecurityShield({ size = 300, layers = SHIELD_LAYERS, variant = 'hex', status = 'protected', showLabels = true }) {
  const f = useAnimFrame()
  const cx = size / 2, cy = size / 2
  const statusPulse = status === 'scanning' ? lerp(Math.sin(f * 0.1) * 0.5 + 0.5, 0, 1, 0.4, 1.0) : status === 'breach' ? lerp(Math.sin(f * 0.2) * 0.5 + 0.5, 0, 1, 0.2, 0.9) : status === 'hardening' ? lerp((f % 30) / 30, 0, 1, 0.6, 1.0) : 1.0
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', inset: 0 }}>
        {layers.map((layer, i) => {
          const layerRadius = size * 0.45 - i * (size * 0.06)
          const layerPulse = lerp(Math.sin(f * 0.04 + i * 0.8) * 0.5 + 0.5, 0, 1, 0.3, 0.6) * layer.strength * statusPulse
          const rotation = variant === 'hex' ? f * 0.1 * (i % 2 === 0 ? 1 : -1) : 0
          return (
            <g key={i} transform={`rotate(${rotation} ${cx} ${cy})`}>
              {variant === 'circle' ? (
                <><circle cx={cx} cy={cy} r={layerRadius} fill={layer.color} opacity={layerPulse * 0.08} stroke={layer.color} strokeWidth={1.5} strokeOpacity={layerPulse * 0.5} /><circle cx={cx} cy={cy} r={layerRadius} fill="none" stroke={layer.color} strokeWidth={6} opacity={layerPulse * 0.03} /></>
              ) : (
                <><polygon points={hexPoints(cx, cy, layerRadius)} fill={layer.color} opacity={layerPulse * 0.08} stroke={layer.color} strokeWidth={1.5} strokeOpacity={layerPulse * 0.5} /><polygon points={hexPoints(cx, cy, layerRadius)} fill="none" stroke={layer.color} strokeWidth={6} opacity={layerPulse * 0.03} /></>
              )}
              {showLabels && <text x={cx + layerRadius + 8} y={cy - (i - 2) * 18} fontSize={9} fontFamily={M} fontWeight={600} fill={layer.color} opacity={layerPulse * 0.7} letterSpacing="1px">{layer.name}</text>}
            </g>
          )
        })}
        <circle cx={cx} cy={cy} r={12} fill={status === 'breach' ? '#ef4444' : status === 'protected' ? '#30ff90' : '#38bdf8'} opacity={statusPulse * 0.6} />
        <circle cx={cx} cy={cy} r={20} fill={status === 'breach' ? '#ef4444' : '#30ff90'} opacity={statusPulse * 0.08} />
        <text x={cx} y={cy + size * 0.42} fontSize={11} fontFamily={M} fontWeight={700} fill={status === 'breach' ? '#ef4444' : '#30ff90'} opacity={statusPulse * 0.8} textAnchor="middle" letterSpacing="3px">{status.toUpperCase()}</text>
        {status === 'scanning' && (() => {
          const sweepAngle = (f * 4) % 360
          const rad = (sweepAngle * Math.PI) / 180
          const sr = size * 0.45
          return <line x1={cx} y1={cy} x2={cx + Math.cos(rad) * sr} y2={cy + Math.sin(rad) * sr} stroke="#38bdf8" strokeWidth={1.5} opacity={0.3} />
        })()}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 23. COMMAND STREAM
// ═══════════════════════════════════════════════════════════════
const CS_LEVEL_CONFIG = {
  info: { icon: '●', color: '#38bdf8' },
  success: { icon: '✓', color: '#30ff90' },
  warning: { icon: '⚠', color: '#f59e0b' },
  error: { icon: '✕', color: '#ef4444' },
  agent: { icon: '◈', color: '#a855f7' },
  audit: { icon: '◆', color: '#06b6d4' },
}

const CS_EVENTS = [
  { time: '14:32:01.442', level: 'agent', source: 'CommanderQ', message: 'Delegating infrastructure scan to WARDEN' },
  { time: '14:32:01.890', level: 'info', source: 'AOCL:L2', message: 'Route → WARDEN (score: 94)' },
  { time: '14:32:02.103', level: 'info', source: 'AOCL:L3', message: 'Policy gate passed: fleet.scan.read' },
  { time: '14:32:02.445', level: 'success', source: 'WARDEN', message: 'Fleet scan complete: 12 hosts, 0 threats' },
  { time: '14:32:02.891', level: 'audit', source: 'VOLT', message: 'Evidence recorded: EVD-4827 (hash: a7f3c2...)' },
  { time: '14:32:03.120', level: 'agent', source: 'CommanderQ', message: 'Checking edge-03 CPU anomaly' },
  { time: '14:32:03.340', level: 'warning', source: 'METRICS', message: 'edge-03 CPU 94% — exceeds threshold' },
  { time: '14:32:03.780', level: 'info', source: 'AOCL:L5', message: 'Context loaded: maintenance_window:MW-2026-03' },
  { time: '14:32:04.100', level: 'success', source: 'ops-agent', message: 'Identified: scheduled postgres backup in progress' },
  { time: '14:32:04.450', level: 'audit', source: 'VOLT', message: 'Decision recorded: no_action (confidence: 0.94)' },
  { time: '14:32:05.200', level: 'info', source: 'AOCL:L9', message: 'Response assembled: 3 findings, 0 actions' },
  { time: '14:32:05.610', level: 'success', source: 'CommanderQ', message: 'Report delivered to operator' },
  { time: '14:32:06.001', level: 'agent', source: 'VULCAN', message: 'PR #127 review requested — quoxflow/src/engine.ts' },
  { time: '14:32:06.340', level: 'info', source: 'AOCL:L3', message: 'Policy gate passed: github.pr.read' },
  { time: '14:32:07.120', level: 'success', source: 'VULCAN', message: 'Review complete: 2 suggestions, 0 blockers' },
  { time: '14:32:07.890', level: 'audit', source: 'WARD', message: 'Witness receipt issued: WR-0094' },
]

export function CommandStream({ events = CS_EVENTS, speed = 0.8, width = 620, maxVisible = 8, variant = 'feed' }) {
  const f = useAnimFrame()
  const lineHeight = variant === 'compact' ? 28 : 38
  const scrollOffset = f * speed
  const startIdx = Math.floor(scrollOffset / lineHeight)
  const visibleEvents = []
  for (let i = 0; i < maxVisible + 2; i++) {
    const idx = (startIdx + i) % events.length
    visibleEvents.push({ ...events[idx], displayIdx: startIdx + i })
  }
  return (
    <div style={{ width, overflow: 'hidden', height: maxVisible * lineHeight, borderRadius: 12, background: variant === 'matrix' ? 'rgba(0,48,0,0.08)' : 'rgba(255,255,255,0.015)', border: `1px solid ${variant === 'matrix' ? '#30ff9015' : 'rgba(255,255,255,0.05)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}>
        <div style={{ fontSize: 10, fontFamily: M, color: 'rgba(56,189,248,0.7)', letterSpacing: '2px', fontWeight: 700 }}>{variant === 'matrix' ? 'SYSTEM LOG' : 'OPERATIONS FEED'}</div>
        <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#30ff90', opacity: lerp(Math.sin(f * 0.1) * 0.5 + 0.5, 0, 1, 0.4, 1.0) }} />
      </div>
      <div style={{ position: 'relative', height: maxVisible * lineHeight, overflow: 'hidden' }}>
        {visibleEvents.map((event, i) => {
          const yPos = (event.displayIdx * lineHeight) - scrollOffset
          const totalHeight = events.length * lineHeight
          const localY = yPos % (totalHeight || 1)
          const fadeRatio = localY / (maxVisible * lineHeight)
          const opacity = fadeRatio < 0.1 ? fadeRatio * 10 : fadeRatio > 0.9 ? (1 - fadeRatio) * 10 : 1
          const levelCfg = CS_LEVEL_CONFIG[event.level] || CS_LEVEL_CONFIG.info
          const isRecent = i <= 2
          return (
            <div key={`${event.displayIdx}`} style={{ position: 'absolute', left: 0, right: 0, top: localY, height: lineHeight, display: 'flex', alignItems: 'center', padding: '0 14px', gap: 10, opacity, background: isRecent ? `${levelCfg.color}04` : 'transparent', borderLeft: isRecent ? `2px solid ${levelCfg.color}40` : '2px solid transparent' }}>
              <div style={{ fontSize: 13, color: levelCfg.color, width: 16, textAlign: 'center', opacity: 0.8 }}>{levelCfg.icon}</div>
              <div style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.6)', width: 90, flexShrink: 0 }}>{event.time}</div>
              <div style={{ fontSize: 11, fontFamily: M, fontWeight: 700, color: levelCfg.color, width: 100, flexShrink: 0, letterSpacing: '0.5px' }}>{event.source}</div>
              <div style={{ fontSize: 13, fontFamily: variant === 'matrix' ? M : F, color: variant === 'matrix' ? '#30ff90' : 'rgba(255,255,255,0.85)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{event.message}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 24. POWER GRID
// ═══════════════════════════════════════════════════════════════
const PG_DATA = [
  { label: 'edge-01', segments: [0.12, 0.34, 0.28, 0.45, 0.62, 0.55, 0.41, 0.38, 0.52, 0.44, 0.33, 0.27], color: '#30ff90' },
  { label: 'edge-02', segments: [0.08, 0.22, 0.18, 0.35, 0.28, 0.42, 0.38, 0.31, 0.25, 0.19, 0.15, 0.22], color: '#38bdf8' },
  { label: 'edge-03', segments: [0.94, 0.88, 0.91, 0.85, 0.92, 0.96, 0.89, 0.93, 0.87, 0.95, 0.90, 0.88], color: '#f59e0b' },
  { label: 'edge-04', segments: [0.23, 0.31, 0.28, 0.19, 0.42, 0.35, 0.28, 0.22, 0.38, 0.45, 0.33, 0.29], color: '#30ff90' },
  { label: 'hyp-01', segments: [0.62, 0.58, 0.65, 0.71, 0.68, 0.55, 0.62, 0.59, 0.66, 0.72, 0.61, 0.57], color: '#06b6d4' },
  { label: 'hyp-02', segments: [0.41, 0.38, 0.45, 0.42, 0.39, 0.44, 0.41, 0.37, 0.43, 0.40, 0.38, 0.42], color: '#a855f7' },
]

export function PowerGrid({ data = PG_DATA, variant = 'cells', cellSize = 24, gap = 3 }) {
  const f = useAnimFrame()
  const getColor = (value, baseColor) => value > 0.9 ? '#ef4444' : value > 0.7 ? '#f59e0b' : baseColor
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: gap + 2 }}>
      {data.map((row, ri) => {
        const rowReveal = lerp(f, ri * 4, ri * 4 + 10, 0, 1)
        return (
          <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: rowReveal }}>
            <div style={{ width: 70, fontSize: 11, fontFamily: M, fontWeight: 600, color: row.color, textAlign: 'right', letterSpacing: '0.5px' }}>{row.label}</div>
            <div style={{ display: 'flex', gap }}>
              {row.segments.map((val, si) => {
                const segReveal = lerp(f, ri * 4 + si, ri * 4 + si + 5, 0, 1)
                const cellColor = getColor(val, row.color)
                const pulse = val > 0.85 ? lerp(Math.sin(f * 0.1 + si) * 0.5 + 0.5, 0, 1, 0.5, 1.0) : 1
                if (variant === 'bars') {
                  return <div key={si} style={{ width: cellSize, height: cellSize * 1.5, borderRadius: 3, background: 'rgba(255,255,255,0.03)', display: 'flex', alignItems: 'flex-end' }}><div style={{ width: '100%', height: val * cellSize * 1.5 * segReveal, borderRadius: 3, background: `linear-gradient(to top, ${cellColor}60, ${cellColor})`, opacity: pulse }} /></div>
                }
                return <div key={si} style={{ width: cellSize, height: cellSize, borderRadius: 3, background: 'rgba(255,255,255,0.03)', border: `1px solid ${cellColor}20`, overflow: 'hidden', position: 'relative' }}><div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${val * 100 * segReveal}%`, background: `linear-gradient(to top, ${cellColor}40, ${cellColor}90)`, opacity: pulse }} /></div>
              })}
            </div>
            <div style={{ fontSize: 11, fontFamily: M, fontWeight: 700, width: 35, color: getColor(row.segments[row.segments.length - 1], row.color), opacity: 0.8 }}>{Math.round(row.segments[row.segments.length - 1] * 100)}%</div>
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 25. DATA STREAM
// ═══════════════════════════════════════════════════════════════
const DS_CHARSETS = { hex: '0123456789ABCDEF', binary: '01', hash: '0123456789abcdef', kanji: 'アイウエオカキクケコサシスセソタチツテト' }
const dsSeeded = (seed, charset) => { const chars = DS_CHARSETS[charset] || DS_CHARSETS.hex; return chars[Math.floor((Math.sin(seed * 9301 + 49297) * 49297 % 1 + 1) % 1 * chars.length) % chars.length] }

export function DataStream({ columns = 12, speed = 1, color = '#38bdf8', charset = 'hex', density = 16, opacity = 0.3, width = 600, height = 300 }) {
  const f = useAnimFrame()
  const colSize = width / columns
  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden', opacity, pointerEvents: 'none' }}>
      {Array.from({ length: columns }, (_, col) => {
        const seed = col * 237.7
        const colOffset = (Math.sin(seed) * 0.5 + 0.5) * 100
        return (
          <div key={col} style={{ position: 'absolute', left: col * colSize + colSize * 0.3, top: 0, width: colSize * 0.4, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {Array.from({ length: density }, (_, j) => {
              const charSeed = seed + j * 31.4 + Math.floor(f * 0.05 * speed)
              const char = dsSeeded(charSeed, charset)
              const age = (f * speed * 0.5 + colOffset + j * 8) % (density * 12)
              const charOp = age < density * 3 ? age / (density * 3) : age < density * 8 ? 1 - (age - density * 3) / (density * 5) * 0.4 : Math.max(0, 1 - (age - density * 8) / (density * 4))
              const isHead = j === Math.floor(age / 12) % density
              return <div key={j} style={{ fontSize: 11, fontFamily: M, color: isHead ? '#ffffff' : color, opacity: isHead ? Math.min(charOp * 2, 1) : charOp * 0.6, lineHeight: 1, textAlign: 'center' }}>{char}</div>
            })}
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 26. CIRCUIT BOARD
// ═══════════════════════════════════════════════════════════════
const cbSeededRandom = (seed) => { const x = Math.sin(seed * 9301 + 49297) * 49297; return x - Math.floor(x) }

export function CircuitBoard({ traceCount = 12, color = '#38bdf8', speed = 1, variant = 'clean', width = 600, height = 300 }) {
  const f = useAnimFrame()
  const traces = Array.from({ length: traceCount }, (_, i) => {
    const seed = i * 197.3
    const isHorizontal = cbSeededRandom(seed) > 0.4
    const segments = []
    let x = cbSeededRandom(seed + 1) * width * 0.8
    let y = cbSeededRandom(seed + 2) * height * 0.8 + height * 0.1
    segments.push({ x, y })
    const segCount = 3 + Math.floor(cbSeededRandom(seed + 3) * 4)
    for (let s = 0; s < segCount; s++) {
      if ((s + (isHorizontal ? 0 : 1)) % 2 === 0) x += (cbSeededRandom(seed + s * 10 + 4) - 0.3) * 300
      else y += (cbSeededRandom(seed + s * 10 + 5) - 0.3) * 200
      x = Math.max(50, Math.min(width - 50, x))
      y = Math.max(50, Math.min(height - 50, y))
      segments.push({ x, y })
    }
    return { segments, seed }
  })
  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden', pointerEvents: 'none' }}>
      <svg style={{ width: '100%', height: '100%' }} viewBox={`0 0 ${width} ${height}`}>
        {traces.map((trace, i) => {
          const pathD = trace.segments.map((s, j) => `${j === 0 ? 'M' : 'L'}${s.x},${s.y}`).join(' ')
          const pulsePos = ((f * 0.01 * speed + trace.seed * 0.1) % 1)
          const pulseSegIdx = Math.floor(pulsePos * (trace.segments.length - 1))
          const pulseT = (pulsePos * (trace.segments.length - 1)) - pulseSegIdx
          const ps = trace.segments[pulseSegIdx]
          const pe = trace.segments[Math.min(pulseSegIdx + 1, trace.segments.length - 1)]
          const px = ps.x + (pe.x - ps.x) * pulseT, py = ps.y + (pe.y - ps.y) * pulseT
          const traceOp = variant === 'dense' ? 0.12 : 0.06
          return (
            <g key={i}>
              <path d={pathD} fill="none" stroke={color} strokeWidth={variant === 'glow' ? 2 : 1} opacity={traceOp} />
              {trace.segments.map((s, j) => <circle key={j} cx={s.x} cy={s.y} r={1.5} fill={color} opacity={traceOp * 2} />)}
              <circle cx={px} cy={py} r={3} fill={color} opacity={0.6} />
              {variant === 'glow' && <circle cx={px} cy={py} r={8} fill={color} opacity={0.1} />}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 27. GLITCH TEXT
// ═══════════════════════════════════════════════════════════════
const GLITCH_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,./<>?'
const gtSeeded = (seed) => { const idx = Math.floor((Math.sin(seed * 9301 + 49297) * 49297 % 1 + 1) % 1 * GLITCH_CHARS.length); return GLITCH_CHARS[idx % GLITCH_CHARS.length] }

export function GlitchText({ text = 'QUOXCORE', delay = 0, scrambleDuration = 30, fontSize = 48, color = '#f5f5f5', glitchColor = '#38bdf8', variant = 'scramble', fontWeight = 800, letterSpacing = '-1px' }) {
  const f = useAnimFrame()
  const elapsed = f - delay
  if (elapsed < 0) return <div style={{ fontSize, fontWeight, fontFamily: M, color: 'transparent', letterSpacing }}>{text}</div>
  const progress = Math.min(elapsed / scrambleDuration, 1)
  const chars = text.split('').map((char, i) => {
    if (char === ' ') return ' '
    if (variant === 'typewriter') return elapsed >= (i / text.length) * scrambleDuration ? char : ''
    if (variant === 'decode') {
      const charProgress = lerp(elapsed, i * (scrambleDuration / text.length), i * (scrambleDuration / text.length) + 4, 0, 1)
      return charProgress >= 1 ? char : gtSeeded(i * 31 + Math.floor(elapsed * 3))
    }
    const charResolvePoint = i / text.length
    if (progress >= charResolvePoint + 0.1) return char
    if (progress < charResolvePoint - 0.1) return gtSeeded(i * 17 + Math.floor(elapsed * 2))
    return gtSeeded(i * 23 + Math.floor(elapsed * 5))
  })
  const isFullyResolved = progress >= 1
  return (
    <div style={{ fontSize, fontWeight, fontFamily: M, letterSpacing, color: isFullyResolved ? color : glitchColor, display: 'flex' }}>
      {chars.map((c, i) => {
        const charResolved = variant === 'scramble' ? progress >= (i / text.length) + 0.1 : variant === 'decode' ? elapsed >= i * (scrambleDuration / text.length) + 4 : elapsed >= (i / text.length) * scrambleDuration
        return <span key={i} style={{ color: charResolved ? color : glitchColor, opacity: charResolved ? 1 : 0.7, display: 'inline-block', minWidth: c === ' ' ? '0.3em' : undefined }}>{c}</span>
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 28. DNA HELIX
// ═══════════════════════════════════════════════════════════════
export function DNAHelix({ basePairs = 30, width = 300, height = 400, color1 = '#38bdf8', color2 = '#a855f7', speed = 1, amplitude = 80 }) {
  const f = useAnimFrame()
  const cx = width / 2
  const pairHeight = height / basePairs
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width, height }}>
      {Array.from({ length: basePairs }, (_, i) => {
        const y = i * pairHeight + pairHeight / 2
        const phase = (i / basePairs) * Math.PI * 4 + f * 0.03 * speed
        const x1 = cx + Math.sin(phase) * amplitude, x2 = cx + Math.sin(phase + Math.PI) * amplitude
        const z1 = Math.cos(phase), z2 = Math.cos(phase + Math.PI)
        const op1 = lerp(z1 * 0.5 + 0.5, 0, 1, 0.15, 0.8), op2 = lerp(z2 * 0.5 + 0.5, 0, 1, 0.15, 0.8)
        const r1 = lerp(z1 * 0.5 + 0.5, 0, 1, 2, 5), r2 = lerp(z2 * 0.5 + 0.5, 0, 1, 2, 5)
        const rungOp = lerp(Math.min(z1, z2) * 0.5 + 0.5, 0, 1, 0.03, 0.15)
        return (<g key={i}><line x1={x1} y1={y} x2={x2} y2={y} stroke="#ffffff" strokeWidth={1} opacity={rungOp} /><circle cx={x1} cy={y} r={r1} fill={color1} opacity={op1} /><circle cx={x2} cy={y} r={r2} fill={color2} opacity={op2} /></g>)
      })}
      {[color1, color2].map((col, si) => {
        const pathD = Array.from({ length: basePairs }, (_, i) => {
          const y = i * pairHeight + pairHeight / 2
          const phase = (i / basePairs) * Math.PI * 4 + f * 0.03 * speed + (si * Math.PI)
          const x = cx + Math.sin(phase) * amplitude
          return `${i === 0 ? 'M' : 'L'}${x},${y}`
        }).join(' ')
        return <path key={si} d={pathD} fill="none" stroke={col} strokeWidth={1.5} opacity={0.2} />
      })}
    </svg>
  )
}

// ═══════════════════════════════════════════════════════════════
// 29. THREAT LEVEL
// ═══════════════════════════════════════════════════════════════
const THREAT_LEVELS = [
  { num: 1, name: 'CRITICAL', color: '#ef4444', desc: 'Maximum readiness' },
  { num: 2, name: 'HIGH', color: '#f97316', desc: 'Elevated threat' },
  { num: 3, name: 'ELEVATED', color: '#f59e0b', desc: 'Increased alertness' },
  { num: 4, name: 'GUARDED', color: '#38bdf8', desc: 'General awareness' },
  { num: 5, name: 'NORMAL', color: '#30ff90', desc: 'Standard operations' },
]

export function ThreatLevel({ level = 5, variant = 'bars', label = 'THREAT LEVEL', animate = true, width = 400 }) {
  const f = useAnimFrame()
  const currentLevel = THREAT_LEVELS[level - 1] || THREAT_LEVELS[4]
  const pulse = animate && level <= 2 ? lerp(Math.sin(f * 0.12) * 0.5 + 0.5, 0, 1, 0.5, 1.0) : 1

  if (variant === 'numeric') {
    return (
      <div style={{ width, textAlign: 'center' }}>
        <div style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.7)', letterSpacing: '3px', marginBottom: 8 }}>{label}</div>
        <div style={{ fontSize: 72, fontWeight: 800, fontFamily: M, color: currentLevel.color, opacity: pulse }}>{level}</div>
        <div style={{ fontSize: 16, fontFamily: M, fontWeight: 700, color: currentLevel.color, letterSpacing: '3px', opacity: 0.8 }}>{currentLevel.name}</div>
        <div style={{ fontSize: 12, fontFamily: F, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>{currentLevel.desc}</div>
      </div>
    )
  }

  if (variant === 'arc') {
    const size = width, r = size * 0.4
    const startAngle = -Math.PI * 0.75, endAngle = Math.PI * 0.75, totalArc = endAngle - startAngle
    return (
      <div style={{ position: 'relative', width: size, height: size * 0.65 }}>
        <svg viewBox={`0 0 ${size} ${size * 0.65}`}>
          {THREAT_LEVELS.map((lvl, i) => {
            const segStart = startAngle + (i / 5) * totalArc, segEnd = startAngle + ((i + 1) / 5) * totalArc
            const x1 = size / 2 + Math.cos(segStart) * r, y1 = size * 0.55 + Math.sin(segStart) * r
            const x2 = size / 2 + Math.cos(segEnd) * r, y2 = size * 0.55 + Math.sin(segEnd) * r
            const isActive = lvl.num >= level
            return <path key={i} d={`M${x1},${y1} A${r},${r} 0 0 1 ${x2},${y2}`} fill="none" stroke={lvl.color} strokeWidth={isActive ? 8 : 4} opacity={isActive ? pulse * 0.7 : 0.15} strokeLinecap="round" />
          })}
          {(() => { const needleAngle = startAngle + ((level - 0.5) / 5) * totalArc; const nx = size / 2 + Math.cos(needleAngle) * (r - 15); const ny = size * 0.55 + Math.sin(needleAngle) * (r - 15); return <circle cx={nx} cy={ny} r={5} fill={currentLevel.color} opacity={pulse} /> })()}
        </svg>
        <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontFamily: M, fontWeight: 800, color: currentLevel.color, opacity: pulse }}>{currentLevel.name}</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ width }}>
      <div style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.7)', letterSpacing: '3px', marginBottom: 10 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {THREAT_LEVELS.map((lvl, i) => {
          const isActive = lvl.num >= level, isCurrent = lvl.num === level
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 6, background: isCurrent ? `${lvl.color}12` : 'transparent', border: isCurrent ? `1px solid ${lvl.color}30` : '1px solid transparent' }}>
              <div style={{ width: 24, fontSize: 14, fontWeight: 800, fontFamily: M, color: lvl.color, opacity: isActive ? pulse : 0.2 }}>{lvl.num}</div>
              <div style={{ flex: 1, height: 6, borderRadius: 3, background: isActive ? lvl.color : 'rgba(255,255,255,0.04)', opacity: isActive ? (isCurrent ? pulse * 0.8 : 0.3) : 0.1 }} />
              <div style={{ fontSize: 11, fontFamily: M, fontWeight: 600, color: lvl.color, opacity: isActive ? 0.7 : 0.15, width: 70 }}>{lvl.name}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 30. MEMORY CONSTELLATION
// ═══════════════════════════════════════════════════════════════
const MC_NODES = [
  { x: 0, y: 0, label: 'CORE', size: 20, color: '#38bdf8' },
  { x: -130, y: -90, label: 'Episodic', size: 13, color: '#ff6b6b' },
  { x: 130, y: -90, label: 'Semantic', size: 13, color: '#6366f1' },
  { x: -140, y: 70, label: 'Entity', size: 13, color: '#30ff90' },
  { x: 140, y: 70, label: 'Working', size: 13, color: '#f59e0b' },
  { x: -60, y: 130, label: 'Style', size: 10, color: '#ec4899' },
  { x: 80, y: 120, label: 'Search', size: 10, color: '#14b8a6' },
]

export function MemoryConstellation({ width = 400, height = 300, showLabels = true, variant = 'full' }) {
  const f = useAnimFrame()
  const progress = lerp(f, 0, 75, 0, 1)
  const cx = width / 2, cy = height / 2
  return (
    <div style={{ position: 'relative', width, height }}>
      <svg style={{ position: 'absolute', inset: 0 }} viewBox={`0 0 ${width} ${height}`}>
        {MC_NODES.slice(1).map((node, i) => {
          const lineOp = lerp(progress, (i + 1) / MC_NODES.length - 0.1, (i + 1) / MC_NODES.length + 0.1, 0, 0.25)
          return <line key={i} x1={cx} y1={cy} x2={cx + node.x} y2={cy + node.y} stroke={node.color} strokeWidth={1} opacity={Math.max(0, lineOp)} strokeDasharray="4 4" />
        })}
      </svg>
      {MC_NODES.map((node, i) => {
        const nodeOp = lerp(progress, i / MC_NODES.length - 0.05, i / MC_NODES.length + 0.15, 0, 1)
        const pulse = lerp(Math.sin(f * 0.04 + i * 0.8) * 0.5 + 0.5, 0, 1, 0.6, 1.0)
        const sz = variant === 'compact' ? node.size * 0.7 : node.size
        return (
          <div key={i} style={{ position: 'absolute', left: cx + node.x - sz, top: cy + node.y - sz, width: sz * 2, height: sz * 2, borderRadius: '50%', background: `radial-gradient(circle, ${node.color} 0%, ${node.color}40 50%, transparent 80%)`, opacity: Math.max(0, nodeOp) * pulse }}>
            {showLabels && i > 0 && <div style={{ position: 'absolute', top: sz * 2 + 6, left: '50%', transform: 'translateX(-50%)', fontSize: 10, fontFamily: M, color: node.color, opacity: 0.7, whiteSpace: 'nowrap', letterSpacing: '1px' }}>{node.label}</div>}
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 31. MATRIX RAIN
// ═══════════════════════════════════════════════════════════════
const MR_CHARSETS = { quox: [...'QUOXCOREAGENTFLOWVOLTWARDAEEAOCL0123456789ABCDEF'.split('')], hex: '0123456789ABCDEF'.split(''), binary: ['0', '1'] }
function mrSeededRandom(seed) { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 } }

export function MatrixRain({ columns = 20, speed = 1, charset = 'quox', color = '#38bdf8', density = 0.7, fade = 0.95, width = 600, height = 300 }) {
  const f = useAnimFrame()
  const chars = MR_CHARSETS[charset] || MR_CHARSETS.quox
  const colWidth = width / columns, rowHeight = 22, rows = Math.ceil(height / rowHeight) + 5
  const columnConfigs = useState(() => {
    const rng = mrSeededRandom(42)
    return Array.from({ length: columns }, () => ({ speed: 0.5 + rng() * 1.5, offset: Math.floor(rng() * rows * 3), trailLength: 8 + Math.floor(rng() * 20), active: rng() < density, charSeed: Math.floor(rng() * 10000) }))
  })[0]
  const introOpacity = lerp(f, 0, 15, 0, 1)
  return (
    <div style={{ width, height, backgroundColor: '#06070c', overflow: 'hidden', position: 'relative', opacity: introOpacity, borderRadius: 8 }}>
      {columnConfigs.map((col, colIdx) => {
        if (!col.active) return null
        const effectiveSpeed = col.speed * speed
        const headPos = ((f * effectiveSpeed * 0.5 + col.offset) % (rows + col.trailLength + 10)) - col.trailLength
        const colRng = mrSeededRandom(col.charSeed + f)
        return (
          <div key={colIdx} style={{ position: 'absolute', left: colIdx * colWidth, top: 0, width: colWidth, height: '100%' }}>
            {Array.from({ length: rows }, (_, rowIdx) => {
              const distFromHead = headPos - rowIdx
              if (distFromHead < 0 || distFromHead > col.trailLength) return null
              const brightness = Math.pow(fade, distFromHead)
              const isHead = distFromHead < 1, isNearHead = distFromHead < 3
              const charRng = mrSeededRandom(col.charSeed + rowIdx * 137 + Math.floor(f / (2 + rowIdx % 4)))
              const char = chars[Math.floor(charRng() * chars.length)]
              let charColor = isHead ? '#ffffff' : isNearHead ? color : `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},${brightness})`
              return (
                <div key={rowIdx} style={{ position: 'absolute', top: rowIdx * rowHeight, width: '100%', height: rowHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', color: charColor, fontSize: 14, fontFamily: M, fontWeight: isHead ? 'bold' : 'normal', textShadow: isHead ? `0 0 8px ${color}, 0 0 16px ${color}` : isNearHead ? `0 0 4px ${color}` : 'none', opacity: isHead ? 1 : brightness }}>{char}</div>
              )
            })}
          </div>
        )
      })}
      <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)', pointerEvents: 'none' }} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 32. PIE CHART 3D
// ═══════════════════════════════════════════════════════════════
const PC_SEGMENTS = [
  { value: 40, label: 'Plugins', color: '#38bdf8' },
  { value: 30, label: 'Enterprise', color: '#a78bfa' },
  { value: 15, label: 'Marketplace', color: '#34d399' },
  { value: 10, label: 'Contracts', color: '#fbbf24' },
  { value: 5, label: 'Other', color: '#f87171' },
]
function pcPolar(cx, cy, r, angleDeg) { const rad = ((angleDeg - 90) * Math.PI) / 180; return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) } }
function pcArc(cx, cy, r, s, e) { const st = pcPolar(cx, cy, r, e), en = pcPolar(cx, cy, r, s); return `M ${cx} ${cy} L ${st.x} ${st.y} A ${r} ${r} 0 ${e - s > 180 ? 1 : 0} 0 ${en.x} ${en.y} Z` }
function pcSideArc(cx, cy, r, s, e, d) { const s1 = pcPolar(cx, cy, r, s), e1 = pcPolar(cx, cy, r, e); return `M ${s1.x} ${s1.y} A ${r} ${r} 0 ${e - s > 180 ? 1 : 0} 1 ${e1.x} ${e1.y} L ${e1.x} ${e1.y + d} A ${r} ${r} 0 ${e - s > 180 ? 1 : 0} 0 ${s1.x} ${s1.y + d} Z` }
function pcDarken(hex, fac) { return `rgb(${Math.floor(parseInt(hex.slice(1, 3), 16) * fac)},${Math.floor(parseInt(hex.slice(3, 5), 16) * fac)},${Math.floor(parseInt(hex.slice(5, 7), 16) * fac)})` }

export function PieChart3D({ segments = PC_SEGMENTS, size = 280, depth = 25, tilt = 25, animate = true, showLabels = true }) {
  const f = useAnimFrame()
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  const radius = size / 2 - 20, cx = size / 2, cy = size / 2
  const sweepProgress = animate ? lerp(f, 0, 30, 0, 360) : 360
  const introScale = animate ? lerp(f, 0, 15, 0.7, 1) : 1
  const segmentData = []
  let currentAngle = 0
  segments.forEach((seg, i) => {
    const segAngle = (seg.value / total) * 360
    segmentData.push({ ...seg, startAngle: currentAngle, endAngle: currentAngle + segAngle, midAngle: currentAngle + segAngle / 2, index: i })
    currentAngle += segAngle
  })
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ perspective: 800 }}>
        <div style={{ transform: `rotateX(${tilt}deg) scale(${introScale})`, position: 'relative', width: size + 80, height: size + depth + 60 }}>
          <svg width={size + 80} height={size + depth + 60} viewBox={`-40 -10 ${size + 80} ${size + depth + 40}`}>
            {[...segmentData].sort((a, b) => Math.sin(((a.midAngle - 90) * Math.PI) / 180) - Math.sin(((b.midAngle - 90) * Math.PI) / 180)).map(seg => {
              const visibleEnd = Math.min(seg.endAngle, sweepProgress)
              if (visibleEnd <= seg.startAngle) return null
              return <g key={`side-${seg.index}`}><path d={pcSideArc(cx, cy, radius, seg.startAngle, visibleEnd, depth)} fill={pcDarken(seg.color, 0.5)} stroke={pcDarken(seg.color, 0.3)} strokeWidth={0.5} /></g>
            })}
            {segmentData.map(seg => {
              const visibleEnd = Math.min(seg.endAngle, sweepProgress)
              if (visibleEnd <= seg.startAngle) return null
              return <g key={`top-${seg.index}`}><path d={pcArc(cx, cy, radius, seg.startAngle, visibleEnd)} fill={seg.color} stroke="#06070c" strokeWidth={1.5} /></g>
            })}
            {showLabels && segmentData.map(seg => {
              if (sweepProgress < seg.endAngle) return null
              const pos = pcPolar(cx, cy, radius + 35, seg.midAngle)
              const labelOp = animate ? lerp(f, 30 + seg.index * 2, 35 + seg.index * 2, 0, 1) : 1
              const pct = Math.round((seg.value / total) * 100)
              return (<g key={`label-${seg.index}`} opacity={labelOp}><text x={pos.x} y={pos.y - 8} textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize={12} fontFamily={F} fontWeight="600">{seg.label}</text><text x={pos.x} y={pos.y + 10} textAnchor="middle" fill={seg.color} fontSize={11} fontFamily={F} fontWeight="500">{pct}%</text></g>)
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 33. AGENT LEADERBOARD
// ═══════════════════════════════════════════════════════════════
const LB_AGENTS = [
  { id: 'cipher', name: 'CIPHER', color: '#10b981', score: 98, successRate: 1.0, avgDurationMs: 1240, tokensUsed: 3420, taskCount: 12, trend: 'up' },
  { id: 'sentinel', name: 'WARDEN', color: '#ef4444', score: 94, successRate: 0.94, avgDurationMs: 2100, tokensUsed: 5800, taskCount: 18, trend: 'up' },
  { id: 'mnemonic', name: 'MNEMONIC', color: '#06b6d4', score: 91, successRate: 0.95, avgDurationMs: 890, tokensUsed: 2100, taskCount: 9, trend: 'flat' },
  { id: 'nova', name: 'DAEDALUS', color: '#8b5cf6', score: 85, successRate: 0.88, avgDurationMs: 3200, tokensUsed: 7400, taskCount: 14, trend: 'down' },
  { id: 'atlas', name: 'HYPERION', color: '#f59e0b', score: 79, successRate: 0.82, avgDurationMs: 4100, tokensUsed: 9200, taskCount: 11, trend: 'down' },
]
const LB_RANK_COLORS = ['#f59e0b', '#94a3b8', '#cd7f32']
const LB_TREND = { up: '\u2191', down: '\u2193', flat: '\u2192' }
const LB_TREND_COLORS = { up: '#10b981', down: '#ef4444', flat: '#71717a' }
function lbFmtDur(ms) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s` }
function lbFmtTok(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}` }

export function AgentLeaderboard({ agents = LB_AGENTS }) {
  const f = useAnimFrame()
  const sorted = [...agents].sort((a, b) => b.score - a.score)
  const maxScore = Math.max(...sorted.map(a => a.score), 1)
  return (
    <div style={{ fontFamily: F, width: '100%', minWidth: 400 }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 32, borderBottom: '1px solid rgba(255,255,255,0.08)', paddingLeft: 8, paddingRight: 8, gap: 8 }}>
        <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', width: 28 }}>#</span>
        <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1 }}>Agent</span>
        <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', width: 112 }}>Score</span>
        <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', width: 48, textAlign: 'right' }}>Rate</span>
        <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', width: 48, textAlign: 'right' }}>Dur</span>
        <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', width: 44, textAlign: 'right' }}>Tok</span>
        <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', width: 32, textAlign: 'right' }}>Tasks</span>
        <span style={{ width: 20 }} />
      </div>
      {sorted.map((agent, i) => {
        const rowOp = lerp(f, i * 2, i * 2 + 8, 0, 1)
        const fillWidth = lerp(f, 5 + i * 2, 15 + i * 2, 0, (agent.score / maxScore) * 80)
        const rankColor = i < 3 ? LB_RANK_COLORS[i] : 'rgba(255,255,255,0.6)'
        const rateColor = agent.successRate >= 0.9 ? '#10b981' : agent.successRate >= 0.7 ? '#f59e0b' : '#ef4444'
        return (
          <div key={agent.id} style={{ display: 'flex', alignItems: 'center', height: 40, borderBottom: '1px solid rgba(255,255,255,0.04)', paddingLeft: 8, paddingRight: 8, gap: 8, opacity: rowOp, background: i === 0 ? 'linear-gradient(90deg, rgba(245,158,11,0.04) 0%, transparent 60%)' : 'transparent' }}>
            <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: rankColor, width: 28 }}>{i + 1}</span>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: agent.color }} /><span style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{agent.name}</span></div>
            <div style={{ width: 112, display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 80, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}><div style={{ width: fillWidth, height: '100%', borderRadius: 3, background: `linear-gradient(90deg, ${agent.color}80, ${agent.color})` }} /></div><span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.7)', width: 24, textAlign: 'right' }}>{agent.score}</span></div>
            <span style={{ fontFamily: M, fontSize: 10, color: rateColor, width: 48, textAlign: 'right' }}>{(agent.successRate * 100).toFixed(0)}%</span>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)', width: 48, textAlign: 'right' }}>{lbFmtDur(agent.avgDurationMs)}</span>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)', width: 44, textAlign: 'right' }}>{lbFmtTok(agent.tokensUsed)}</span>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)', width: 32, textAlign: 'right' }}>{agent.taskCount}</span>
            <span style={{ fontSize: 12, color: LB_TREND_COLORS[agent.trend] || '#71717a', width: 20, textAlign: 'center', fontWeight: 700 }}>{LB_TREND[agent.trend] || ''}</span>
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 34. PIPELINE STAGE INDICATOR
// ═══════════════════════════════════════════════════════════════
const PI_STATUS_COLORS = { completed: '#10b981', active: '#3b82f6', pending: '#71717a', failed: '#ef4444' }
const PI_STAGES = [
  { name: 'Design', status: 'completed', taskCount: 3, completedCount: 3 },
  { name: 'Build', status: 'completed', taskCount: 5, completedCount: 5 },
  { name: 'Test', status: 'active', taskCount: 4, completedCount: 2 },
  { name: 'Deploy', status: 'pending', taskCount: 2, completedCount: 0 },
]

export function PipelineStageIndicator({ stages = PI_STAGES, compact = false, width = 620 }) {
  const f = useAnimFrame()
  const pillHeight = compact ? 22 : 30, fontSize = compact ? 10 : 12
  const arrowW = 32, totalArrows = stages.length - 1
  const pillWidth = Math.max(80, (width - totalArrows * arrowW - 24) / stages.length)
  return (
    <div style={{ width, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', fontFamily: F, paddingTop: 4 }}>
      {stages.map((stage, i) => {
        const color = PI_STATUS_COLORS[stage.status] || '#71717a'
        const entrance = lerp(f, i * 4, i * 4 + 10, 0, 1)
        const pulseOpacity = stage.status === 'active' ? 0.7 + 0.3 * Math.sin(f * 0.12) : 1
        return (
          <div key={i} style={{ display: 'contents' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: entrance, transform: `scale(${lerp(entrance, 0, 1, 0.85, 1)})` }}>
              <div style={{ width: pillWidth, height: pillHeight, borderRadius: pillHeight / 2, background: stage.status === 'completed' ? `${color}22` : stage.status === 'active' ? `${color}18` : '#1a1a2e', border: `1.5px solid ${color}${stage.status === 'pending' ? '44' : '88'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: pulseOpacity, position: 'relative' }}>
                {stage.status === 'active' && <div style={{ position: 'absolute', inset: -6, borderRadius: pillHeight, background: `radial-gradient(ellipse, ${color}20 0%, transparent 70%)`, pointerEvents: 'none' }} />}
                <span style={{ fontSize: fontSize - 1, lineHeight: '1', color }}>{stage.status === 'completed' ? '\u2713' : stage.status === 'failed' ? '\u2717' : stage.status === 'active' ? '\u25CF' : ''}</span>
                <span style={{ fontSize, fontWeight: 500, color: stage.status === 'pending' ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.85)' }}>{stage.name}</span>
              </div>
              {!compact && <div style={{ marginTop: 4, fontSize: compact ? 9 : 10, color: 'rgba(255,255,255,0.6)', fontFamily: M }}>{stage.completedCount}/{stage.taskCount}</div>}
            </div>
            {i < stages.length - 1 && (
              <div style={{ width: arrowW, height: pillHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: entrance * 0.5 }}>
                <svg width={arrowW} height={pillHeight} viewBox={`0 0 ${arrowW} ${pillHeight}`}><line x1={4} y1={pillHeight / 2} x2={arrowW - 8} y2={pillHeight / 2} stroke="rgba(255,255,255,0.6)" strokeWidth={1.5} strokeDasharray="3,3" /><polyline points={`${arrowW - 12},${pillHeight / 2 - 4} ${arrowW - 6},${pillHeight / 2} ${arrowW - 12},${pillHeight / 2 + 4}`} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 35. INBOX FEED
// ═══════════════════════════════════════════════════════════════
const IB_KIND = { approval: { color: '#3b82f6' }, question: { color: '#a855f7' }, task: { color: '#10b981' }, incident: { color: '#ef4444' }, info: { color: '#71717a' }, override_required: { color: '#f59e0b' } }
const IB_PRI = { urgent: { label: 'URG', color: '#ef4444' }, high: { label: 'HIGH', color: '#f59e0b' }, normal: { label: 'NORM', color: '#3b82f6' }, low: { label: 'LOW', color: '#71717a' } }
const IB_ITEMS = [
  { title: 'Deploy v2.4.0 to production', kind: 'approval', priority: 'high', status: 'open', source: 'VULCAN', unread: true },
  { title: 'edge-03 CPU at 94% — investigate?', kind: 'incident', priority: 'urgent', status: 'open', source: 'WARDEN', unread: true },
  { title: 'PR #142 requires security review', kind: 'task', priority: 'high', status: 'open', source: 'VULCAN', unread: true },
  { title: 'SSL cert expires in 14 days — renew?', kind: 'question', priority: 'normal', status: 'waiting', source: 'WARDEN', unread: false },
  { title: 'Override required: rate limit policy RL-007', kind: 'override_required', priority: 'high', status: 'open', source: 'AOCL', unread: true },
  { title: 'Backup verification complete — all clear', kind: 'info', priority: 'low', status: 'resolved', source: 'ops-agent', unread: false },
  { title: 'New user onboarding flow approval', kind: 'approval', priority: 'normal', status: 'open', source: 'VULCAN', unread: false },
  { title: 'Memory usage anomaly on hyp-02', kind: 'incident', priority: 'normal', status: 'in_progress', source: 'WARDEN', unread: false },
  { title: 'Staging environment ready for QA', kind: 'info', priority: 'low', status: 'resolved', source: 'VULCAN', unread: false },
  { title: 'Approve access request: dev-team-3', kind: 'approval', priority: 'normal', status: 'open', source: 'WARD', unread: false },
]

export function InboxFeed({ items = IB_ITEMS, maxVisible = 6, speed = 0.4 }) {
  const f = useAnimFrame()
  const rowHeight = 48, width = 520
  const scrollOffset = f * speed, totalHeight = items.length * rowHeight
  const unreadCount = items.filter(i => i.unread).length
  const startIdx = Math.floor(scrollOffset / rowHeight)
  const visibleItems = []
  for (let i = 0; i < maxVisible + 2; i++) {
    const idx = (startIdx + i) % items.length
    visibleItems.push({ ...items[idx], displayIdx: startIdx + i })
  }
  return (
    <div style={{ width, overflow: 'hidden', borderRadius: 14, background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.06)', fontFamily: F }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, fontFamily: M, color: 'rgba(59,130,246,0.7)', letterSpacing: '2px', fontWeight: 700 }}>INBOX</span>
          {unreadCount > 0 && <span style={{ fontSize: 9, fontFamily: M, fontWeight: 700, padding: '1px 6px', borderRadius: 8, background: '#3b82f620', color: '#3b82f6' }}>{unreadCount}</span>}
        </div>
        <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#3b82f6', opacity: lerp(Math.sin(f * 0.1) * 0.5 + 0.5, 0, 1, 0.4, 1.0) }} />
      </div>
      <div style={{ position: 'relative', height: maxVisible * rowHeight, overflow: 'hidden' }}>
        {visibleItems.map((item) => {
          const yPos = (item.displayIdx * rowHeight) - scrollOffset
          const localY = yPos % (totalHeight || 1)
          const fadeRatio = localY / (maxVisible * rowHeight)
          const opacity = fadeRatio < 0.1 ? fadeRatio * 10 : fadeRatio > 0.9 ? (1 - fadeRatio) * 10 : 1
          const kindCfg = IB_KIND[item.kind] || IB_KIND.info
          const priCfg = IB_PRI[item.priority] || IB_PRI.normal
          return (
            <div key={`${item.displayIdx}`} style={{ position: 'absolute', left: 0, right: 0, top: localY, height: rowHeight, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10, opacity, borderBottom: '1px solid rgba(255,255,255,0.03)', background: item.unread ? 'rgba(255,255,255,0.02)' : 'transparent', borderLeft: item.unread ? `2px solid ${kindCfg.color}40` : '2px solid transparent' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: kindCfg.color, opacity: item.unread ? 1 : 0.4, flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 12, fontWeight: item.unread ? 600 : 400, color: item.unread ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
              <div style={{ fontSize: 8, fontFamily: M, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: `${priCfg.color}15`, color: priCfg.color, letterSpacing: '0.5px', flexShrink: 0 }}>{priCfg.label}</div>
              <div style={{ fontSize: 9, fontFamily: M, color: kindCfg.color, opacity: 0.7, width: 55, textAlign: 'right', flexShrink: 0 }}>{item.source}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// BATCH 2 — 15 Components adapted from quox-remotion
// ═══════════════════════════════════════════════════════════════

// ─── 16. STARFIELD ─────────────────────────────────────────────
const SF_CYAN = '#38bdf8'
const SF_INDIGO = '#6366f1'
export function Starfield({ layers = 3, density = 30, speed = 1, shootingStars = 2, warp = 0 }) {
  const f = useAnimFrame()
  return (
    <div style={{ position: 'relative', width: '100%', height: 300, overflow: 'hidden' }}>
      {Array.from({ length: layers }, (_, layerIdx) => {
        const layerSpeed = (layerIdx + 1) * 0.3 * speed
        const starSize = 1 + layerIdx * 0.4
        const maxOp = 0.15 + layerIdx * 0.1
        return Array.from({ length: density }, (_, i) => {
          const seed = (layerIdx * 1000 + i) * 97.3
          const baseX = (seed * 11.7) % 650
          const baseY = (seed * 17.3) % 300
          const driftX = Math.sin(f * 0.01 * layerSpeed + seed) * (5 + layerIdx * 3)
          const driftY = Math.cos(f * 0.008 * layerSpeed + seed) * (3 + layerIdx * 2)
          const twinkle = lerp(Math.sin(f * 0.03 + seed), -1, 1, 0.03, maxOp)
          const stretchW = warp > 0 ? starSize + warp * 20 * layerSpeed : starSize
          return (
            <div key={`${layerIdx}-${i}`} style={{
              position: 'absolute', left: baseX + driftX, top: baseY + driftY,
              width: stretchW, height: starSize,
              borderRadius: warp > 0.5 ? '1px' : '50%',
              backgroundColor: i % 7 === 0 ? SF_CYAN : i % 11 === 0 ? SF_INDIGO : '#ffffff',
              opacity: twinkle,
              transform: warp > 0 ? `rotate(${Math.atan2(driftY, driftX) * 180 / Math.PI}deg)` : 'none',
            }} />
          )
        })
      })}
      {Array.from({ length: shootingStars }, (_, i) => {
        const seed = i * 347.7
        const cycleDuration = 150 + i * 60
        const cyclePos = (f + seed) % cycleDuration
        const progress = cyclePos / cycleDuration
        const visible = progress < 0.15
        if (!visible) return null
        const trailProgress = progress / 0.15
        const startX = (seed * 3.7) % 400 + 50
        const startY = (seed * 5.3) % 100 + 20
        const endX = startX + 200
        const endY = startY + 100
        const x = startX + (endX - startX) * trailProgress
        const y = startY + (endY - startY) * trailProgress
        const op = trailProgress < 0.3 ? trailProgress / 0.3 * 0.6 : trailProgress > 0.7 ? (1 - trailProgress) / 0.3 * 0.4 : 0.5
        const angle = Math.atan2(endY - startY, endX - startX) * 180 / Math.PI
        return (
          <div key={`shoot-${i}`} style={{
            position: 'absolute', left: x, top: y,
            width: 80 + i * 20, height: 1.5,
            background: `linear-gradient(90deg, transparent, ${SF_CYAN}90, ${SF_CYAN}20)`,
            transform: `rotate(${angle}deg)`, transformOrigin: '100% 50%', opacity: op,
          }} />
        )
      })}
    </div>
  )
}

// ─── 17. KITT SCANNER ──────────────────────────────────────────
export function KITTScanner({ width = 600, segments = 20, color = '#38bdf8', speed = 1, variant = 'kitt', height = 8, intensity = 1.0 }) {
  const f = useAnimFrame()
  const segWidth = (width - (segments - 1) * 2) / segments
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', width }}>
      {Array.from({ length: segments }, (_, i) => {
        let segOp
        const center = i / (segments - 1)
        if (variant === 'kitt') {
          const scanPos = (Math.sin(f * 0.08 * speed) + 1) / 2
          const dist = Math.abs(center - scanPos)
          segOp = dist < 0.15 ? 1 - dist / 0.15 * 0.6 : dist < 0.3 ? 0.4 - (dist - 0.15) / 0.15 * 0.35 : 0.05
        } else if (variant === 'spectrum') {
          const seed = i * 73.7
          segOp = (Math.sin(f * 0.12 * speed + seed * 0.1) * Math.cos(f * 0.06 + seed) + 1) / 2 * 0.72 + 0.08
        } else {
          const seed = i * 137.5
          segOp = Math.sin(f * 0.2 * speed + seed) > 0.3 ? 0.7 : 0.05
        }
        segOp *= intensity
        const segH = variant === 'spectrum' ? height * (0.3 + segOp * 0.7) : height
        return <div key={i} style={{ width: segWidth, height: segH, borderRadius: 2, backgroundColor: color, opacity: segOp }} />
      })}
    </div>
  )
}

// ─── 18. HASH CHAIN ────────────────────────────────────────────
const HC_CYAN = '#38bdf8'
const HC_GREEN = '#30ff90'
const HC_BLOCKS = [
  { hash: 'a7f3c2', label: 'allow', color: HC_CYAN },
  { hash: 'd91e4b', label: 'restart', color: '#06b6d4' },
  { hash: 'f28a71', label: 'approve', color: '#a855f7' },
  { hash: 'c54d09', label: 'block', color: '#ef4444' },
  { hash: '8b2e63', label: 'scale', color: '#f59e0b' },
  { hash: '1f4a8c', label: 'deploy', color: HC_GREEN },
]
export function HashChain({ blocks = HC_BLOCKS, direction = 'horizontal', compact = false, showVerified = true, color = HC_CYAN }) {
  const f = useAnimFrame()
  const isH = direction === 'horizontal'
  const blockW = compact ? 90 : 130
  const blockPad = compact ? '6px 8px' : '10px 14px'
  const revealSpeed = 10
  const allRevealed = f > blocks.length * revealSpeed + 15
  return (
    <div style={{ display: 'flex', flexDirection: isH ? 'row' : 'column', alignItems: 'center', gap: 0, flexWrap: 'wrap' }}>
      {blocks.map((block, i) => {
        const blockOp = lerp(f, i * revealSpeed, i * revealSpeed + 8, 0, 1)
        const pulse = lerp(Math.sin(f * 0.08 + i * 0.5), -1, 1, 0.6, 1.0)
        return (
          <div key={i} style={{ display: 'flex', alignItems: isH ? 'center' : 'center', flexDirection: isH ? 'row' : 'column' }}>
            <div style={{
              opacity: blockOp, width: blockW, padding: blockPad, borderRadius: compact ? 6 : 8,
              background: `${block.color || color}08`, border: `1px solid ${block.color || color}20`, textAlign: 'center',
            }}>
              <div style={{ fontSize: compact ? 8 : 10, fontFamily: M, color: block.color || color, opacity: pulse, marginBottom: compact ? 2 : 4 }}>{block.hash}...</div>
              <div style={{ fontSize: compact ? 10 : 13, fontFamily: F, color: '#f5f5f5', fontWeight: 600 }}>{block.label}</div>
              {i > 0 && !compact && <div style={{ fontSize: 8, fontFamily: M, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>← {blocks[i - 1].hash}</div>}
            </div>
            {i < blocks.length - 1 && (
              <div style={{ opacity: blockOp * 0.5, margin: isH ? '0 3px' : '3px 0' }}>
                {isH ? <svg width={16} height={12}><polygon points="4,1 14,6 4,11" fill={color} opacity={0.4} /></svg>
                  : <svg width={12} height={16}><polygon points="1,4 6,14 11,4" fill={color} opacity={0.4} /></svg>}
              </div>
            )}
          </div>
        )
      })}
      {showVerified && allRevealed && (
        <div style={{ marginLeft: isH ? 16 : 0, marginTop: isH ? 0 : 16, display: 'flex', alignItems: 'center', gap: 6, opacity: lerp(f, blocks.length * revealSpeed + 15, blocks.length * revealSpeed + 22, 0, 1) }}>
          <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${HC_GREEN}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: HC_GREEN, fontWeight: 700 }}>✓</div>
          <div style={{ fontSize: 10, fontFamily: M, color: HC_GREEN, letterSpacing: '1px', fontWeight: 600 }}>VERIFIED</div>
        </div>
      )}
    </div>
  )
}

// ─── 19. FLOW DIAGRAM ──────────────────────────────────────────
const FD_NODES = [
  { x: 60, y: 130, label: 'Trigger', color: '#22c55e', icon: '⚡' },
  { x: 210, y: 130, label: 'AI Agent', color: '#6366f1', icon: '◈' },
  { x: 370, y: 70, label: 'Process', color: '#f59e0b', icon: '▶' },
  { x: 370, y: 190, label: 'Approve', color: '#ec4899', icon: '✓' },
  { x: 530, y: 130, label: 'Output', color: '#06b6d4', icon: '◎' },
]
const FD_EDGES = [[0, 1], [1, 2], [1, 3], [2, 4], [3, 4]]
export function FlowDiagram({ nodes = FD_NODES, edges = FD_EDGES, width = 620, height = 260, showPulse = true, variant = 'clean' }) {
  const f = useAnimFrame()
  const activateSpeed = 15
  return (
    <div style={{ position: 'relative', width, height }}>
      <svg style={{ position: 'absolute', inset: 0, width, height }}>
        {edges.map(([from, to], i) => {
          const n1 = nodes[from], n2 = nodes[to]
          const edgeOp = lerp(f, i * activateSpeed + 5, i * activateSpeed + 12, 0, 1)
          const lineColor = variant === 'neon' ? n1.color : '#38bdf8'
          return (
            <g key={`edge-${i}`} opacity={edgeOp}>
              <line x1={n1.x} y1={n1.y} x2={n2.x} y2={n2.y} stroke={lineColor} strokeWidth={variant === 'neon' ? 2 : 1} opacity={0.3} strokeDasharray={variant === 'circuit' ? '6 3' : 'none'} />
              {showPulse && edgeOp > 0.5 && (() => {
                const pulsePos = (f * 0.04 + i * 0.3) % 1
                const px = n1.x + (n2.x - n1.x) * pulsePos
                const py = n1.y + (n2.y - n1.y) * pulsePos
                return <circle cx={px} cy={py} r={variant === 'neon' ? 4 : 3} fill={lineColor} opacity={0.8} />
              })()}
            </g>
          )
        })}
      </svg>
      {nodes.map((node, i) => {
        const nodeOp = lerp(f, i * activateSpeed, i * activateSpeed + 8, 0, 1)
        const isActive = f > i * activateSpeed + 8
        const pulse = isActive ? lerp(Math.sin(f * 0.12 + i), -1, 1, 0.7, 1.0) : 0.5
        return (
          <div key={i} style={{ position: 'absolute', left: node.x - 40, top: node.y - 30, width: 80, textAlign: 'center', opacity: nodeOp }}>
            <div style={{ width: 42, height: 42, margin: '0 auto', borderRadius: '50%', background: `radial-gradient(circle, ${node.color}30 0%, ${node.color}08 70%, transparent 100%)`, border: `1.5px solid ${node.color}${isActive ? '60' : '25'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, opacity: pulse }}>{node.icon}</div>
            <div style={{ fontSize: 11, fontFamily: variant === 'circuit' ? M : F, fontWeight: 600, color: node.color, marginTop: 4, opacity: 0.8 }}>{node.label}</div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 20. LAYER STACK ───────────────────────────────────────────
const LS_LAYERS = [
  { id: 'L0', name: 'INGRESS', desc: 'Event normalisation', color: '#64748b' },
  { id: 'L1', name: 'IDENTITY', desc: 'Authentication', color: '#3b82f6' },
  { id: 'L2', name: 'ROUTE', desc: 'Intent classification', color: '#06b6d4' },
  { id: 'L3', name: 'POLICY', desc: 'Safety and authorisation', color: '#f59e0b' },
  { id: 'L4', name: 'PLAN', desc: 'Multi-step planning', color: '#a855f7' },
  { id: 'L5', name: 'CONTEXT', desc: 'Memory and RAG', color: '#8b5cf6' },
  { id: 'L6', name: 'SHAPE', desc: 'Prompt engineering', color: '#6366f1' },
  { id: 'L7', name: 'DELEGATE', desc: 'Execution', color: '#f97316' },
  { id: 'L8', name: 'VERIFY', desc: 'Output validation', color: '#14b8a6' },
  { id: 'L9', name: 'ASSEMBLE', desc: 'Response composition', color: '#22c55e' },
  { id: 'L10', name: 'AUDIT', desc: 'Persistence', color: '#64748b' },
]
export function LayerStack({ variant = 'full', direction = 'vertical', showLabels = true, animate = true }) {
  const f = useAnimFrame()
  const animSpeed = 10
  const effectiveActive = animate ? Math.floor(lerp(f, 0, LS_LAYERS.length * animSpeed, -1, LS_LAYERS.length - 1)) : LS_LAYERS.length - 1
  const isCompact = variant === 'compact' || variant === 'minimal'
  const isH = direction === 'horizontal'
  return (
    <div style={{ display: 'flex', flexDirection: isH ? 'row' : 'column', gap: isH ? 4 : 2 }}>
      {LS_LAYERS.map((layer, i) => {
        const isActive = i <= effectiveActive
        const pulse = isActive ? lerp(Math.sin(f * 0.16 + i * 0.3), -1, 1, 0.6, 1.0) : 0.15
        if (variant === 'minimal') {
          return <div key={i} style={{ width: isH ? 8 : 40, height: isH ? 40 : 4, borderRadius: 2, backgroundColor: layer.color, opacity: pulse }} />
        }
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: isCompact ? 6 : 10, padding: isCompact ? '3px 8px' : '5px 12px', background: isActive ? `${layer.color}10` : 'transparent', borderRadius: 4 }}>
            <div style={{ width: isCompact ? 3 : 5, height: isCompact ? 16 : 24, borderRadius: 2, backgroundColor: layer.color, opacity: pulse }} />
            <div style={{ fontFamily: M, fontSize: isCompact ? 10 : 12, fontWeight: 700, color: layer.color, opacity: pulse, width: isCompact ? 22 : 28 }}>{layer.id}</div>
            <div style={{ fontFamily: F, fontSize: isCompact ? 10 : 14, fontWeight: 600, color: isActive ? '#f5f5f5' : 'rgba(255,255,255,0.6)', opacity: isActive ? 1 : 0.4 }}>{layer.name}</div>
            {showLabels && !isCompact && <div style={{ fontFamily: F, fontSize: 12, color: 'rgba(255,255,255,0.7)', opacity: isActive ? 0.6 : 0.2, marginLeft: 4 }}>{layer.desc}</div>}
            {isActive && <div style={{ marginLeft: 'auto', fontSize: isCompact ? 8 : 10, fontFamily: M, color: '#30ff90', opacity: 0.7 }}>✓</div>}
          </div>
        )
      })}
    </div>
  )
}

// ─── 21. AGENT SWARM ───────────────────────────────────────────
const AS_AGENTS = [
  { name: 'CommanderQ', tier: 0, color: '#38bdf8', x: 280, y: 40 },
  { name: 'VULCAN', tier: 1, color: '#a855f7', x: 120, y: 130 },
  { name: 'MESHNET', tier: 1, color: '#6366f1', x: 280, y: 140 },
  { name: 'NETWATCH', tier: 1, color: '#30ff90', x: 440, y: 130 },
  { name: 'ops', tier: 2, color: '#f59e0b', x: 50, y: 230 },
  { name: 'data', tier: 2, color: '#14b8a6', x: 170, y: 240 },
  { name: 'security', tier: 2, color: '#ef4444', x: 280, y: 250 },
  { name: 'support', tier: 2, color: '#ec4899', x: 390, y: 240 },
  { name: 'deploy', tier: 2, color: '#f97316', x: 510, y: 230 },
]
const AS_CONNS = [[0,1],[0,2],[0,3],[1,4],[1,5],[2,6],[3,7],[3,8]]
export function AgentSwarm({ agents = AS_AGENTS, connections = AS_CONNS, width = 560, height = 280 }) {
  const f = useAnimFrame()
  const autoReveal = lerp(f, 0, 90, 0, 1)
  return (
    <div style={{ position: 'relative', width, height }}>
      <svg style={{ position: 'absolute', inset: 0, width, height }}>
        {connections.map(([from, to], i) => {
          const lineOp = lerp(autoReveal, 0.15 + i * 0.05, 0.25 + i * 0.05, 0, 0.25)
          return <line key={i} x1={agents[from].x} y1={agents[from].y} x2={agents[to].x} y2={agents[to].y} stroke={agents[from].color} strokeWidth={1} opacity={lineOp} strokeDasharray="3 3" />
        })}
      </svg>
      {agents.map((agent, i) => {
        const agentOp = lerp(autoReveal, i * 0.08, i * 0.08 + 0.12, 0, 1)
        const pulse = lerp(Math.sin(f * 0.1 + i * 0.7), -1, 1, 0.5, 1.0)
        const dotSize = agent.tier === 0 ? 14 : agent.tier === 1 ? 10 : 7
        return (
          <div key={i} style={{ position: 'absolute', left: agent.x - dotSize, top: agent.y - dotSize, opacity: agentOp, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: dotSize * 2, height: dotSize * 2, borderRadius: '50%', background: `radial-gradient(circle, ${agent.color} 0%, ${agent.color}30 60%, transparent 100%)`, opacity: pulse }} />
            <div style={{ fontSize: agent.tier === 0 ? 11 : 9, fontFamily: M, fontWeight: 700, color: agent.color, opacity: 0.8, marginTop: 3, whiteSpace: 'nowrap' }}>{agent.name}</div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 22. STATUS GRID ───────────────────────────────────────────
const SG_SERVICES = [
  { name: 'edge-01', status: 'online', value: 'CPU 12%', color: '#30ff90' },
  { name: 'edge-02', status: 'online', value: 'CPU 8%', color: '#30ff90' },
  { name: 'edge-03', status: 'warning', value: 'CPU 94%', color: '#f59e0b' },
  { name: 'edge-04', status: 'online', value: 'CPU 23%', color: '#30ff90' },
  { name: 'hyp-01', status: 'online', value: 'MEM 62%', color: '#30ff90' },
  { name: 'hyp-02', status: 'online', value: 'MEM 41%', color: '#30ff90' },
  { name: 'hyp-03', status: 'offline', value: 'DOWN', color: '#ef4444' },
  { name: 'gw-01', status: 'online', value: 'SSH OK', color: '#30ff90' },
  { name: 'nginx', status: 'online', value: '200 OK', color: '#30ff90' },
  { name: 'postgres', status: 'online', value: 'CONN 12', color: '#38bdf8' },
  { name: 'qdrant', status: 'online', value: 'VEC 8.2K', color: '#a855f7' },
  { name: 'collector', status: 'online', value: 'REQ 142/m', color: '#30ff90' },
]
export function StatusGrid({ services = SG_SERVICES, cols = 4, variant = 'tiles' }) {
  const f = useAnimFrame()
  if (variant === 'list') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {services.map((svc, i) => {
          const op = lerp(f, i * 2, i * 2 + 5, 0, 1)
          return (
            <div key={i} style={{ opacity: op, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: svc.color, flexShrink: 0 }} />
              <div style={{ fontSize: 13, fontFamily: M, color: '#f5f5f5', width: 100 }}>{svc.name}</div>
              <div style={{ fontSize: 12, fontFamily: M, color: svc.color, marginLeft: 'auto' }}>{svc.value}</div>
            </div>
          )
        })}
      </div>
    )
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8 }}>
      {services.map((svc, i) => {
        const op = lerp(f, i * 3, i * 3 + 6, 0, 1)
        const pulse = svc.status === 'warning' ? lerp(Math.sin(f * 0.2 + i), -1, 1, 0.5, 1.0)
          : svc.status === 'offline' ? lerp(Math.sin(f * 0.3), -1, 1, 0.3, 0.8) : 1
        return (
          <div key={i} style={{ opacity: op, padding: '12px 14px', borderRadius: 10, background: `${svc.color}06`, border: `1px solid ${svc.color}15` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: svc.color, opacity: pulse }} />
              <div style={{ fontSize: 13, fontFamily: M, fontWeight: 700, color: '#f5f5f5' }}>{svc.name}</div>
            </div>
            <div style={{ fontSize: 12, fontFamily: M, color: svc.color, opacity: 0.8 }}>{svc.value}</div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 23. METRIC CARD ───────────────────────────────────────────
export function MetricCard({ value = '1,247', label = 'Active Users', trend = 'up', trendValue = '+12%', color = '#38bdf8', sparkline = [20, 35, 28, 45, 52, 48, 60, 55, 72, 68, 78, 85], variant = 'default' }) {
  const f = useAnimFrame()
  const trendColors = { up: '#30ff90', down: '#ef4444', flat: 'rgba(255,255,255,0.7)' }
  const trendArrows = { up: '↑', down: '↓', flat: '→' }
  const tc = trendColors[trend]
  const numericValue = parseInt(value.replace(/[^0-9]/g, ''))
  const displayValue = !isNaN(numericValue) ? Math.floor(lerp(f, 0, 20, 0, numericValue)).toLocaleString() : value
  const sparkW = variant === 'hero' ? 200 : 120
  const sparkH = variant === 'hero' ? 50 : 30
  const sparkMax = Math.max(...sparkline, 1)
  const sparkPath = sparkline.map((v, i) => {
    const x = (i / (sparkline.length - 1)) * sparkW
    const y = sparkH - (v / sparkMax) * sparkH * 0.8 - sparkH * 0.1
    return `${i === 0 ? 'M' : 'L'}${x},${y}`
  }).join(' ')
  if (variant === 'hero') {
    return (
      <div style={{ padding: '28px 32px', borderRadius: 16, background: `${color}06`, border: `1px solid ${color}18`, minWidth: 280 }}>
        <div style={{ fontSize: 12, fontFamily: F, fontWeight: 600, color: 'rgba(255,255,255,0.7)', letterSpacing: '2px', textTransform: 'uppercase' }}>{label}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 8 }}>
          <div style={{ fontSize: 48, fontWeight: 800, fontFamily: M, color }}>{displayValue}</div>
          <div style={{ fontSize: 16, fontWeight: 600, fontFamily: M, color: tc }}>{trendArrows[trend]} {trendValue}</div>
        </div>
        <svg viewBox={`0 0 ${sparkW} ${sparkH}`} style={{ width: sparkW, height: sparkH, marginTop: 12 }}>
          <path d={sparkPath} fill="none" stroke={color} strokeWidth={2} opacity={0.5} />
          <path d={sparkPath + ` L${sparkW},${sparkH} L0,${sparkH} Z`} fill={color} opacity={0.05} />
        </svg>
      </div>
    )
  }
  if (variant === 'compact') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ fontSize: 20, fontWeight: 800, fontFamily: M, color }}>{displayValue}</div>
        <div style={{ fontSize: 11, fontFamily: F, color: 'rgba(255,255,255,0.7)' }}>{label}</div>
        <div style={{ fontSize: 11, fontFamily: M, color: tc, marginLeft: 'auto' }}>{trendArrows[trend]} {trendValue}</div>
      </div>
    )
  }
  return (
    <div style={{ padding: '18px 22px', borderRadius: 12, background: `${color}06`, border: `1px solid ${color}15`, minWidth: 200 }}>
      <div style={{ fontSize: 10, fontFamily: F, fontWeight: 600, color: 'rgba(255,255,255,0.7)', letterSpacing: '2px', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
        <div style={{ fontSize: 32, fontWeight: 800, fontFamily: M, color }}>{displayValue}</div>
        <div style={{ fontSize: 13, fontWeight: 600, fontFamily: M, color: tc }}>{trendArrows[trend]} {trendValue}</div>
      </div>
      <svg viewBox={`0 0 ${sparkW} ${sparkH}`} style={{ width: sparkW, height: sparkH, marginTop: 8 }}>
        <path d={sparkPath} fill="none" stroke={color} strokeWidth={1.5} opacity={0.4} />
      </svg>
    </div>
  )
}

// ─── 24. CONVERSATION BUBBLE ───────────────────────────────────
const CB_MSGS = [
  { text: 'Check the status of edge-03', sender: 'human', color: '#38bdf8', delay: 0 },
  { text: 'edge-03 is showing high CPU usage at 94%. The cause is a scheduled backup running on the postgres container. No action needed.', sender: 'ai', color: '#30ff90', delay: 15 },
  { text: 'Got it. Monitor and alert if it exceeds 15 minutes.', sender: 'human', color: '#38bdf8', delay: 10 },
  { text: 'Monitoring active. I will alert you if the backup exceeds 15 minutes or CPU remains above 90% after completion.', sender: 'ai', color: '#30ff90', delay: 12 },
]
export function ConversationBubble({ messages = CB_MSGS, width = 600, charSpeed = 0.6, variant = 'chat' }) {
  const f = useAnimFrame()
  let cumDelay = 0
  const msgData = messages.map(msg => {
    const start = cumDelay + (msg.delay || 0)
    const typeDur = msg.text.length * charSpeed
    cumDelay = start + typeDur + 4
    return { ...msg, start, typeDur }
  })
  return (
    <div style={{ width, display: 'flex', flexDirection: 'column', gap: variant === 'terminal' ? 4 : 10, padding: variant === 'terminal' ? '16px' : 0, background: variant === 'terminal' ? 'rgba(255,255,255,0.02)' : 'transparent', borderRadius: variant === 'terminal' ? 12 : 0, border: variant === 'terminal' ? '1px solid rgba(255,255,255,0.06)' : 'none' }}>
      {msgData.map((msg, i) => {
        if (f < msg.start) return null
        const chars = Math.floor(lerp(f, msg.start, msg.start + msg.typeDur, 0, msg.text.length))
        const isComplete = chars >= msg.text.length
        const isHuman = msg.sender === 'human'
        if (variant === 'terminal') {
          return (
            <div key={i} style={{ fontFamily: M, fontSize: 14, lineHeight: 1.6 }}>
              <span style={{ color: isHuman ? '#38bdf8' : '#30ff90', fontWeight: 700 }}>{isHuman ? 'you' : 'commanderq'}</span>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>{' > '}</span>
              <span style={{ color: isHuman ? 'rgba(255,255,255,0.7)' : '#f5f5f5' }}>{msg.text.slice(0, chars)}</span>
            </div>
          )
        }
        return (
          <div key={i} style={{ display: 'flex', justifyContent: isHuman ? 'flex-end' : 'flex-start', opacity: lerp(f, msg.start, msg.start + 4, 0, 1) }}>
            <div style={{ maxWidth: '75%', padding: '10px 16px', borderRadius: 14, borderBottomRightRadius: isHuman ? 4 : 14, borderBottomLeftRadius: isHuman ? 14 : 4, background: isHuman ? `${msg.color}15` : 'rgba(255,255,255,0.04)', border: `1px solid ${isHuman ? `${msg.color}25` : 'rgba(255,255,255,0.06)'}` }}>
              {!isHuman && <div style={{ fontSize: 10, fontFamily: M, color: msg.color, fontWeight: 700, letterSpacing: '1px', marginBottom: 4 }}>COMMANDERQ</div>}
              <div style={{ fontSize: 15, fontFamily: F, color: isHuman ? 'rgba(255,255,255,0.7)' : '#f5f5f5', lineHeight: 1.5 }}>
                {msg.text.slice(0, chars)}
                {!isComplete && <span style={{ display: 'inline-block', width: 6, height: 14, backgroundColor: msg.color, opacity: Math.floor(f / 8) % 2 === 0 ? 0.7 : 0, marginLeft: 2, verticalAlign: 'text-bottom' }} />}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 25. PARTICLE VORTEX ───────────────────────────────────────
export function ParticleVortex({ particleCount = 50, cx = 300, cy = 150, maxRadius = 140, minRadius = 15, speed = 1, colors = ['#38bdf8', '#6366f1', '#a855f7', '#06b6d4', '#30ff90'], variant = 'inward' }) {
  const f = useAnimFrame()
  return (
    <div style={{ position: 'relative', width: cx * 2, height: cy * 2, overflow: 'hidden', pointerEvents: 'none' }}>
      {Array.from({ length: particleCount }, (_, i) => {
        const seed = i * 137.508
        const baseAngle = (i / particleCount) * Math.PI * 2
        const angleOffset = f * 0.04 * speed * (1 + (i % 3) * 0.3)
        const angle = baseAngle + angleOffset
        let radius
        if (variant === 'inward') {
          const spiralPhase = ((f * 0.01 * speed + seed * 0.01) % 1)
          radius = maxRadius * (1 - spiralPhase) + minRadius * spiralPhase
        } else if (variant === 'outward') {
          const spiralPhase = ((f * 0.01 * speed + seed * 0.01) % 1)
          radius = minRadius * (1 - spiralPhase) + maxRadius * spiralPhase
        } else {
          const baseR = minRadius + (maxRadius - minRadius) * (Math.sin(seed) * 0.5 + 0.5)
          radius = baseR + Math.sin(f * 0.06 + seed) * 15
        }
        const x = cx + Math.cos(angle) * radius
        const y = cy + Math.sin(angle) * radius
        const distRatio = (radius - minRadius) / (maxRadius - minRadius)
        const size = variant === 'inward' ? 1.5 + (1 - distRatio) * 2.5 : 2 + distRatio * 1
        const opacity = distRatio < 0.3 ? 0.8 - distRatio : distRatio < 0.7 ? 0.5 - (distRatio - 0.3) * 0.5 : 0.1 + (1 - distRatio) * 0.2
        const color = colors[i % colors.length]
        return <div key={i} style={{ position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size, borderRadius: '50%', backgroundColor: color, opacity }} />
      })}
      <div style={{ position: 'absolute', left: cx - minRadius * 2, top: cy - minRadius * 2, width: minRadius * 4, height: minRadius * 4, borderRadius: '50%', background: `radial-gradient(circle, ${colors[0]}20 0%, transparent 70%)` }} />
    </div>
  )
}

// ─── 26. COGNITIVE CORE ────────────────────────────────────────
const CC_RINGS = [
  { radius: 60, color: '#6366f1', nodes: ['Identity', 'Context', 'Self'], speed: 0.8 },
  { radius: 100, color: '#a855f7', nodes: ['Episodic', 'Semantic', 'Entity', 'Working'], speed: -0.5 },
  { radius: 140, color: '#22c55e', nodes: ['WARDEN', 'VULCAN', 'MESHNET', 'NETWATCH', 'HYPERION'], speed: 0.35 },
  { radius: 180, color: '#f59e0b', nodes: ['SSH', 'API', 'DB', 'MCP', 'Flow'], speed: -0.25 },
  { radius: 220, color: '#06b6d4', nodes: ['AEE', 'AOCL', 'VOLT', 'WARD'], speed: 0.15 },
]
const CC_HEALTH = {}
CC_RINGS.forEach(ring => ring.nodes.forEach((name, i) => { CC_HEALTH[name] = { base: 0.6 + (i * 0.13) % 0.3, phase: i * 1.7 + (i * 0.7) % 2, freq: 0.06 + (i * 0.02) % 0.04 } }))
function ccHealth(name, f) { const h = CC_HEALTH[name]; return h ? h.base + Math.sin(f * h.freq + h.phase) * 0.2 : 0.7 }
export function CognitiveCore({ size = 480, showLabels = true }) {
  const f = useAnimFrame()
  const cx = size / 2, cy = size / 2
  const entranceProgress = lerp(f, 0, 30, 0, 1)
  const nucleusPulse = 1 + Math.sin(f * 0.1) * 0.08
  const nucleusRadius = 25 * nucleusPulse * entranceProgress
  return (
    <div style={{ width: size, height: size, position: 'relative', overflow: 'hidden' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', top: 0, left: 0 }}>
        {CC_RINGS.map((ring, ri) => {
          const ringEntrance = lerp(f, ri * 4, ri * 4 + 20, 0, 1)
          const r = ring.radius * ringEntrance
          return (
            <g key={`ring-${ri}`}>
              <circle cx={cx} cy={cy} r={r} fill="none" stroke={ring.color} strokeOpacity={0.12} strokeWidth={1} />
              {ring.nodes.map((name, ni) => {
                const angleOffset = f * ring.speed * (Math.PI / 180)
                const angle = ((2 * Math.PI) / ring.nodes.length) * ni + angleOffset
                const nx = cx + Math.cos(angle) * r
                const ny = cy + Math.sin(angle) * r
                const health = ccHealth(name, f)
                const nodeSize = 3 + health * 4
                const glowOp = 0.2 + health * 0.4
                const nodeEntrance = lerp(f, ri * 4 + 8, ri * 4 + 23, 0, 1)
                return (
                  <g key={`node-${ri}-${ni}`} opacity={nodeEntrance}>
                    <circle cx={nx} cy={ny} r={nodeSize + 4} fill={ring.color} fillOpacity={glowOp * 0.3} />
                    <circle cx={nx} cy={ny} r={nodeSize} fill={ring.color} fillOpacity={glowOp} stroke={ring.color} strokeOpacity={glowOp * 0.8} strokeWidth={1} />
                    {showLabels && <text x={nx} y={ny + nodeSize + 12} fill={ring.color} fillOpacity={0.7} fontSize={8} fontFamily="monospace" textAnchor="middle">{name}</text>}
                  </g>
                )
              })}
            </g>
          )
        })}
        {CC_RINGS[0].nodes.map((name, ni) => {
          const ringEntrance = lerp(f, 0, 20, 0, 1)
          const r = CC_RINGS[0].radius * ringEntrance
          const angleOffset = f * CC_RINGS[0].speed * (Math.PI / 180)
          const angle = ((2 * Math.PI) / CC_RINGS[0].nodes.length) * ni + angleOffset
          const nx = cx + Math.cos(angle) * r
          const ny = cy + Math.sin(angle) * r
          return <line key={`conn-${ni}`} x1={cx} y1={cy} x2={nx} y2={ny} stroke={CC_RINGS[0].color} strokeOpacity={0.1} strokeWidth={1} strokeDasharray="4 4" />
        })}
      </svg>
      <div style={{ position: 'absolute', left: cx - nucleusRadius * 2, top: cy - nucleusRadius * 2, width: nucleusRadius * 4, height: nucleusRadius * 4, borderRadius: '50%', background: `radial-gradient(circle, rgba(6,182,212,0.9) 0%, rgba(6,182,212,0.4) 40%, rgba(99,102,241,0.15) 70%, transparent 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <div style={{ width: nucleusRadius * 2, height: nucleusRadius * 2, borderRadius: '50%', background: 'radial-gradient(circle, rgba(6,182,212,0.95) 0%, rgba(6,182,212,0.6) 50%, transparent 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(6,182,212,0.3)' }}>
          {showLabels && <span style={{ color: 'rgba(255,255,255,0.95)', fontSize: 11, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 2 }}>QUOX</span>}
        </div>
      </div>
    </div>
  )
}

// ─── 27. IRIS APERTURE ─────────────────────────────────────────
function irisBlades(bladeCount, openAmount, size) {
  const blades = []
  const cx = size / 2, cy = size / 2, outerR = size * 0.48, innerR = outerR * (1 - openAmount * 0.85)
  for (let i = 0; i < bladeCount; i++) {
    const baseAngle = (2 * Math.PI * i) / bladeCount
    const nextAngle = (2 * Math.PI * (i + 1)) / bladeCount
    const sweep = (nextAngle - baseAngle) * 0.55
    const ox1 = cx + Math.cos(baseAngle - sweep * 0.1) * outerR
    const oy1 = cy + Math.sin(baseAngle - sweep * 0.1) * outerR
    const ox2 = cx + Math.cos(nextAngle + sweep * 0.1) * outerR
    const oy2 = cy + Math.sin(nextAngle + sweep * 0.1) * outerR
    const ix1 = cx + Math.cos(baseAngle + sweep * 0.3) * innerR
    const iy1 = cy + Math.sin(baseAngle + sweep * 0.3) * innerR
    const midAngle = (baseAngle + nextAngle) / 2
    const ix2 = cx + Math.cos(midAngle) * innerR
    const iy2 = cy + Math.sin(midAngle) * innerR
    blades.push(`M ${ox1} ${oy1} L ${ix1} ${iy1} L ${ix2} ${iy2} L ${ox2} ${oy2} Z`)
  }
  return blades
}
export function IrisAperture({ size = 300, bladeCount = 8, color = '#06b6d4' }) {
  const f = useAnimFrame()
  const open = lerp(f, 0, 30, 0, 1)
  const clampedOpen = Math.max(0, Math.min(1, open))
  const paths = irisBlades(bladeCount, clampedOpen, size)
  const cx = size / 2, cy = size / 2
  const apertureR = size * 0.48 * clampedOpen * 0.8
  return (
    <div style={{ width: size, height: size, position: 'relative', overflow: 'hidden' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', top: 0, left: 0 }}>
        <defs><linearGradient id="irisGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor={color} stopOpacity={0.35} /><stop offset="50%" stopColor={color} stopOpacity={0.18} /><stop offset="100%" stopColor={color} stopOpacity={0.08} /></linearGradient></defs>
        {paths.map((d, i) => {
          const bladeEntrance = lerp(f, i * 1, i * 1 + 10, 0, 1)
          return (
            <g key={i} opacity={bladeEntrance}>
              <path d={d} fill="url(#irisGrad)" stroke={color} strokeOpacity={0.4} strokeWidth={0.8} />
              <path d={d} fill="none" stroke={color} strokeOpacity={0.6} strokeWidth={0.5} strokeDasharray="3 6" />
            </g>
          )
        })}
        <circle cx={cx} cy={cy} r={size * 0.48} fill="none" stroke={color} strokeOpacity={0.25} strokeWidth={1.5} />
        {clampedOpen > 0.05 && <circle cx={cx} cy={cy} r={apertureR} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={1} />}
      </svg>
    </div>
  )
}

// ─── 28. ALERT WATERFALL ───────────────────────────────────────
const AW_SEV = { critical: '#ef4444', warning: '#f59e0b', info: '#38bdf8' }
const AW_ORDER = ['critical', 'warning', 'info']
const AW_ALERTS = [
  { id: 'ALT-001', severity: 'critical', source: 'Firewall', message: 'Brute-force SSH detected', startTime: 0, endTime: 45, status: 'resolved' },
  { id: 'ALT-002', severity: 'critical', source: 'WAF', message: 'SQL injection attempt', startTime: 20, endTime: 55, status: 'active' },
  { id: 'ALT-003', severity: 'warning', source: 'Auth', message: 'Failed login spike (12/min)', startTime: 10, endTime: 60, status: 'resolved' },
  { id: 'ALT-004', severity: 'warning', source: 'DNS', message: 'Unusual TXT query volume', startTime: 35, endTime: 80, status: 'resolved' },
  { id: 'ALT-005', severity: 'warning', source: 'TLS', message: 'Certificate expiry in 7d', startTime: 50, endTime: 120, status: 'active' },
  { id: 'ALT-006', severity: 'info', source: 'Agent', message: 'Agent heartbeat delayed 8s', startTime: 5, endTime: 25, status: 'resolved' },
  { id: 'ALT-007', severity: 'info', source: 'Backup', message: 'Snapshot completed', startTime: 30, endTime: 40, status: 'resolved' },
  { id: 'ALT-008', severity: 'info', source: 'Monitor', message: 'Latency spike > 200ms', startTime: 70, endTime: 120, status: 'active' },
]
export function AlertWaterfall({ alerts = AW_ALERTS, width = 650 }) {
  const f = useAnimFrame()
  const timeMin = Math.min(...alerts.map(a => a.startTime))
  const timeMax = Math.max(...alerts.map(a => a.endTime))
  const timeRange = timeMax - timeMin || 1
  const leftGutter = 130, rightPad = 30, barAreaW = width - leftGutter - rightPad
  const grouped = AW_ORDER.map(sev => ({ severity: sev, alerts: alerts.filter(a => a.severity === sev) })).filter(g => g.alerts.length > 0)
  const barH = 26, barGap = 5, groupGap = 14
  const tickCount = 5
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const t = timeMin + (timeRange * i) / tickCount
    return { label: `${Math.floor(t)}m`, x: leftGutter + (i / tickCount) * barAreaW }
  })
  return (
    <div style={{ width, padding: '16px 0', position: 'relative', fontFamily: F }}>
      <div style={{ position: 'relative', height: 20, marginBottom: 8 }}>
        {ticks.map((t, i) => <div key={i} style={{ position: 'absolute', left: t.x, top: 0, transform: 'translateX(-50%)', fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.6)' }}>{t.label}</div>)}
      </div>
      {grouped.map((group, gi) => {
        const color = AW_SEV[group.severity]
        return (
          <div key={group.severity} style={{ marginBottom: groupGap }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color, opacity: 0.7, paddingLeft: 12, marginBottom: 6, height: 22, display: 'flex', alignItems: 'center' }}>{group.severity}</div>
            {group.alerts.map((alert, ai) => {
              const globalIdx = gi * 3 + ai
              const slideIn = lerp(f, globalIdx * 2, globalIdx * 2 + 10, 0, 1)
              const barLeft = leftGutter + ((alert.startTime - timeMin) / timeRange) * barAreaW
              const barWidth = ((alert.endTime - alert.startTime) / timeRange) * barAreaW
              const shimmer = alert.status === 'active' ? 0.6 + 0.4 * Math.sin(f * 0.24 + globalIdx * 1.5) : 1
              return (
                <div key={alert.id} style={{ position: 'relative', height: barH, marginBottom: barGap, opacity: slideIn, transform: `translateX(${(1 - slideIn) * -30}px)` }}>
                  <div style={{ position: 'absolute', left: 12, top: 0, width: leftGutter - 20, height: barH, display: 'flex', alignItems: 'center', fontSize: 11, fontFamily: M, fontWeight: 600, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{alert.source}</div>
                  <div style={{ position: 'absolute', left: leftGutter, top: barH / 2, width: barAreaW, height: 1, background: 'rgba(255,255,255,0.04)' }} />
                  <div style={{ position: 'absolute', left: barLeft, top: 3, width: Math.max(barWidth * slideIn, 2), height: barH - 6, borderRadius: 4, background: `linear-gradient(90deg, ${color}30, ${color}60)`, borderLeft: `3px solid ${color}`, opacity: shimmer, display: 'flex', alignItems: 'center', paddingLeft: 8, overflow: 'hidden' }}>
                    <span style={{ fontSize: 9, fontFamily: F, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{alert.message}</span>
                  </div>
                  {alert.status === 'resolved' && slideIn > 0.8 && <div style={{ position: 'absolute', left: barLeft + barWidth * slideIn + 6, top: (barH - 16) / 2, width: 16, height: 16, borderRadius: '50%', background: 'rgba(34,197,94,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#22c55e', fontWeight: 700 }}>✓</div>}
                </div>
              )
            })}
          </div>
        )
      })}
      <div style={{ position: 'relative', height: 1, marginLeft: leftGutter, marginRight: rightPad, background: 'rgba(255,255,255,0.08)' }} />
    </div>
  )
}

// ─── 29. HOLO GRID ─────────────────────────────────────────────
export function HoloGrid({ cols = 20, rows = 14, color = '#38bdf8', perspective = 800, tiltX = 60, waveSpeed = 1, waveAmplitude = 12, opacity = 0.2 }) {
  const f = useAnimFrame()
  const cellW = 30, cellH = 30
  const gridW = cols * cellW, gridH = rows * cellH
  const t = f * 0.08 * waveSpeed
  const vertices = []
  for (let r = 0; r <= rows; r++) {
    const row = []
    for (let c = 0; c <= cols; c++) {
      const wave = Math.sin(c * 0.3 + t) * Math.cos(r * 0.25 + t * 0.7) * waveAmplitude + Math.sin((c + r) * 0.15 + t * 1.3) * waveAmplitude * 0.4
      row.push(wave)
    }
    vertices.push(row)
  }
  const fadeIn = lerp(f, 0, 20, 0, 1)
  const horizontalLines = []
  for (let r = 0; r <= rows; r++) {
    let d = ''
    for (let c = 0; c <= cols; c++) { d += (c === 0 ? 'M' : 'L') + ` ${c * cellW} ${r * cellH - vertices[r][c]}` }
    horizontalLines.push(d)
  }
  const verticalLines = []
  for (let c = 0; c <= cols; c++) {
    let d = ''
    for (let r = 0; r <= rows; r++) { d += (r === 0 ? 'M' : 'L') + ` ${c * cellW} ${r * cellH - vertices[r][c]}` }
    verticalLines.push(d)
  }
  const svgPad = waveAmplitude + 10
  const viewBox = `${-svgPad} ${-svgPad - waveAmplitude} ${gridW + svgPad * 2} ${gridH + svgPad * 2 + waveAmplitude}`
  return (
    <div style={{ width: '100%', height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', opacity: fadeIn }}>
      <div style={{ perspective, perspectiveOrigin: '50% 30%' }}>
        <div style={{ transform: `rotateX(${tiltX}deg)`, transformStyle: 'preserve-3d' }}>
          <svg viewBox={viewBox} style={{ width: gridW, height: gridH, overflow: 'visible' }}>
            {horizontalLines.map((d, i) => <path key={`h-${i}`} d={d} fill="none" stroke={color} strokeWidth={0.6} opacity={opacity} />)}
            {verticalLines.map((d, i) => <path key={`v-${i}`} d={d} fill="none" stroke={color} strokeWidth={0.6} opacity={opacity} />)}
          </svg>
        </div>
      </div>
    </div>
  )
}

// ─── 30. OBJECTIVE CHAIN TIMELINE ──────────────────────────────
const OCT_STATUS = { completed: '#10b981', running: '#3b82f6', pending: '#71717a', failed: '#ef4444' }
const OCT_CHAIN = [
  { id: 'obj-1', title: 'Security Audit', status: 'completed', taskCount: 6, completedCount: 6, isParent: true, depth: 0 },
  { id: 'obj-2', title: 'Port Scanning', status: 'running', taskCount: 4, completedCount: 2, isParent: false, depth: 1 },
  { id: 'obj-3', title: 'Certificate Check', status: 'running', taskCount: 3, completedCount: 1, isParent: false, depth: 1 },
  { id: 'obj-4', title: 'Firewall Rules', status: 'pending', taskCount: 5, completedCount: 0, isParent: false, depth: 1 },
]
const OCT_W = 280, OCT_NH = 56, OCT_CH = 20, OCT_IND = 20
export function ObjectiveChainTimeline({ chain = OCT_CHAIN }) {
  const f = useAnimFrame()
  const totalHeight = chain.length * OCT_NH + (chain.length - 1) * OCT_CH
  return (
    <div style={{ width: OCT_W, height: totalHeight, position: 'relative', fontFamily: F, overflow: 'hidden' }}>
      {chain.map((objective, i) => {
        const yOffset = i * (OCT_NH + OCT_CH)
        const indentX = 16 + objective.depth * OCT_IND
        const color = OCT_STATUS[objective.status] || '#71717a'
        const entrance = lerp(f, i * 3, i * 3 + 12, 0, 1)
        const translateY = (1 - entrance) * 12
        const pulseScale = objective.status === 'running' ? 1 + 0.3 * Math.sin(f * 0.3) : 1
        const pulseOpacity = objective.status === 'running' ? 0.6 + 0.4 * Math.sin(f * 0.3) : 1
        const isLast = i === chain.length - 1
        return (
          <div key={objective.id} style={{ opacity: entrance, transform: `translateY(${translateY}px)` }}>
            {i > 0 && <div style={{ position: 'absolute', left: indentX + 3, top: yOffset - OCT_CH, width: 2, height: OCT_CH, background: `linear-gradient(180deg, ${OCT_STATUS[chain[i - 1].status] || '#71717a'}44, ${color}44)` }} />}
            {!isLast && <div style={{ position: 'absolute', left: indentX + 3, top: yOffset + OCT_NH, width: 2, height: OCT_CH, background: `${color}33` }} />}
            <div style={{ position: 'absolute', left: 0, top: yOffset, width: OCT_W, height: OCT_NH, display: 'flex', alignItems: 'center', paddingLeft: indentX }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, transform: `scale(${pulseScale})`, opacity: pulseOpacity, boxShadow: objective.status === 'running' ? `0 0 8px ${color}88` : 'none' }} />
              {objective.status === 'running' && <div style={{ position: 'absolute', left: indentX - 4, top: OCT_NH / 2 - 12, width: 24, height: 24, borderRadius: '50%', background: `radial-gradient(circle, ${color}30 0%, transparent 70%)`, pointerEvents: 'none' }} />}
              <div style={{ marginLeft: 12, minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: objective.isParent ? 600 : 400, color: '#e5e7eb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: '16px' }}>{objective.title}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 2, fontFamily: M, fontVariantNumeric: 'tabular-nums' }}>{objective.completedCount}/{objective.taskCount} tasks</div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 1. WISDOM STORE (QuoxMind)
// ═══════════════════════════════════════════════════════════════
const WS_TYPES = {
  pattern: { color: '#a855f7', icon: '\u25C8' },
  correlation: { color: '#38bdf8', icon: '\u27C1' },
  failure: { color: '#ef4444', icon: '\u2715' },
  success: { color: '#30ff90', icon: '\u2713' },
}
const WS_DATA = [
  { title: 'SSH timeout on edge-03 during peak hours', detail: 'Retry with 30s delay resolves 94% of cases', type: 'pattern', confidence: 0.92, agent: 'WARDEN', applied: 47, lastUsed: '2h ago' },
  { title: 'WARDEN scan takes 3x longer when hyp-01 CPU > 80%', detail: 'Schedule scans during off-peak or throttle concurrency', type: 'correlation', confidence: 0.78, agent: 'HYPERION', applied: 12, lastUsed: '6h ago' },
  { title: 'docker compose build fails after Qdrant OOM', detail: 'Qdrant consumed 14GB \u2014 restart before rebuild', type: 'failure', confidence: 0.85, agent: 'VULCAN', applied: 3, lastUsed: '1d ago' },
  { title: 'Parallel agent deployment reduces fleet update time by 62%', detail: 'Batch size 4 optimal for current network topology', type: 'success', confidence: 0.96, agent: 'DAEDALUS', applied: 28, lastUsed: '4h ago' },
  { title: 'Memory service restart required after 72h continuous indexing', detail: 'SQLite WAL checkpoint stalls \u2014 scheduled restart prevents drift', type: 'pattern', confidence: 0.88, agent: 'CODEX', applied: 19, lastUsed: '12h ago' },
  { title: 'Certificate renewal fails silently on gw-01', detail: 'Bastion firewall blocks ACME challenge \u2014 port 80 must be open', type: 'failure', confidence: 0.91, agent: 'CIPHER', applied: 5, lastUsed: '3d ago' },
  { title: 'GPU utilisation drops 40% when vLLM batch size exceeds 8', detail: 'Optimal batch size is 6 for current A100 config', type: 'correlation', confidence: 0.73, agent: 'HYPERION', applied: 8, lastUsed: '1d ago' },
  { title: 'Workflow deployments succeed 99.2% when preceded by health check', detail: 'Pre-flight health check reduces rollback rate from 8% to 0.8%', type: 'success', confidence: 0.94, agent: 'VULCAN', applied: 156, lastUsed: '30m ago' },
]

export function WisdomStore() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1 }}>WISDOM STORE</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {Object.entries(WS_TYPES).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: v.color, fontSize: 11 }}>{v.icon}</span>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', textTransform: 'capitalize' }}>{k}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {WS_DATA.map((item, i) => {
          const t = WS_TYPES[item.type]
          const op = lerp(f, i * 2, i * 2 + 8, 0, 1)
          const confW = Math.round(item.confidence * 100)
          return (
            <div key={i} style={{ opacity: op, transform: `translateX(${lerp(f, i * 2, i * 2 + 6, -12, 0)}px)` }}>
              <GP style={{ padding: '10px 14px', borderTopColor: `${t.color}30` }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ fontSize: 16, color: t.color, lineHeight: 1, flexShrink: 0, marginTop: 2 }}>{t.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: F, fontSize: 12, color: '#fff', fontWeight: 600, marginBottom: 3 }}>{item.title}</div>
                    <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 6 }}>{item.detail}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Confidence</span>
                        <div style={{ width: 60, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                          <div style={{ width: `${confW}%`, height: '100%', borderRadius: 2, background: t.color, opacity: 0.8 }} />
                        </div>
                        <span style={{ fontFamily: M, fontSize: 9, color: t.color, fontWeight: 600 }}>{confW}%</span>
                      </div>
                      <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Agent: <span style={{ color: '#38bdf8' }}>{item.agent}</span></span>
                      <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Applied: <span style={{ color: '#fff' }}>{item.applied}x</span></span>
                      <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Last: {item.lastUsed}</span>
                    </div>
                  </div>
                </div>
              </GP>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 2. OBSERVER DASHBOARD (QuoxMind)
// ═══════════════════════════════════════════════════════════════
const OD_EVENTS = [
  { ts: '14:32:01', label: 'Task 3 started', color: '#38bdf8' },
  { ts: '14:32:04', label: 'WARDEN delegated', color: '#30ff90' },
  { ts: '14:32:12', label: 'SSH connected', color: '#06b6d4' },
  { ts: '14:32:18', label: 'Scan complete', color: '#30ff90' },
  { ts: '14:32:22', label: 'Wisdom applied #47', color: '#a855f7' },
  { ts: '14:32:30', label: 'Task 4 queued', color: '#f59e0b' },
  { ts: '14:32:35', label: 'VULCAN building', color: '#38bdf8' },
  { ts: '14:32:41', label: 'Health check pass', color: '#30ff90' },
]
const OD_AGENTS = [
  { name: 'WARDEN', task: 'Scanning edge-03 ports', progress: 72, color: '#ef4444' },
  { name: 'VULCAN', task: 'Building collector image', progress: 45, color: '#a855f7' },
  { name: 'HYPERION', task: 'Monitoring hyp-01 CPU spike', progress: 88, color: '#f59e0b' },
]

export function ObserverDashboard() {
  const f = useAnimFrame()
  const pulse = 0.6 + Math.sin(f * 0.1) * 0.4
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1 }}>OBSERVER DASHBOARD</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4, background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.25)' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#38bdf8', opacity: pulse, boxShadow: '0 0 8px rgba(56,189,248,0.5)' }} />
          <span style={{ fontFamily: M, fontSize: 9, color: '#38bdf8', fontWeight: 700, letterSpacing: 1 }}>OBSERVING</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {[
          { label: 'Active Objectives', value: '3', color: '#38bdf8' },
          { label: 'Tasks Running', value: '12', color: '#30ff90' },
          { label: 'Agents Busy', value: '5/16', color: '#a855f7' },
          { label: 'Wisdom Applied', value: '7', color: '#f59e0b' },
        ].map((m, i) => (
          <GP key={i} style={{ flex: 1, padding: '8px 10px', borderTopColor: `${m.color}25` }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5, marginBottom: 2 }}>{m.label}</div>
            <div style={{ fontFamily: M, fontSize: 20, fontWeight: 800, color: m.color }}>{m.value}</div>
          </GP>
        ))}
      </div>
      <GP style={{ padding: '10px 14px', marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginBottom: 8, letterSpacing: 0.5 }}>RECENT EVENTS</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, position: 'relative' }}>
          <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: 'rgba(255,255,255,0.06)' }} />
          {OD_EVENTS.map((ev, i) => {
            const op = lerp(f, i * 3, i * 3 + 6, 0, 1)
            return (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, opacity: op, position: 'relative', zIndex: 1 }}>
                <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.6)' }}>{ev.ts.split(':').slice(1).join(':')}</span>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: ev.color, opacity: 0.8, boxShadow: `0 0 6px ${ev.color}44` }} />
                <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.7)', textAlign: 'center', maxWidth: 60, lineHeight: 1.2 }}>{ev.label}</span>
              </div>
            )
          })}
        </div>
      </GP>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {OD_AGENTS.map((ag, i) => {
          const prog = lerp(f, 10 + i * 4, 30 + i * 4, 0, ag.progress)
          return (
            <GP key={i} style={{ padding: '8px 12px', borderTopColor: `${ag.color}25` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontFamily: M, fontSize: 11, color: ag.color, fontWeight: 700 }}>{ag.name}</span>
                <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{Math.round(prog)}%</span>
              </div>
              <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.8)', marginBottom: 5 }}>{ag.task}</div>
              <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${prog}%`, height: '100%', borderRadius: 2, background: ag.color, opacity: 0.7, transition: 'width 0.3s' }} />
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 3. POST-MORTEM VIEW (QuoxMind)
// ═══════════════════════════════════════════════════════════════
export function PostMortemView() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 15, 0, 1)
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>POST-MORTEM ANALYSIS</div>
      <GP style={{ padding: '12px 16px', marginBottom: 10, borderTopColor: 'rgba(249,115,22,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 2 }}>Deploy monitoring stack to edge-03</div>
            <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>obj-4b2e \u00B7 7 tasks \u00B7 3 agents</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: M, fontSize: 10, padding: '3px 10px', borderRadius: 4, background: 'rgba(249,115,22,0.15)', color: '#f59e0b', fontWeight: 700 }}>PARTIAL SUCCESS</span>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>4m 32s</span>
          </div>
        </div>
      </GP>
      <GP style={{ padding: '12px 16px', marginBottom: 10, borderTopColor: 'rgba(239,68,68,0.3)' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: '#ef4444', letterSpacing: 0.5, marginBottom: 6, fontWeight: 700 }}>ROOT CAUSE</div>
        <div style={{ fontFamily: F, fontSize: 12, color: '#fff', lineHeight: 1.5 }}>
          Task 3 failed: SSH connection refused on edge-03 (port 22 not responding). Host was mid-restart after kernel update. Dependent tasks 4-5 cascaded to skipped.
        </div>
      </GP>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <GP style={{ padding: '12px 14px', borderTopColor: 'rgba(48,255,144,0.3)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: '#30ff90', letterSpacing: 0.5, marginBottom: 8, fontWeight: 700 }}>WHAT WORKED</div>
          {['Pre-flight health checks identified 2 risks', 'WARDEN scan completed in 12s (under budget)', 'VOLT audit trail captured all 7 events'].map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 5, opacity: lerp(f, 8 + i * 3, 14 + i * 3, 0, 1) }}>
              <span style={{ color: '#30ff90', fontSize: 12, flexShrink: 0 }}>{'\u2713'}</span>
              <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.8)', lineHeight: 1.4 }}>{item}</span>
            </div>
          ))}
        </GP>
        <GP style={{ padding: '12px 14px', borderTopColor: 'rgba(239,68,68,0.3)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: '#ef4444', letterSpacing: 0.5, marginBottom: 8, fontWeight: 700 }}>WHAT FAILED</div>
          {['SSH connection to edge-03 refused \u2014 host mid-restart', 'No fallback path for dependent deploy tasks'].map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 5, opacity: lerp(f, 10 + i * 3, 16 + i * 3, 0, 1) }}>
              <span style={{ color: '#ef4444', fontSize: 12, flexShrink: 0 }}>{'\u2715'}</span>
              <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.8)', lineHeight: 1.4 }}>{item}</span>
            </div>
          ))}
        </GP>
      </div>
      <GP style={{ padding: '12px 14px', marginBottom: 10, borderTopColor: 'rgba(168,85,247,0.3)' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: '#a855f7', letterSpacing: 0.5, marginBottom: 8, fontWeight: 700 }}>LESSONS EXTRACTED</div>
        {[
          { lesson: 'Add SSH reachability pre-check before deploy tasks', confidence: 0.94 },
          { lesson: 'Implement retry-with-backoff for transient SSH failures', confidence: 0.89 },
        ].map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, opacity: lerp(f, 14 + i * 4, 22 + i * 4, 0, 1) }}>
            <span style={{ color: '#a855f7', fontSize: 14, flexShrink: 0 }}>{'\u25C8'}</span>
            <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.8)', flex: 1 }}>{item.lesson}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 40, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${item.confidence * 100}%`, height: '100%', borderRadius: 2, background: '#a855f7', opacity: 0.7 }} />
              </div>
              <span style={{ fontFamily: M, fontSize: 8, color: '#a855f7' }}>{Math.round(item.confidence * 100)}%</span>
            </div>
          </div>
        ))}
      </GP>
      <GP style={{ padding: '10px 14px', borderTopColor: 'rgba(56,189,248,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#38bdf8', fontSize: 14 }}>{'\u27D0'}</span>
          <div>
            <div style={{ fontFamily: M, fontSize: 9, color: '#38bdf8', letterSpacing: 0.5, marginBottom: 2, fontWeight: 700 }}>RECOMMENDATION</div>
            <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.8)' }}>Add health check before SSH tasks targeting edge-03. Similar objective succeeded 87% with this pattern.</div>
          </div>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 4. ADVISOR PANEL (QuoxMind)
// ═══════════════════════════════════════════════════════════════
export function AdvisorPanel() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const gaugeAngle = lerp(f, 5, 25, 0, 67 / 100 * 180)
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color: '#f59e0b', fontSize: 16 }}>{'\u26A0'}</span>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1 }}>PRE-FLIGHT ADVISORY</div>
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <GP style={{ width: 180, padding: '14px', display: 'flex', flexDirection: 'column', alignItems: 'center', borderTopColor: 'rgba(249,115,22,0.3)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginBottom: 8, letterSpacing: 0.5 }}>RISK SCORE</div>
          <svg viewBox="0 0 120 70" style={{ width: 140, height: 80 }}>
            <path d="M 10 65 A 50 50 0 0 1 110 65" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={6} strokeLinecap="round" />
            <path d="M 10 65 A 50 50 0 0 1 110 65" fill="none" stroke="url(#adv-grad)" strokeWidth={6} strokeLinecap="round" strokeDasharray={`${gaugeAngle / 180 * 157} 157`} />
            <defs><linearGradient id="adv-grad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#30ff90" /><stop offset="50%" stopColor="#f59e0b" /><stop offset="100%" stopColor="#ef4444" /></linearGradient></defs>
            <text x="60" y="55" textAnchor="middle" fill="#f59e0b" fontSize="22" fontWeight="800" fontFamily={M}>67</text>
            <text x="60" y="68" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="8" fontFamily={M}>MODERATE</text>
          </svg>
        </GP>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[
            { label: 'Resource Availability', status: 'pass', detail: 'All target hosts online, sufficient capacity', color: '#30ff90', icon: '\u2713' },
            { label: 'Agent Availability', status: 'pass', detail: '3 required agents idle and ready', color: '#30ff90', icon: '\u2713' },
            { label: 'Historical Risk', status: 'warn', detail: 'Similar objective failed 2/8 times on edge-03 \u2014 SSH timeouts during peak', color: '#f59e0b', icon: '\u26A0' },
            { label: 'Cost Estimate', status: 'info', detail: '$0.42 est. \u2014 1,200 tokens across 3 agents', color: '#38bdf8', icon: '\u25C7' },
          ].map((item, i) => (
            <GP key={i} style={{ padding: '8px 12px', borderTopColor: `${item.color}20`, opacity: lerp(f, 6 + i * 3, 14 + i * 3, 0, 1) }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: item.color, fontSize: 12, flexShrink: 0 }}>{item.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: M, fontSize: 10, color: '#fff', fontWeight: 600, marginBottom: 1 }}>{item.label}</div>
                  <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.3 }}>{item.detail}</div>
                </div>
                <span style={{ fontFamily: M, fontSize: 8, color: item.color, fontWeight: 700, textTransform: 'uppercase' }}>{item.status}</span>
              </div>
            </GP>
          ))}
        </div>
      </div>
      <GP style={{ padding: '10px 14px', borderTopColor: 'rgba(249,115,22,0.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#f59e0b', fontSize: 12 }}>{'\u27D0'}</span>
            <span style={{ fontFamily: F, fontSize: 12, color: '#fff', fontWeight: 600 }}>Proceed with caution</span>
            <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>\u2014 consider adding SSH pre-check</span>
          </div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Similar: <span style={{ color: '#30ff90' }}>75% success rate</span> (6/8 runs)</div>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 5. GUARDIAN ALERT (QuoxMind)
// ═══════════════════════════════════════════════════════════════
export function GuardianAlert() {
  const f = useAnimFrame()
  const pulse = 0.5 + Math.sin(f * 0.12) * 0.3
  const reveal = lerp(f, 0, 10, 0, 1)
  return (
    <div style={{ opacity: reveal }}>
      <GP style={{ padding: '14px 18px', marginBottom: 12, borderTopColor: 'rgba(239,68,68,0.5)', borderLeftColor: 'rgba(239,68,68,0.3)', boxShadow: `0 0 30px rgba(239,68,68,${pulse * 0.15}), 0 5px 19px rgba(0,0,0,0.35)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', opacity: pulse, boxShadow: '0 0 12px rgba(239,68,68,0.6)' }} />
          <span style={{ fontFamily: M, fontSize: 12, color: '#ef4444', fontWeight: 800, letterSpacing: 1.5 }}>GUARDIAN INTERVENTION</span>
          <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginLeft: 'auto' }}>14:35:22 UTC</span>
        </div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5, marginBottom: 4 }}>WHAT HAPPENED</div>
        <div style={{ fontFamily: F, fontSize: 13, color: '#fff', lineHeight: 1.5, marginBottom: 10 }}>
          Objective <span style={{ color: '#38bdf8', fontFamily: M }}>obj-7a3f</span> exceeded token budget by <span style={{ color: '#ef4444', fontWeight: 700 }}>340%</span>. Agent VULCAN entered recursive decomposition loop, consuming 14,200 tokens against a 3,200 token budget.
        </div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5, marginBottom: 4 }}>ACTION TAKEN</div>
        <div style={{ fontFamily: F, fontSize: 12, color: 'rgba(255,255,255,0.8)', marginBottom: 12 }}>
          Paused objective execution. Notified operator. Snapshot saved for review.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { label: '\u25B6 Resume', color: '#30ff90' },
            { label: '\u2715 Abort', color: '#ef4444' },
            { label: '\u25C7 Adjust Budget', color: '#38bdf8' },
          ].map((btn, i) => (
            <GP key={i} style={{ padding: '6px 14px', cursor: 'pointer', borderTopColor: `${btn.color}30` }}>
              <span style={{ fontFamily: M, fontSize: 10, color: btn.color, fontWeight: 700 }}>{btn.label}</span>
            </GP>
          ))}
        </div>
      </GP>
      <GP style={{ padding: '12px 14px', borderTopColor: 'rgba(6,182,212,0.3)' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: '#06b6d4', letterSpacing: 0.5, marginBottom: 8, fontWeight: 700 }}>VOLT EVIDENCE TRAIL</div>
        {[
          { hash: 'f91a3c', ts: '14:33:01', event: 'Token budget threshold reached (80%)', color: '#f59e0b' },
          { hash: 'a82d1e', ts: '14:34:15', event: 'Budget exceeded 200% \u2014 warning issued to agent', color: '#ef4444' },
          { hash: 'c73b4f', ts: '14:35:22', event: 'Guardian paused execution at 340% overspend', color: '#ef4444' },
        ].map((entry, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: i < 2 ? '1px solid rgba(255,255,255,0.04)' : 'none', opacity: lerp(f, 8 + i * 4, 16 + i * 4, 0, 1) }}>
            <span style={{ fontFamily: M, fontSize: 9, color: '#06b6d4', fontWeight: 600 }}>{entry.hash}...</span>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{entry.ts}</span>
            <span style={{ fontFamily: F, fontSize: 11, color: entry.color, flex: 1 }}>{entry.event}</span>
          </div>
        ))}
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 6. CONTENT PIPELINE (ContentOps)
// ═══════════════════════════════════════════════════════════════
const CP_STAGES = [
  { name: 'Brief', status: 'complete', agent: null, color: '#30ff90' },
  { name: 'Draft', status: 'complete', agent: 'HERALD', color: '#30ff90' },
  { name: 'Review', status: 'active', agent: 'CODEX', color: '#38bdf8' },
  { name: 'Publish', status: 'pending', agent: null, color: 'rgba(255,255,255,0.3)' },
  { name: 'Distribute', status: 'pending', agent: 'HERALD', color: 'rgba(255,255,255,0.3)' },
]

export function ContentPipeline() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const activePulse = 0.6 + Math.sin(f * 0.1) * 0.4
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>CONTENT PIPELINE</div>
      <GP style={{ padding: '12px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Q2 Product Update Blog Post</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {['Blog', 'Social', 'Video Script'].map((t, i) => (
              <span key={i} style={{ fontFamily: M, fontSize: 8, padding: '2px 6px', borderRadius: 3, background: ['rgba(56,189,248,0.12)', 'rgba(168,85,247,0.12)', 'rgba(249,115,22,0.12)'][i], color: ['#38bdf8', '#a855f7', '#f59e0b'][i], fontWeight: 600 }}>{t}</span>
            ))}
          </div>
        </div>
      </GP>
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 12 }}>
        {CP_STAGES.map((stage, i) => {
          const isActive = stage.status === 'active'
          const isComplete = stage.status === 'complete'
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
              <GP style={{
                flex: 1, padding: '12px 14px', textAlign: 'center',
                borderTopColor: isActive ? 'rgba(56,189,248,0.4)' : isComplete ? 'rgba(48,255,144,0.3)' : 'rgba(255,255,255,0.05)',
                boxShadow: isActive ? `0 0 20px rgba(56,189,248,${activePulse * 0.12})` : undefined,
              }}>
                <div style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: isActive ? '#38bdf8' : isComplete ? '#30ff90' : 'rgba(255,255,255,0.4)', marginBottom: 3 }}>{stage.name}</div>
                <div style={{ fontFamily: M, fontSize: 8, color: isActive ? '#38bdf8' : isComplete ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)', textTransform: 'uppercase' }}>
                  {isComplete ? '\u2713 Done' : isActive ? '\u25CF Active' : '\u25CB Pending'}
                </div>
                {stage.agent && <div style={{ fontFamily: M, fontSize: 8, color: isActive ? '#38bdf8' : isComplete ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)', marginTop: 3 }}>{stage.agent}</div>}
              </GP>
              {i < CP_STAGES.length - 1 && (
                <div style={{ width: 20, height: 2, background: isComplete ? '#30ff9040' : 'rgba(255,255,255,0.06)', flexShrink: 0 }} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 7. MEDIA GRID (ContentOps)
// ═══════════════════════════════════════════════════════════════
const MG_ITEMS = [
  { title: 'Product Demo Video', type: 'video', icon: '\u25B6', gradient: 'linear-gradient(135deg,#6366f1,#a855f7)', status: 'Published', agent: 'HERALD', color: '#30ff90' },
  { title: 'Podcast Ep.12', type: 'audio', icon: '\u266A', gradient: 'linear-gradient(135deg,#ec4899,#f59e0b)', status: 'In Review', agent: 'CODEX', color: '#38bdf8' },
  { title: 'LinkedIn Post', type: 'text', icon: '\u2261', gradient: 'linear-gradient(135deg,#0077b5,#00a0dc)', status: 'Draft', agent: 'HERALD', color: '#f59e0b' },
  { title: 'Blog Hero Image', type: 'image', icon: '\u25FB', gradient: 'linear-gradient(135deg,#10b981,#30ff90)', status: 'Published', agent: 'HERALD', color: '#30ff90' },
  { title: 'Release Notes v2.4', type: 'text', icon: '\u2261', gradient: 'linear-gradient(135deg,#38bdf8,#06b6d4)', status: 'Published', agent: 'CODEX', color: '#30ff90' },
  { title: 'Twitter Thread', type: 'text', icon: '\u2261', gradient: 'linear-gradient(135deg,#a855f7,#ec4899)', status: 'Scheduled', agent: 'HERALD', color: '#a855f7' },
]

export function MediaGrid() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>MEDIA ASSETS</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {MG_ITEMS.map((item, i) => {
          const op = lerp(f, i * 2, i * 2 + 8, 0, 1)
          return (
            <GP key={i} style={{ padding: 0, overflow: 'hidden', opacity: op, transform: `scale(${lerp(f, i * 2, i * 2 + 6, 0.95, 1)})` }}>
              <div style={{ height: 80, background: item.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                <span style={{ fontSize: 28, color: 'rgba(255,255,255,0.4)' }}>{item.icon}</span>
                <span style={{ position: 'absolute', top: 6, right: 6, fontFamily: M, fontSize: 8, padding: '2px 6px', borderRadius: 3, background: 'rgba(0,0,0,0.5)', color: '#fff', textTransform: 'uppercase' }}>{item.type}</span>
              </div>
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 4 }}>{item.title}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: M, fontSize: 8, padding: '2px 6px', borderRadius: 3, background: `${item.color}15`, color: item.color, fontWeight: 600 }}>{item.status}</span>
                  <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>{item.agent}</span>
                </div>
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 8. CLUSTER TOPOLOGY (Qluster)
// ═══════════════════════════════════════════════════════════════
const CT_NODES = [
  { name: 'london-01', agents: 12, lastSync: '2s ago', status: 'synced', x: 50, y: 15 },
  { name: 'frankfurt-02', agents: 14, lastSync: '1s ago', status: 'synced', x: 85, y: 50 },
  { name: 'singapore-03', agents: 10, lastSync: '4s ago', status: 'syncing', x: 50, y: 85 },
  { name: 'us-east-04', agents: 11, lastSync: '1s ago', status: 'synced', x: 15, y: 50 },
]

export function ClusterTopology() {
  const f = useAnimFrame()
  const pulse = 0.5 + Math.sin(f * 0.08) * 0.3
  const reveal = lerp(f, 0, 15, 0, 1)
  const w = 500, h = 320
  const cx = w / 2, cy = h / 2
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>QLUSTER TOPOLOGY</div>
      <div style={{ position: 'relative', width: w, height: h }}>
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }}>
          {CT_NODES.map((node, i) => {
            const nx = (node.x / 100) * w, ny = (node.y / 100) * h
            const isSynced = node.status === 'synced'
            return (
              <line key={i} x1={cx} y1={cy} x2={nx} y2={ny}
                stroke={isSynced ? 'rgba(48,255,144,0.3)' : 'rgba(249,115,22,0.3)'}
                strokeWidth={1.5}
                strokeDasharray={isSynced ? 'none' : '6 4'}
                opacity={0.7}
              />
            )
          })}
          <circle cx={cx} cy={cy} r={30} fill="rgba(56,189,248,0.05)" stroke="rgba(56,189,248,0.3)" strokeWidth={1} />
          <circle cx={cx} cy={cy} r={20} fill="rgba(56,189,248,0.08)" opacity={pulse} />
          <circle cx={cx} cy={cy} r={6} fill="#38bdf8" opacity={0.8} />
        </svg>
        <div style={{ position: 'absolute', left: cx, top: cy + 36, transform: 'translateX(-50%)', textAlign: 'center' }}>
          <div style={{ fontFamily: M, fontSize: 10, color: '#38bdf8', fontWeight: 700 }}>CaptainCluster</div>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>Orchestrator</div>
        </div>
        {CT_NODES.map((node, i) => {
          const nx = (node.x / 100) * w, ny = (node.y / 100) * h
          const isSynced = node.status === 'synced'
          return (
            <div key={i} style={{ position: 'absolute', left: nx, top: ny, transform: 'translate(-50%, -50%)', opacity: lerp(f, 3 + i * 3, 10 + i * 3, 0, 1) }}>
              <GP style={{ padding: '8px 12px', borderTopColor: isSynced ? 'rgba(48,255,144,0.3)' : 'rgba(249,115,22,0.3)', minWidth: 110 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: isSynced ? '#30ff90' : '#f59e0b', opacity: 0.8 }} />
                  <span style={{ fontFamily: M, fontSize: 10, color: '#fff', fontWeight: 700 }}>{node.name}</span>
                </div>
                <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>{node.agents} agents \u00B7 {node.lastSync}</div>
              </GP>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 8 }}>
        {[
          { label: 'Nodes', value: '4', color: '#38bdf8' },
          { label: 'Total Agents', value: '47', color: '#a855f7' },
          { label: 'Avg Latency', value: '12ms', color: '#30ff90' },
        ].map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontFamily: M, fontSize: 14, fontWeight: 800, color: s.color }}>{s.value}</span>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 9. AUDIT LAKE (Qluster)
// ═══════════════════════════════════════════════════════════════
const AL_NODES = [
  { name: 'london-01', aee: 42100, volt: 31200, ward: 8400 },
  { name: 'frankfurt-02', aee: 38700, volt: 28900, ward: 7100 },
  { name: 'singapore-03', aee: 19200, volt: 14800, ward: 3600 },
  { name: 'us-east-04', aee: 35400, volt: 26100, ward: 6800 },
]
const AL_TYPES = { aee: { color: '#38bdf8', label: 'AEE' }, volt: { color: '#30ff90', label: 'VOLT' }, ward: { color: '#a855f7', label: 'WARD' } }

export function AuditLake() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const maxTotal = Math.max(...AL_NODES.map(n => n.aee + n.volt + n.ward))
  const total = AL_NODES.reduce((s, n) => s + n.aee + n.volt + n.ward, 0)
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1 }}>AUDIT LAKE</div>
        <div style={{ display: 'flex', gap: 10 }}>
          {Object.entries(AL_TYPES).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 8, height: 4, borderRadius: 1, background: v.color, opacity: 0.8 }} />
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{v.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {AL_NODES.map((node, i) => {
          const nodeTotal = node.aee + node.volt + node.ward
          const barScale = lerp(f, 5 + i * 3, 20 + i * 3, 0, 1)
          return (
            <GP key={i} style={{ padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontFamily: M, fontSize: 11, color: '#fff', fontWeight: 600 }}>{node.name}</span>
                <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{nodeTotal.toLocaleString()} events</span>
              </div>
              <div style={{ height: 14, borderRadius: 4, background: 'rgba(255,255,255,0.04)', overflow: 'hidden', display: 'flex' }}>
                {['aee', 'volt', 'ward'].map((type) => {
                  const pct = (node[type] / maxTotal) * 100 * barScale
                  return <div key={type} style={{ width: `${pct}%`, height: '100%', background: AL_TYPES[type].color, opacity: 0.7 }} />
                })}
              </div>
            </GP>
          )
        })}
      </div>
      <div style={{ textAlign: 'center', marginTop: 10 }}>
        <span style={{ fontFamily: M, fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>Total: </span>
        <span style={{ fontFamily: M, fontSize: 14, fontWeight: 800, color: '#38bdf8' }}>{total.toLocaleString()}</span>
        <span style={{ fontFamily: M, fontSize: 11, color: 'rgba(255,255,255,0.7)' }}> events across 4 nodes (last 24h)</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 10. MARKETING TEAM DASHBOARD
// ═══════════════════════════════════════════════════════════════
const MT_AGENTS = [
  { name: 'RANKR', role: 'SEO Intelligence', color: '#30ff90', task: 'Tracking 47 competitor keywords', metric: 'Rank #3 avg', status: 'active' },
  { name: 'ADWATCH', role: 'Ad Monitoring', color: '#f59e0b', task: 'Monitoring Google Ads spend', metric: 'ROAS 4.2x', status: 'active' },
  { name: 'LLMVIS', role: 'Citation Tracking', color: '#a855f7', task: 'Scanning Claude, GPT citations', metric: '89 mentions', status: 'idle' },
  { name: 'MARKET', role: 'Strategy Lead', color: '#06b6d4', task: 'Generating Q2 report', metric: '14 reports', status: 'active' },
]

export function MarketingTeamDashboard() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1 }}>MARKETING INTELLIGENCE TEAM</div>
        <GP style={{ padding: '4px 10px', borderTopColor: 'rgba(48,255,144,0.3)' }}>
          <span style={{ fontFamily: M, fontSize: 10, color: '#30ff90', fontWeight: 700 }}>$99/mo</span>
          <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', marginLeft: 4 }}>(save $49)</span>
        </GP>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
        {MT_AGENTS.map((ag, i) => {
          const agPulse = ag.status === 'active' ? 0.6 + Math.sin(f * 0.1 + i) * 0.4 : 0.4
          return (
            <GP key={i} style={{ padding: '12px', borderTopColor: `${ag.color}30`, opacity: lerp(f, 3 + i * 2, 10 + i * 2, 0, 1) }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: ag.color, opacity: agPulse, boxShadow: `0 0 6px ${ag.color}44` }} />
                <span style={{ fontFamily: M, fontSize: 12, color: ag.color, fontWeight: 800 }}>{ag.name}</span>
              </div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>{ag.role}</div>
              <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.8)', marginBottom: 6, lineHeight: 1.3 }}>{ag.task}</div>
              <div style={{ fontFamily: M, fontSize: 10, color: '#fff', fontWeight: 600 }}>{ag.metric}</div>
            </GP>
          )
        })}
      </div>
      <GP style={{ padding: '10px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-around' }}>
          {[
            { label: 'Keywords Tracked', value: '1,247', color: '#30ff90' },
            { label: 'Ad Spend Monitored', value: '$12.4K', color: '#f59e0b' },
            { label: 'Citations Found', value: '89', color: '#a855f7' },
            { label: 'Reports Generated', value: '14', color: '#06b6d4' },
          ].map((m, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: m.color }}>{m.value}</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.3 }}>{m.label}</div>
            </div>
          ))}
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 11. ASYNC AGENT CARD
// ═══════════════════════════════════════════════════════════════
export function AsyncAgentCard() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 10, 0, 1)
  const progress = lerp(f, 5, 60, 0, 73)
  const spin = f * 6
  const tokenUsed = Math.round(lerp(f, 5, 60, 0, 2847))
  return (
    <div style={{ opacity: reveal, maxWidth: 420 }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>ASYNC EXECUTION</div>
      <GP style={{ padding: '16px', borderTopColor: 'rgba(239,68,68,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 14, color: '#ef4444', fontWeight: 800, marginBottom: 2 }}>WARDEN</div>
            <div style={{ fontFamily: F, fontSize: 12, color: '#fff', fontWeight: 600 }}>Full infrastructure security audit</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width={14} height={14} viewBox="0 0 14 14" style={{ transform: `rotate(${spin}deg)` }}>
              <circle cx={7} cy={7} r={5} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={2} />
              <path d="M 7 2 A 5 5 0 0 1 12 7" fill="none" stroke="#38bdf8" strokeWidth={2} strokeLinecap="round" />
            </svg>
            <span style={{ fontFamily: M, fontSize: 9, color: '#38bdf8', fontWeight: 600 }}>Running in background</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5 }}>STARTED</div>
            <div style={{ fontFamily: M, fontSize: 11, color: '#fff' }}>14:28:01 UTC</div>
          </div>
          <div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5 }}>EST. COMPLETION</div>
            <div style={{ fontFamily: M, fontSize: 11, color: '#fff' }}>14:35:00 UTC</div>
          </div>
          <div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5 }}>ELAPSED</div>
            <div style={{ fontFamily: M, fontSize: 11, color: '#fff' }}>{Math.floor(progress / 10)}m {Math.round(progress % 10 * 6)}s</div>
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Progress</span>
            <span style={{ fontFamily: M, fontSize: 9, color: '#38bdf8', fontWeight: 700 }}>{Math.round(progress)}%</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', borderRadius: 3, background: 'linear-gradient(90deg, #38bdf8, #a855f7)', transition: 'width 0.5s' }} />
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Token Usage</span>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{tokenUsed.toLocaleString()} / 4,000</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ width: `${(tokenUsed / 4000) * 100}%`, height: '100%', borderRadius: 2, background: tokenUsed > 3200 ? '#f59e0b' : '#30ff90', opacity: 0.7 }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { label: '\u25CE View Logs', color: '#38bdf8' },
            { label: '\u23F8 Pause', color: '#f59e0b' },
            { label: '\u2715 Cancel', color: '#ef4444' },
          ].map((btn, i) => (
            <GP key={i} style={{ padding: '5px 12px', cursor: 'pointer', borderTopColor: `${btn.color}25` }}>
              <span style={{ fontFamily: M, fontSize: 9, color: btn.color, fontWeight: 700 }}>{btn.label}</span>
            </GP>
          ))}
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROADMAP: 12. FEDERATED WISDOM PANEL
// ═══════════════════════════════════════════════════════════════
const FW_ROOMS = [
  { name: 'quox-ops-wisdom', lessons: 847, members: 234, lastActivity: '2m ago', subscribed: true },
  { name: 'security-patterns', lessons: 312, members: 89, lastActivity: '15m ago', subscribed: true },
  { name: 'deployment-playbooks', lessons: 156, members: 67, lastActivity: '1h ago', subscribed: false },
]

export function FederatedWisdomPanel() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontFamily: M, fontSize: 14, color: '#a855f7' }}>[m]</span>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1 }}>FEDERATED WISDOM NETWORK</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {FW_ROOMS.map((room, i) => (
          <GP key={i} style={{ padding: '12px 14px', borderTopColor: room.subscribed ? 'rgba(168,85,247,0.3)' : 'rgba(255,255,255,0.05)', opacity: lerp(f, 4 + i * 3, 12 + i * 3, 0, 1) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontFamily: M, fontSize: 12, color: '#fff', fontWeight: 700, marginBottom: 3 }}>#{room.name}</div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{room.members} members</span>
                  <span style={{ fontFamily: M, fontSize: 9, color: '#a855f7' }}>{room.lessons} lessons</span>
                  <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Active {room.lastActivity}</span>
                </div>
              </div>
              <GP style={{ padding: '4px 10px', cursor: 'pointer', borderTopColor: room.subscribed ? 'rgba(48,255,144,0.3)' : 'rgba(255,255,255,0.1)' }}>
                <span style={{ fontFamily: M, fontSize: 9, color: room.subscribed ? '#30ff90' : 'rgba(255,255,255,0.6)', fontWeight: 600 }}>
                  {room.subscribed ? '\u2713 Subscribed' : 'Subscribe'}
                </span>
              </GP>
            </div>
          </GP>
        ))}
      </div>
      <GP style={{ padding: '10px 14px', borderTopColor: 'rgba(56,189,248,0.25)' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5, marginBottom: 4 }}>YOUR CONTRIBUTIONS</div>
        <div style={{ fontFamily: F, fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
          <span style={{ color: '#38bdf8', fontWeight: 700 }}>23</span> lessons shared \u00B7 <span style={{ color: '#a855f7', fontWeight: 700 }}>156</span> applied from community
        </div>
      </GP>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10 }}>
        <span style={{ color: '#30ff90', fontSize: 10 }}>{'\u2713'}</span>
        <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>All wisdom VOLT-verified</span>
      </div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// COMPLIANCE DASHBOARD — EU AI Act, SOC2, HIPAA, GDPR, ISO 27001
// ═══════════════════════════════════════════════════════════════
export function ComplianceDashboard() {
  const f = useAnimFrame()
  const frameworks = [
    { name: 'EU AI Act', coverage: 94, status: 'Compliant', lastAudit: '2026-03-10', color: '#30ff90' },
    { name: 'SOC 2', coverage: 87, status: 'Partial', lastAudit: '2026-02-28', color: '#f59e0b' },
    { name: 'HIPAA', coverage: 72, status: 'Partial', lastAudit: '2026-01-15', color: '#f59e0b' },
    { name: 'GDPR', coverage: 96, status: 'Compliant', lastAudit: '2026-03-18', color: '#30ff90' },
    { name: 'ISO 27001', coverage: 61, status: 'Gap', lastAudit: '2025-12-20', color: '#ef4444' },
  ]
  const getColor = (pct) => pct > 90 ? '#30ff90' : pct >= 60 ? '#f59e0b' : '#ef4444'
  const ringSize = 64
  const ringStroke = 5
  const ringR = (ringSize - ringStroke) / 2
  const ringCirc = 2 * Math.PI * ringR

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>COMPLIANCE DASHBOARD</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {frameworks.map((fw, i) => {
          const c = getColor(fw.coverage)
          const animPct = Math.min(fw.coverage, lerp(f, i * 4, i * 4 + 20, 0, fw.coverage))
          const dash = (animPct / 100) * ringCirc
          return (
            <GP key={i} style={{ flex: '1 1 140px', minWidth: 130, padding: 14, borderTopColor: `${c}30` }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
                <svg width={ringSize} height={ringSize}>
                  <circle cx={ringSize/2} cy={ringSize/2} r={ringR} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={ringStroke} />
                  <circle cx={ringSize/2} cy={ringSize/2} r={ringR} fill="none" stroke={c} strokeWidth={ringStroke}
                    strokeDasharray={`${dash} ${ringCirc - dash}`}
                    strokeDashoffset={ringCirc * 0.25} strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.3s' }} />
                  <text x={ringSize/2} y={ringSize/2 + 4} textAnchor="middle" fill="#fff" fontSize={14} fontFamily={M} fontWeight={700}>{Math.round(animPct)}%</text>
                </svg>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{fw.name}</div>
                <div style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 9, fontFamily: M, fontWeight: 600, color: c, background: `${c}15` }}>{fw.status}</div>
                <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>Audit: {fw.lastAudit}</div>
              </div>
            </GP>
          )
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
        <span>Next audit due: <span style={{ color: '#f59e0b', fontWeight: 600 }}>2026-04-15</span></span>
        <span>Evidence items: <span style={{ color: '#38bdf8', fontWeight: 600 }}>1,247</span></span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// CERTIFICATION PANEL — VOLT Certification tiers
// ═══════════════════════════════════════════════════════════════
export function CertificationPanel() {
  const f = useAnimFrame()
  const tiers = [
    { name: 'Bronze', icon: '\u25CB', color: '#cd7f32', type: 'Basic, Auto', reqs: ['Agent registration', 'Basic logging', 'Health endpoint'], met: [true, true, true] },
    { name: 'Silver', icon: '\u25CE', color: '#c0c0c0', type: 'Verified, Auto', reqs: ['VOLT evidence capture', 'AEE envelope compliance', 'Error rate < 5%'], met: [true, true, true] },
    { name: 'Gold', icon: '\u2605', color: '#ffd700', type: 'Timestamped+Signed, Auto', reqs: ['Cryptographic signing', 'WARD receipts', 'Tamper-evident chain'], met: [true, true, false] },
    { name: 'Platinum', icon: '\u2666', color: '#e5e4e2', type: 'Enterprise, Managed', reqs: ['External audit passed', 'SOC 2 attestation', '99.99% uptime SLA'], met: [false, false, false] },
  ]
  const currentTier = 2 // Gold

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>VOLT CERTIFICATION TIERS</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        {tiers.map((tier, i) => {
          const isCurrent = i === currentTier
          const op = lerp(f, i * 5, i * 5 + 12, 0, 1)
          return (
            <div key={i} style={{ position: 'relative', flex: 1, opacity: op }}>
              {i > 0 && <div style={{ position: 'absolute', left: -6, top: '50%', width: 12, height: 2, background: `rgba(255,255,255,0.1)`, zIndex: 2 }} />}
              <GP style={{ padding: 14, height: '100%', borderTopColor: isCurrent ? `${tier.color}50` : 'rgba(255,255,255,0.06)', ...(isCurrent ? { boxShadow: `0 0 20px ${tier.color}20, 0 5px 19px rgba(0,0,0,0.35), inset 0 1px 2px rgba(255,255,255,0.08)` } : {}) }}>
                <div style={{ textAlign: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 24, color: tier.color, opacity: isCurrent ? 1 : 0.5, textShadow: isCurrent ? `0 0 12px ${tier.color}60` : 'none' }}>{tier.icon}</div>
                  <div style={{ fontFamily: M, fontSize: 13, fontWeight: 700, color: tier.color, marginTop: 4 }}>{tier.name}</div>
                  <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>{tier.type}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {tier.reqs.map((req, j) => (
                    <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, fontFamily: M }}>
                      <span style={{ color: tier.met[j] ? '#30ff90' : 'rgba(255,255,255,0.3)', fontSize: 11 }}>{tier.met[j] ? '\u2713' : '\u25CB'}</span>
                      <span style={{ color: tier.met[j] ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)' }}>{req}</span>
                    </div>
                  ))}
                </div>
              </GP>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#ffd700', fontFamily: M }}>Your certification: Gold</span>
        <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(255,215,0,0.1)', border: '1px solid rgba(255,215,0,0.2)', fontSize: 9, fontFamily: M, color: '#ffd700', fontWeight: 600 }}>VOLT VERIFIED</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// REPLAY BROWSER — Deterministic replay UI
// ═══════════════════════════════════════════════════════════════
export function ReplayBrowser() {
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(42)
  const [whatIf, setWhatIf] = useState(false)
  const f = useAnimFrame()

  useEffect(() => {
    if (playing) {
      const id = setInterval(() => setProgress(p => p >= 100 ? (setPlaying(false), 100) : p + 1), 120)
      return () => clearInterval(id)
    }
  }, [playing])

  const states = [
    { label: 'Agent State', value: 'VULCAN: executing deploy task #4891', color: '#a855f7' },
    { label: 'Tool Responses', value: 'ssh.exec → edge-01: exit 0 (1.2s)', color: '#38bdf8' },
    { label: 'Memory Snapshot', value: 'WSM: 3 entities, 1 open loop, focus: deploy', color: '#06b6d4' },
  ]

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>DETERMINISTIC REPLAY</div>
      <GP style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: '#fff' }}>Deploy v2.4.0</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Mar 23, 14:30 — 42 steps — 2m 18s</div>
          </div>
          <div style={{ padding: '3px 10px', borderRadius: 4, background: 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.2)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#30ff90' }}>
            VERIFIED — hash matches VOLT record
          </div>
        </div>
        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div onClick={() => setPlaying(!playing)} style={{ width: 28, height: 28, borderRadius: 6, background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#38bdf8', fontSize: 12 }}>
            {playing ? '\u23F8' : '\u25B6'}
          </div>
          <div onClick={() => { setPlaying(false); setProgress(p => Math.min(100, p + 1)) }} style={{ width: 28, height: 28, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontFamily: M }}>
            +1
          </div>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', cursor: 'pointer', position: 'relative' }} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setProgress(Math.round((e.clientX - r.left) / r.width * 100)) }}>
            <div style={{ width: `${progress}%`, height: '100%', borderRadius: 3, background: 'linear-gradient(90deg, #38bdf8, #a855f7)', transition: 'width 0.1s' }} />
            <div style={{ position: 'absolute', left: `${progress}%`, top: -3, width: 12, height: 12, borderRadius: '50%', background: '#38bdf8', transform: 'translateX(-50%)', boxShadow: '0 0 8px rgba(56,189,248,0.4)' }} />
          </div>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', minWidth: 36, textAlign: 'right' }}>{progress}%</span>
        </div>
      </GP>
      {/* Frozen state */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {states.map((s, i) => (
          <GP key={i} style={{ padding: '10px 14px', borderTopColor: `${s.color}30` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: M, fontSize: 9, color: s.color, fontWeight: 600 }}>{s.label}</span>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.8)' }}>{s.value}</span>
            </div>
          </GP>
        ))}
      </div>
      {/* What-if */}
      <GP style={{ padding: '10px 14px', marginTop: 10, borderTopColor: whatIf ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: '#f59e0b' }}>What-if: </span>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.8)' }}>What if WARDEN was unavailable?</span>
          </div>
          <div onClick={() => setWhatIf(!whatIf)} style={{ width: 36, height: 18, borderRadius: 9, background: whatIf ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.08)', cursor: 'pointer', position: 'relative', transition: 'background 0.2s' }}>
            <div style={{ position: 'absolute', top: 2, left: whatIf ? 20 : 2, width: 14, height: 14, borderRadius: '50%', background: whatIf ? '#f59e0b' : 'rgba(255,255,255,0.4)', transition: 'left 0.2s' }} />
          </div>
        </div>
        {whatIf && <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 6 }}>
          Counterfactual: Deploy proceeds without security scan. Risk score: <span style={{ color: '#ef4444', fontWeight: 700 }}>HIGH</span>. Estimated vulnerability window: 4m 12s.
        </div>}
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// MATRIX ROOM VIEW — Matrix federation preview
// ═══════════════════════════════════════════════════════════════
export function MatrixRoomView() {
  const f = useAnimFrame()
  const messages = [
    { sender: 'adam', avatar: 'A', type: 'human', text: 'Deploy v2.4 to production when ready.', ts: '14:28' },
    { sender: 'VULCAN', avatar: 'F', type: 'agent', protocol: 'AEE', text: 'Acknowledged. Initiating deploy workflow. Requesting WARDEN pre-flight scan.', ts: '14:28' },
    { sender: 'WARDEN', avatar: 'S', type: 'agent', protocol: 'VOLT', text: 'Pre-flight security scan complete. 0 vulnerabilities. VOLT evidence #4890 recorded.', ts: '14:29' },
    { sender: 'VULCAN', avatar: 'F', type: 'agent', protocol: 'AEE', text: 'Rolling deploy started: edge-01 (1/2). Health check pending.', ts: '14:30' },
    { sender: 'VOLT Ledger', avatar: 'V', type: 'system', protocol: 'WARD', text: 'WARD receipt issued for deploy chain. Hash: 8f3a2c...d71e. Tamper-evident seal applied.', ts: '14:31' },
  ]
  const protocolColors = { AEE: '#38bdf8', VOLT: '#30ff90', WARD: '#06b6d4', AOCL: '#a855f7' }
  const avatarColors = { A: '#38bdf8', F: '#a855f7', S: '#ef4444', V: '#30ff90' }

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>MATRIX FEDERATION</div>
      <GP style={{ padding: 14 }}>
        {/* Room header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: M, fontSize: 14, fontWeight: 700, color: '#fff' }}>#quox-ops</span>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>47 members</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(48,255,144,0.08)', fontSize: 9, fontFamily: M, fontWeight: 600, color: '#30ff90' }}>{'\uD83D\uDD12'} Encrypted</span>
          </div>
        </div>
        {/* Messages */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((msg, i) => {
            const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
            return (
              <div key={i} style={{ display: 'flex', gap: 10, opacity: op }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${avatarColors[msg.avatar] || '#666'}15`, border: `1px solid ${avatarColors[msg.avatar] || '#666'}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontFamily: M, fontWeight: 700, color: avatarColors[msg.avatar] || '#fff', flexShrink: 0 }}>{msg.avatar}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: avatarColors[msg.avatar] || '#fff' }}>{msg.sender}</span>
                    {msg.protocol && <span style={{ padding: '1px 5px', borderRadius: 3, background: `${protocolColors[msg.protocol]}12`, fontSize: 8, fontFamily: M, fontWeight: 600, color: protocolColors[msg.protocol] }}>{msg.protocol}</span>}
                    <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>{msg.ts}</span>
                  </div>
                  <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.85)', lineHeight: 1.5 }}>{msg.text}</div>
                </div>
              </div>
            )
          })}
        </div>
        {/* Compose */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ flex: 1, height: 32, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', padding: '0 10px' }}>
            <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>Type a message...</span>
          </div>
          <div style={{ padding: '6px 14px', borderRadius: 6, background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.2)', cursor: 'pointer', fontFamily: M, fontSize: 10, fontWeight: 600, color: '#38bdf8' }}>Send via Matrix</div>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// PRICING CALCULATOR — Interactive pricing mockup
// ═══════════════════════════════════════════════════════════════
export function PricingCalculator() {
  const [nodes, setNodes] = useState(5)
  const f = useAnimFrame()
  const tiers = [
    { name: 'Starter', price: '$0', period: 'free forever', popular: false, color: 'rgba(255,255,255,0.6)',
      features: ['3 agents', 'Community support', '1,000 VOLT records/mo', 'Basic memory (1GB)', 'Dashboard access', 'AEE protocol'] },
    { name: 'Professional', price: '$49', period: '/node/mo', popular: true, color: '#38bdf8',
      features: ['16 agents', 'Priority support', 'Unlimited VOLT records', 'Advanced memory (50GB)', 'Agentic Teams', 'Full protocol stack'] },
    { name: 'Enterprise', price: 'Custom', period: 'contact us', popular: false, color: '#a855f7',
      features: ['Unlimited agents', 'Dedicated support', 'On-premise option', 'Unlimited memory', 'Custom integrations', 'SLA guarantee'] },
  ]
  const monthlyCost = nodes * 49

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>PRICING</div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        {tiers.map((tier, i) => {
          const op = lerp(f, i * 4, i * 4 + 12, 0, 1)
          return (
            <GP key={i} style={{ flex: 1, padding: 16, opacity: op, borderTopColor: tier.popular ? `${tier.color}40` : 'rgba(255,255,255,0.06)', ...(tier.popular ? { boxShadow: `0 0 24px ${tier.color}15, 0 5px 19px rgba(0,0,0,0.35), inset 0 1px 2px rgba(255,255,255,0.08)` } : {}) }}>
              {tier.popular && <div style={{ position: 'absolute', top: -1, left: '50%', transform: 'translateX(-50%)', padding: '2px 12px', borderRadius: '0 0 6px 6px', background: tier.color, fontSize: 9, fontFamily: M, fontWeight: 700, color: '#0a0e1a', zIndex: 2 }}>POPULAR</div>}
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                <div style={{ fontFamily: M, fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>{tier.name}</div>
                <div style={{ fontFamily: M, fontSize: 28, fontWeight: 800, color: tier.color }}>{tier.price}</div>
                <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{tier.period}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {tier.features.map((feat, j) => (
                  <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontFamily: M }}>
                    <span style={{ color: '#30ff90', fontSize: 10 }}>{'\u2713'}</span>
                    <span style={{ color: 'rgba(255,255,255,0.8)' }}>{feat}</span>
                  </div>
                ))}
              </div>
            </GP>
          )
        })}
      </div>
      {/* Usage calculator */}
      <GP style={{ padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Nodes:</span>
          <input type="range" min={1} max={50} value={nodes} onChange={e => setNodes(Number(e.target.value))} style={{ flex: 1, height: 4, accentColor: '#38bdf8', background: 'rgba(255,255,255,0.08)', borderRadius: 2 }} />
          <span style={{ fontFamily: M, fontSize: 14, fontWeight: 700, color: '#38bdf8', minWidth: 24, textAlign: 'right' }}>{nodes}</span>
          <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)' }} />
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>Monthly:</span>
          <span style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: '#30ff90' }}>${monthlyCost.toLocaleString()}</span>
        </div>
      </GP>
      {/* Add-ons */}
      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        <GP style={{ flex: 1, padding: '8px 12px' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Marketplace Commission</div>
          <div style={{ fontFamily: M, fontSize: 14, fontWeight: 700, color: '#f59e0b' }}>30%</div>
        </GP>
        <GP style={{ flex: 1, padding: '8px 12px' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Premium Plugins</div>
          <div style={{ fontFamily: M, fontSize: 14, fontWeight: 700, color: '#a855f7' }}>from $4/mo</div>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// SDK PLAYGROUND — AEE SDK code preview
// ═══════════════════════════════════════════════════════════════
export function SDKPlayground() {
  const [lang, setLang] = useState('typescript')
  const [copied, setCopied] = useState(false)
  const f = useAnimFrame()

  const code = {
    typescript: [
      { text: "import", color: '#c586c0' }, { text: " { AEEClient } ", color: '#9cdcfe' }, { text: "from ", color: '#c586c0' }, { text: "'@quox/aee-sdk'", color: '#ce9178' },
      { text: "", color: '#fff' },
      { text: "const ", color: '#569cd6' }, { text: "client = ", color: '#9cdcfe' }, { text: "new ", color: '#569cd6' }, { text: "AEEClient", color: '#4ec9b0' }, { text: "({", color: '#fff' },
      { text: "  endpoint: ", color: '#9cdcfe' }, { text: "'https://api.quox.ai'", color: '#ce9178' },
      { text: "})", color: '#fff' },
      { text: "", color: '#fff' },
      { text: "const ", color: '#569cd6' }, { text: "envelope = ", color: '#9cdcfe' }, { text: "await ", color: '#c586c0' }, { text: "client.wrap({", color: '#fff' },
      { text: "  intent: ", color: '#9cdcfe' }, { text: "'quox.task.execute'", color: '#ce9178' }, { text: ",", color: '#fff' },
      { text: "  from: ", color: '#9cdcfe' }, { text: "'agent.sentinel'", color: '#ce9178' }, { text: ",", color: '#fff' },
      { text: "  to: ", color: '#9cdcfe' }, { text: "'agent.forge'", color: '#ce9178' }, { text: ",", color: '#fff' },
      { text: "  payload: { task: ", color: '#9cdcfe' }, { text: "'security-scan'", color: '#ce9178' }, { text: ", target: ", color: '#9cdcfe' }, { text: "'edge-03'", color: '#ce9178' }, { text: " }", color: '#fff' },
      { text: "})", color: '#fff' },
      { text: "", color: '#fff' },
      { text: "// Automatic VOLT evidence capture", color: '#6a9955' },
      { text: "console", color: '#9cdcfe' }, { text: ".log(envelope.voltHash) ", color: '#fff' }, { text: "// '8f3a2c...d71e'", color: '#6a9955' },
    ],
    python: [
      { text: "from ", color: '#c586c0' }, { text: "quox.aee ", color: '#9cdcfe' }, { text: "import ", color: '#c586c0' }, { text: "AEEClient", color: '#4ec9b0' },
      { text: "", color: '#fff' },
      { text: "client = ", color: '#9cdcfe' }, { text: "AEEClient", color: '#4ec9b0' }, { text: "(endpoint=", color: '#fff' }, { text: "'https://api.quox.ai'", color: '#ce9178' }, { text: ")", color: '#fff' },
      { text: "", color: '#fff' },
      { text: "envelope = client.wrap(", color: '#fff' },
      { text: "  intent=", color: '#9cdcfe' }, { text: "'quox.task.execute'", color: '#ce9178' }, { text: ",", color: '#fff' },
      { text: "  from_agent=", color: '#9cdcfe' }, { text: "'agent.sentinel'", color: '#ce9178' }, { text: ",", color: '#fff' },
      { text: "  to=", color: '#9cdcfe' }, { text: "'agent.forge'", color: '#ce9178' }, { text: ",", color: '#fff' },
      { text: "  payload={", color: '#fff' }, { text: "'task'", color: '#ce9178' }, { text: ": ", color: '#fff' }, { text: "'security-scan'", color: '#ce9178' }, { text: "}", color: '#fff' },
      { text: ")", color: '#fff' },
      { text: "", color: '#fff' },
      { text: "# Automatic VOLT evidence capture", color: '#6a9955' },
      { text: "print", color: '#dcdcaa' }, { text: "(envelope.volt_hash)  ", color: '#fff' }, { text: "# '8f3a2c...d71e'", color: '#6a9955' },
    ],
    go: [
      { text: "package ", color: '#c586c0' }, { text: "main", color: '#fff' },
      { text: "", color: '#fff' },
      { text: "import ", color: '#c586c0' }, { text: '"github.com/quoxai/aee-sdk-go"', color: '#ce9178' },
      { text: "", color: '#fff' },
      { text: "func ", color: '#569cd6' }, { text: "main() {", color: '#dcdcaa' },
      { text: "  client := aee.", color: '#9cdcfe' }, { text: "NewClient", color: '#dcdcaa' }, { text: '("https://api.quox.ai")', color: '#ce9178' },
      { text: "", color: '#fff' },
      { text: "  envelope, _ := client.", color: '#9cdcfe' }, { text: "Wrap", color: '#dcdcaa' }, { text: "(aee.Envelope{", color: '#fff' },
      { text: '    Intent: ', color: '#9cdcfe' }, { text: '"quox.task.execute"', color: '#ce9178' }, { text: ",", color: '#fff' },
      { text: '    From:   ', color: '#9cdcfe' }, { text: '"agent.sentinel"', color: '#ce9178' }, { text: ",", color: '#fff' },
      { text: '    To:     ', color: '#9cdcfe' }, { text: '"agent.forge"', color: '#ce9178' }, { text: ",", color: '#fff' },
      { text: "  })", color: '#fff' },
      { text: "", color: '#fff' },
      { text: "  // Automatic VOLT evidence capture", color: '#6a9955' },
      { text: "  fmt.", color: '#9cdcfe' }, { text: "Println", color: '#dcdcaa' }, { text: "(envelope.VoltHash)", color: '#fff' },
      { text: "}", color: '#fff' },
    ],
  }

  const langs = ['typescript', 'python', 'go']
  const installCmd = lang === 'typescript' ? 'npm install @quox/aee-sdk' : lang === 'python' ? 'pip install quox-aee-sdk' : 'go get github.com/quoxai/aee-sdk-go'

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>SDK PLAYGROUND</div>
      <GP style={{ padding: 0, overflow: 'hidden' }}>
        {/* Language tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          {langs.map(l => (
            <div key={l} onClick={() => setLang(l)} style={{ padding: '8px 16px', cursor: 'pointer', fontFamily: M, fontSize: 10, fontWeight: lang === l ? 700 : 400, color: lang === l ? '#38bdf8' : 'rgba(255,255,255,0.6)', borderBottom: lang === l ? '2px solid #38bdf8' : '2px solid transparent', background: lang === l ? 'rgba(56,189,248,0.04)' : 'transparent' }}>
              {l === 'typescript' ? 'TypeScript' : l === 'python' ? 'Python' : 'Go'}
            </div>
          ))}
        </div>
        {/* Code block */}
        <div style={{ padding: '12px 16px', background: 'rgba(0,0,0,0.3)', fontFamily: M, fontSize: 11, lineHeight: 1.7 }}>
          {(code[lang] || []).map((line, i) => (
            <div key={i} style={{ minHeight: line.text === '' ? 12 : 'auto' }}>
              {line.text.split(/(\S+)/).map((part, j) => {
                const isStr = part.startsWith("'") || part.startsWith('"')
                return <span key={j} style={{ color: isStr ? '#ce9178' : line.color }}>{part}</span>
              })}
            </div>
          ))}
        </div>
        {/* Install bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>{installCmd}</span>
          <div onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }} style={{ padding: '3px 10px', borderRadius: 4, background: 'rgba(56,189,248,0.1)', cursor: 'pointer', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#38bdf8' }}>
            {copied ? '\u2713 Copied' : 'Copy'}
          </div>
        </div>
      </GP>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 14, marginTop: 10, fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>
        <span><span style={{ color: '#38bdf8', fontWeight: 700 }}>247</span> weekly downloads</span>
        <span><span style={{ color: '#a855f7', fontWeight: 700 }}>12</span> contributors</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// INVESTOR DECK SLIDE — Key investor metrics
// ═══════════════════════════════════════════════════════════════
export function InvestorDeckSlide() {
  const f = useAnimFrame()
  const metrics = [
    { label: 'MRR', value: '$0', target: '$50K target', color: '#30ff90' },
    { label: 'Agents Deployed', value: '16', target: 'across 4 hosts', color: '#a855f7' },
    { label: 'Evidence Records', value: '148K', target: 'VOLT verified', color: '#06b6d4' },
    { label: 'Uptime', value: '99.97%', target: 'last 90 days', color: '#38bdf8' },
  ]
  const protocols = [
    { name: 'AEE', desc: 'Agent Envelope Exchange', color: '#38bdf8' },
    { name: 'AOCL', desc: 'Orchestration Control', color: '#a855f7' },
    { name: 'VOLT', desc: 'Verifiable Ledger', color: '#30ff90' },
    { name: 'WARD', desc: 'Write-once Receipts', color: '#06b6d4' },
  ]

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>INVESTOR METRICS</div>
      {/* Top metrics */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        {metrics.map((m, i) => {
          const op = lerp(f, i * 3, i * 3 + 10, 0, 1)
          return (
            <GP key={i} style={{ flex: 1, padding: 14, textAlign: 'center', opacity: op, borderTopColor: `${m.color}30` }}>
              <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>{m.label}</div>
              <div style={{ fontFamily: M, fontSize: 28, fontWeight: 800, color: m.color, fontVariantNumeric: 'tabular-nums' }}>{m.value}</div>
              <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{m.target}</div>
            </GP>
          )
        })}
      </div>
      {/* Market opportunity */}
      <GP style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>TAM — AI Agent Orchestration</div>
            <div style={{ fontFamily: M, fontSize: 22, fontWeight: 800, color: '#f59e0b' }}>$4.8B <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>by 2034</span></div>
          </div>
          <div style={{ fontSize: 28, color: '#30ff90', opacity: 0.6 + Math.sin(f * 0.08) * 0.2 }}>{'\u2197'}</div>
        </div>
      </GP>
      {/* Competitive moat */}
      <GP style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>COMPETITIVE MOAT — Only complete trust stack</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {protocols.map((p, i) => (
            <div key={i} style={{ flex: 1, textAlign: 'center', padding: '8px 4px', borderRadius: 6, background: `${p.color}06`, border: `1px solid ${p.color}20` }}>
              <div style={{ fontFamily: M, fontSize: 12, fontWeight: 800, color: p.color, letterSpacing: 1 }}>{p.name}</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{p.desc}</div>
            </div>
          ))}
        </div>
      </GP>
      {/* Traction */}
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', textAlign: 'center' }}>
        <span style={{ color: '#38bdf8', fontWeight: 700 }}>8</span> repos {'\u00B7'} <span style={{ color: '#a855f7', fontWeight: 700 }}>2,800+</span> tests {'\u00B7'} <span style={{ color: '#30ff90', fontWeight: 700 }}>62</span> UI components {'\u00B7'} <span style={{ color: '#06b6d4', fontWeight: 700 }}>4</span> protocol specs
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ONBOARDING FLOW — New user onboarding wizard
// ═══════════════════════════════════════════════════════════════
export function OnboardingFlow() {
  const [activeStep, setActiveStep] = useState(2) // 0-indexed, step 3 = index 2
  const f = useAnimFrame()
  const steps = [
    { label: 'Create Org', icon: '\u25C7', done: true },
    { label: 'Add Team', icon: '\u25C8', done: true },
    { label: 'Connect Tools', icon: '\u26A1', done: false },
    { label: 'Deploy Agent', icon: '\u25B6', done: false },
    { label: 'First Objective', icon: '\u2605', done: false },
  ]
  const connectors = [
    { name: 'GitHub', color: '#8b5cf6', enabled: true },
    { name: 'Jira', color: '#0052cc', enabled: false },
    { name: 'Slack', color: '#e01e5a', enabled: true },
    { name: 'Linear', color: '#5e6ad2', enabled: false },
  ]
  const completedCount = steps.filter(s => s.done).length
  const progressPct = (completedCount / steps.length) * 100

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>ONBOARDING</div>
      {/* Stepper */}
      <GP style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          {steps.map((step, i) => {
            const isActive = i === activeStep
            const isDone = step.done
            const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', flex: 1, opacity: op }}>
                <div onClick={() => setActiveStep(i)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'pointer', flex: 1 }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: isDone ? 14 : 16, fontWeight: 700, background: isDone ? 'rgba(48,255,144,0.15)' : isActive ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.04)', border: `2px solid ${isDone ? '#30ff90' : isActive ? '#38bdf8' : 'rgba(255,255,255,0.1)'}`, color: isDone ? '#30ff90' : isActive ? '#38bdf8' : 'rgba(255,255,255,0.4)', boxShadow: isActive ? '0 0 12px rgba(56,189,248,0.2)' : 'none', transition: 'all 0.2s' }}>
                    {isDone ? '\u2713' : step.icon}
                  </div>
                  <span style={{ fontFamily: M, fontSize: 9, fontWeight: isActive ? 700 : 400, color: isDone ? '#30ff90' : isActive ? '#38bdf8' : 'rgba(255,255,255,0.5)', textAlign: 'center', whiteSpace: 'nowrap' }}>{step.label}</span>
                </div>
                {i < steps.length - 1 && <div style={{ height: 2, flex: '0 0 20px', background: isDone ? '#30ff90' : 'rgba(255,255,255,0.08)', borderRadius: 1, margin: '0 -4px', marginBottom: 16 }} />}
              </div>
            )
          })}
        </div>
      </GP>
      {/* Active step content */}
      <GP style={{ padding: 16 }}>
        <div style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: '#38bdf8', marginBottom: 4 }}>Step {activeStep + 1}: {steps[activeStep].label}</div>
        <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 12 }}>Select the tools your team uses. You can add more later.</div>
        {/* Connector grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 14 }}>
          {connectors.map((c, i) => (
            <GP key={i} style={{ padding: '10px 14px', borderTopColor: c.enabled ? `${c.color}30` : 'rgba(255,255,255,0.06)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 24, height: 24, borderRadius: 6, background: `${c.color}15`, border: `1px solid ${c.color}25`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 10, fontWeight: 700, color: c.color }}>{c.name[0]}</div>
                  <span style={{ fontFamily: M, fontSize: 11, fontWeight: 600, color: '#fff' }}>{c.name}</span>
                </div>
                {/* Toggle */}
                <div style={{ width: 36, height: 18, borderRadius: 9, background: c.enabled ? `${c.color}30` : 'rgba(255,255,255,0.08)', position: 'relative' }}>
                  <div style={{ position: 'absolute', top: 2, left: c.enabled ? 20 : 2, width: 14, height: 14, borderRadius: '50%', background: c.enabled ? c.color : 'rgba(255,255,255,0.3)', transition: 'left 0.2s' }} />
                </div>
              </div>
            </GP>
          ))}
        </div>
        {/* Progress */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>{completedCount} of {steps.length} complete</span>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)' }}>
            <div style={{ width: `${progressPct}%`, height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, #38bdf8, #30ff90)', transition: 'width 0.3s' }} />
          </div>
        </div>
        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <div style={{ padding: '6px 16px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>Skip for now</div>
          <div style={{ padding: '6px 16px', borderRadius: 6, background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.3)', cursor: 'pointer', fontFamily: M, fontSize: 10, fontWeight: 600, color: '#38bdf8' }}>Continue {'\u2192'}</div>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// TRUST & GOVERNANCE
// ═══════════════════════════════════════════════════════════════

// ── TrustScorecard ──
export function TrustScorecard() {
  const f = useAnimFrame()
  const score = 94
  const breakdown = [
    { label: 'AEE Coverage', value: 98, color: '#38bdf8' },
    { label: 'AOCL Enforcement', value: 96, color: '#a855f7' },
    { label: 'VOLT Evidence', value: 91, color: '#30ff90' },
    { label: 'WARD Witnessing', value: 89, color: '#06b6d4' },
  ]
  const trend = [88, 89, 90, 91, 92, 93, 94]
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>TRUST SCORECARD</div>
      <div style={{ display: 'flex', gap: 20, marginBottom: 16 }}>
        {/* Big score */}
        <div style={{ textAlign: 'center', minWidth: 120 }}>
          <div style={{ fontSize: 56, fontFamily: M, fontWeight: 800, color: '#30ff90', lineHeight: 1 }}>{score}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', fontFamily: M, marginTop: 2 }}>/ 100</div>
          <div style={{ marginTop: 8, display: 'inline-block', padding: '4px 14px', borderRadius: 8, background: 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.3)', fontFamily: M, fontSize: 13, fontWeight: 700, color: '#30ff90' }}>Trust Grade: A+</div>
          <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: M }}>Industry avg: <span style={{ color: '#f59e0b', fontWeight: 600 }}>34/100</span></div>
        </div>
        {/* Breakdown bars */}
        <div style={{ flex: 1 }}>
          {breakdown.map((b, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)' }}>{b.label}</span>
                <span style={{ fontSize: 11, fontFamily: M, fontWeight: 600, color: b.color }}>{b.value}%</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${b.value}%`, height: '100%', borderRadius: 3, background: `linear-gradient(90deg, ${b.color}80, ${b.color})`, transition: 'width 0.6s' }} />
              </div>
            </div>
          ))}
          {/* 7-day sparkline */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: M, marginBottom: 4 }}>7-day trend</div>
            <svg viewBox="0 0 120 30" style={{ width: 120, height: 30 }}>
              <polyline
                points={trend.map((v, i) => `${i * 20},${30 - (v - 85) * 3}`).join(' ')}
                fill="none" stroke="#30ff90" strokeWidth={1.5} opacity={0.8}
              />
              {trend.map((v, i) => (
                <circle key={i} cx={i * 20} cy={30 - (v - 85) * 3} r={2} fill="#30ff90" opacity={0.6 + (i === trend.length - 1 ? 0.4 : 0)} />
              ))}
            </svg>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── PolicyEditor ──
export function PolicyEditor() {
  const policies = [
    { name: 'deploy.production.require_approval', status: 'ENFORCED', statusColor: '#30ff90', detail: '2-person rule', evals: 147, bypasses: 0, trend: [10, 12, 14, 18, 22, 25, 28] },
    { name: 'data.export.pii_redaction', status: 'ENFORCED', statusColor: '#30ff90', detail: 'Auto-redact PII', evals: 89, bypasses: 2, trend: [5, 8, 10, 12, 14, 15, 17] },
    { name: 'agent.budget.max_tokens', status: 'WARNING', statusColor: '#f59e0b', detail: '10K token limit', evals: 23, bypasses: 0, nearMisses: 23, trend: [2, 3, 5, 4, 6, 8, 7] },
  ]
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>AOCL POLICY EDITOR</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {policies.map((p, i) => (
          <GP key={i} style={{ padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div>
                <div style={{ fontFamily: M, fontSize: 12, fontWeight: 600, color: '#fff', marginBottom: 4 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>{p.detail}</div>
              </div>
              <div style={{ padding: '3px 10px', borderRadius: 6, background: `${p.statusColor}15`, border: `1px solid ${p.statusColor}40`, fontFamily: M, fontSize: 10, fontWeight: 700, color: p.statusColor }}>{p.status}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', fontFamily: M }}>
                <span style={{ color: '#38bdf8', fontWeight: 600 }}>{p.evals}</span> evaluations
              </div>
              {p.bypasses !== undefined && (
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', fontFamily: M }}>
                  <span style={{ color: p.bypasses > 0 ? '#f59e0b' : '#30ff90', fontWeight: 600 }}>{p.bypasses}</span> {p.bypasses === 0 ? 'bypasses' : 'exceptions'}
                </div>
              )}
              {p.nearMisses && (
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', fontFamily: M }}>
                  <span style={{ color: '#f59e0b', fontWeight: 600 }}>{p.nearMisses}</span> near-misses
                </div>
              )}
              <div style={{ marginLeft: 'auto' }}>
                <svg viewBox="0 0 70 20" style={{ width: 70, height: 20 }}>
                  <polyline points={p.trend.map((v, j) => `${j * 11},${20 - v * 0.7}`).join(' ')} fill="none" stroke={p.statusColor} strokeWidth={1.2} opacity={0.7} />
                </svg>
              </div>
            </div>
          </GP>
        ))}
      </div>
    </div>
  )
}

// ── AuditExplorer ──
export function AuditExplorer() {
  const [filter, setFilter] = useState('All')
  const filters = ['All', 'AEE', 'VOLT', 'WARD']
  const events = [
    { hash: '8f3a2c...d71e', ts: '14:31:49', type: 'VOLT', typeColor: '#30ff90', actor: 'QuoxFlow', action: 'Deploy recorded', verified: true },
    { hash: 'c54d09...a8b2', ts: '14:30:02', type: 'AEE', typeColor: '#38bdf8', actor: 'VULCAN', action: 'Envelope dispatched', verified: true },
    { hash: 'd91e4b...f3c7', ts: '14:29:18', type: 'WARD', typeColor: '#06b6d4', actor: 'WARDEN', action: 'Receipt witnessed', verified: true },
    { hash: 'a7f3c2...1b4e', ts: '14:28:55', type: 'VOLT', typeColor: '#30ff90', actor: 'HYPERION', action: 'Scaling event logged', verified: true },
    { hash: 'f28a71...9d06', ts: '14:27:33', type: 'AEE', typeColor: '#38bdf8', actor: 'CommanderQ', action: 'Approval granted', verified: false },
    { hash: 'e61b83...4a2f', ts: '14:26:01', type: 'WARD', typeColor: '#06b6d4', actor: 'VOLT Ledger', action: 'Chain anchored', verified: true },
  ]
  const filtered = filter === 'All' ? events : events.filter(e => e.type === filter)
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>AUDIT EXPLORER</div>
      {/* Search + filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <div style={{ flex: 1, padding: '6px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', fontFamily: M, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
          Search events, hashes, actors...
        </div>
        {filters.map(fl => (
          <div key={fl} onClick={() => setFilter(fl)} style={{ padding: '4px 12px', borderRadius: 6, background: filter === fl ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.04)', border: `1px solid ${filter === fl ? 'rgba(56,189,248,0.3)' : 'rgba(255,255,255,0.08)'}`, fontFamily: M, fontSize: 10, fontWeight: filter === fl ? 600 : 400, color: filter === fl ? '#38bdf8' : 'rgba(255,255,255,0.7)', cursor: 'pointer' }}>
            {fl}
          </div>
        ))}
      </div>
      {/* Event rows */}
      {filtered.map((ev, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
          <span style={{ fontFamily: M, fontSize: 10, color: '#06b6d4', minWidth: 90 }}>{ev.hash}</span>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)', minWidth: 55 }}>{ev.ts}</span>
          <span style={{ padding: '2px 8px', borderRadius: 4, background: `${ev.typeColor}15`, fontFamily: M, fontSize: 9, fontWeight: 600, color: ev.typeColor, minWidth: 36, textAlign: 'center' }}>{ev.type}</span>
          <span style={{ fontSize: 11, color: '#fff', fontWeight: 500, minWidth: 80 }}>{ev.actor}</span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{ev.action}</span>
          <span style={{ fontSize: 12, color: ev.verified ? '#30ff90' : '#f59e0b' }}>{ev.verified ? '\u2713' : '\u25CB'}</span>
        </div>
      ))}
      <div style={{ marginTop: 10, fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>148,291 total records</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// AGENT ECONOMY
// ═══════════════════════════════════════════════════════════════

// ── AgentMarketplace ──
export function AgentMarketplace() {
  const plugins = [
    { name: 'YouTube Publisher', price: '$4/mo', rating: 4.8, installs: '1.2K', gradient: 'linear-gradient(135deg, #ef4444 0%, #f59e0b 100%)' },
    { name: 'LinkedIn Autopilot', price: '$8/mo', rating: 4.5, installs: '890', gradient: 'linear-gradient(135deg, #0077b5 0%, #38bdf8 100%)' },
    { name: 'Security Scanner', price: 'Free', rating: 4.9, installs: '3.1K', gradient: 'linear-gradient(135deg, #30ff90 0%, #06b6d4 100%)' },
    { name: 'Backup Manager', price: '$6/mo', rating: 4.7, installs: '567', gradient: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)' },
    { name: 'Marketing Bundle', price: '$99/mo', rating: 4.6, installs: '234', gradient: 'linear-gradient(135deg, #ec4899 0%, #f59e0b 100%)' },
    { name: 'Connector SDK', price: 'Free', rating: 4.2, installs: '445', gradient: 'linear-gradient(135deg, #38bdf8 0%, #6366f1 100%)' },
  ]
  const stars = (r) => {
    const full = Math.floor(r)
    const half = r - full >= 0.5
    let s = ''
    for (let i = 0; i < full; i++) s += '\u2605'
    if (half) s += '\u2606'
    return s
  }
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>AGENT MARKETPLACE</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {plugins.map((p, i) => (
          <GP key={i} style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ height: 48, background: p.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
              {['\uD83D\uDCF9', '\uD83D\uDCBC', '\uD83D\uDEE1\uFE0F', '\uD83D\uDCBE', '\uD83D\uDCC8', '\uD83D\uDD27'][i]}
            </div>
            <div style={{ padding: '10px 12px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', marginBottom: 4 }}>{p.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ padding: '2px 8px', borderRadius: 4, background: p.price === 'Free' ? 'rgba(48,255,144,0.1)' : 'rgba(56,189,248,0.1)', border: `1px solid ${p.price === 'Free' ? 'rgba(48,255,144,0.3)' : 'rgba(56,189,248,0.3)'}`, fontFamily: M, fontSize: 9, fontWeight: 600, color: p.price === 'Free' ? '#30ff90' : '#38bdf8' }}>{p.price}</span>
                <span style={{ fontSize: 10, color: '#f59e0b' }}>{stars(p.rating)}</span>
                <span style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.6)' }}>{p.rating}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.6)' }}>{p.installs} installs</span>
                <div style={{ padding: '4px 12px', borderRadius: 6, background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.25)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#38bdf8', cursor: 'pointer' }}>Install</div>
              </div>
            </div>
          </GP>
        ))}
      </div>
    </div>
  )
}

// ── RevenueMetrics ──
export function RevenueMetrics() {
  const topSellers = [
    { name: 'Quox Labs', plugins: 5, mrr: '$842', commission: '$252.60' },
    { name: 'DevOps Pro', plugins: 3, mrr: '$534', commission: '$160.20' },
    { name: 'SecureAI Ltd', plugins: 4, mrr: '$421', commission: '$126.30' },
    { name: 'DataFlow Inc', plugins: 2, mrr: '$318', commission: '$95.40' },
    { name: 'CloudNinja', plugins: 1, mrr: '$267', commission: '$80.10' },
  ]
  const revenueData = [120, 340, 580, 890, 1240, 1680, 2100, 2450, 2680, 2847]
  const maxRev = Math.max(...revenueData)
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>MARKETPLACE REVENUE</div>
      {/* Top stats */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {[
          { label: 'MRR', value: '$2,847', color: '#30ff90' },
          { label: 'ARR', value: '$34.2K', color: '#38bdf8' },
          { label: 'Active Sellers', value: '23', color: '#a855f7' },
          { label: 'Paid Plugins', value: '47', color: '#06b6d4' },
        ].map((s, i) => (
          <GP key={i} style={{ flex: 1, padding: '10px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>{s.label}</div>
            <div style={{ fontSize: 18, fontFamily: M, fontWeight: 800, color: s.color }}>{s.value}</div>
          </GP>
        ))}
      </div>
      {/* Mini area chart */}
      <GP style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.6)', marginBottom: 6 }}>Revenue Growth (10 months)</div>
        <svg viewBox="0 0 200 50" style={{ width: '100%', height: 50 }}>
          <defs>
            <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#30ff90" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#30ff90" stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon
            points={revenueData.map((v, j) => `${j * 22},${50 - (v / maxRev) * 45}`).join(' ') + ` ${(revenueData.length - 1) * 22},50 0,50`}
            fill="url(#revGrad)"
          />
          <polyline
            points={revenueData.map((v, j) => `${j * 22},${50 - (v / maxRev) * 45}`).join(' ')}
            fill="none" stroke="#30ff90" strokeWidth={1.5}
          />
        </svg>
      </GP>
      {/* Top sellers table */}
      <div style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.6)', marginBottom: 6 }}>Top Sellers</div>
      <div style={{ display: 'flex', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.08)', fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>
        <span style={{ flex: 2 }}>Seller</span>
        <span style={{ flex: 1, textAlign: 'center' }}>Plugins</span>
        <span style={{ flex: 1, textAlign: 'right' }}>MRR</span>
        <span style={{ flex: 1, textAlign: 'right' }}>Commission</span>
      </div>
      {topSellers.map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '6px 0', borderBottom: i < topSellers.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
          <span style={{ flex: 2, fontSize: 11, color: '#fff', fontWeight: 500 }}>{s.name}</span>
          <span style={{ flex: 1, textAlign: 'center', fontSize: 11, fontFamily: M, color: 'rgba(255,255,255,0.7)' }}>{s.plugins}</span>
          <span style={{ flex: 1, textAlign: 'right', fontSize: 11, fontFamily: M, fontWeight: 600, color: '#30ff90' }}>{s.mrr}</span>
          <span style={{ flex: 1, textAlign: 'right', fontSize: 11, fontFamily: M, color: 'rgba(255,255,255,0.7)' }}>{s.commission}</span>
        </div>
      ))}
      <div style={{ marginTop: 10, display: 'inline-block', padding: '3px 10px', borderRadius: 6, background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.3)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#a855f7' }}>30% commission rate</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// DEVELOPER EXPERIENCE
// ═══════════════════════════════════════════════════════════════

// ── APIExplorer ──
export function APIExplorer() {
  const [selected, setSelected] = useState(0)
  const endpoints = [
    { method: 'POST', path: '/chat/claude', desc: 'Send message to Claude via collector', time: '320ms', color: '#a855f7', response: '{ "response": "...", "envelope": { "id": "01JFX..." } }' },
    { method: 'GET', path: '/api/objectives', desc: 'List all objectives with status', time: '12ms', color: '#06b6d4', response: '{ "objectives": [{ "id": 1, "title": "Deploy v2.4", "status": "running" }] }' },
    { method: 'POST', path: '/api/workflows/execute', desc: 'Trigger a QuoxFlow workflow', time: '45ms', color: '#a855f7', response: '{ "executionId": "exec-7a3f", "status": "started" }' },
    { method: 'GET', path: '/api/volt/records', desc: 'Query VOLT audit ledger', time: '8ms', color: '#06b6d4', response: '{ "records": [{ "hash": "8f3a2c...", "action": "deploy" }], "total": 8247 }' },
  ]
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>API EXPLORER</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {endpoints.map((ep, i) => (
          <GP key={i} style={{ padding: '10px 14px', cursor: 'pointer', border: selected === i ? '1px solid rgba(56,189,248,0.2)' : undefined }} onClick={() => setSelected(i)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ padding: '2px 8px', borderRadius: 4, background: `${ep.color}18`, fontFamily: M, fontSize: 10, fontWeight: 700, color: ep.color, minWidth: 36, textAlign: 'center' }}>{ep.method}</span>
              <span style={{ fontFamily: M, fontSize: 11, color: '#fff', fontWeight: 600 }}>{ep.path}</span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', flex: 1 }}>{ep.desc}</span>
              <span style={{ fontFamily: M, fontSize: 10, color: '#30ff90', fontWeight: 600 }}>{ep.time}</span>
            </div>
            {selected === i && (
              <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'rgba(0,0,0,0.3)', fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
                {ep.response}
              </div>
            )}
          </GP>
        ))}
      </div>
      <div style={{ marginTop: 10, fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>12 endpoints, avg 45ms response time</div>
    </div>
  )
}

// ── WebhookMonitor ──
export function WebhookMonitor() {
  const channels = [
    { name: 'Telegram', status: 'online', statusColor: '#30ff90', msgs: '1,247', lastMsg: '12s ago', latency: '23ms', icon: '\u2708' },
    { name: 'Slack', status: 'online', statusColor: '#30ff90', msgs: '892', lastMsg: '45s ago', latency: '18ms', icon: '#' },
    { name: 'Discord', status: 'degraded', statusColor: '#f59e0b', msgs: '234', lastMsg: '2m ago', latency: '340ms', icon: '\uD83C\uDFAE' },
    { name: 'Generic', status: 'online', statusColor: '#30ff90', msgs: '56', lastMsg: '5m ago', latency: '12ms', icon: '\u21AA' },
  ]
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>WEBHOOK MONITOR</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {channels.map((ch, i) => (
          <GP key={i} style={{ padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: ch.statusColor, boxShadow: `0 0 6px ${ch.statusColor}` }} />
              <span style={{ fontSize: 14, width: 20, textAlign: 'center' }}>{ch.icon}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', minWidth: 70 }}>{ch.name}</span>
              <span style={{ padding: '2px 8px', borderRadius: 4, background: `${ch.statusColor}15`, fontFamily: M, fontSize: 9, fontWeight: 600, color: ch.statusColor }}>{ch.status}</span>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1, textAlign: 'right' }}>{ch.msgs} msgs</span>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)', minWidth: 55, textAlign: 'right' }}>{ch.lastMsg}</span>
              <span style={{ fontFamily: M, fontSize: 10, color: ch.latency === '340ms' ? '#f59e0b' : '#30ff90', fontWeight: 600, minWidth: 40, textAlign: 'right' }}>{ch.latency}</span>
            </div>
          </GP>
        ))}
      </div>
      <div style={{ marginTop: 10, display: 'inline-block', padding: '3px 10px', borderRadius: 6, background: 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.3)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#30ff90' }}>Error rate: 0.02%</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OPERATIONS
// ═══════════════════════════════════════════════════════════════

// ── IncidentTimeline ──
export function IncidentTimeline() {
  const events = [
    { ts: '09:12:00', actor: 'WARDEN', action: 'Anomaly detected: SSH port unresponsive', type: 'detect', duration: null },
    { ts: '09:12:04', actor: 'Auto-Escalation', action: 'Escalated to P2 incident', type: 'escalate', duration: '4s' },
    { ts: '09:14:22', actor: 'admin@example.com', action: 'Incident acknowledged', type: 'ack', duration: '2m 18s' },
    { ts: '09:18:45', actor: 'VULCAN', action: 'Investigating: checking edge-03 process table', type: 'investigate', duration: '4m 23s' },
    { ts: '09:47:10', actor: 'VULCAN', action: 'Mitigated: sshd restarted, OOM limits raised', type: 'mitigate', duration: '28m 25s' },
    { ts: '09:59:00', actor: 'WARDEN', action: 'Verified: SSH responsive, all health checks passing', type: 'resolve', duration: '11m 50s' },
  ]
  const typeColors = { detect: '#ef4444', escalate: '#f59e0b', ack: '#38bdf8', investigate: '#a855f7', mitigate: '#06b6d4', resolve: '#30ff90' }
  const typeLabels = { detect: 'DETECTED', escalate: 'ESCALATED', ack: 'ACKNOWLEDGED', investigate: 'INVESTIGATING', mitigate: 'MITIGATED', resolve: 'RESOLVED' }
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>INCIDENT TIMELINE</div>
      {/* Incident header */}
      <GP style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div>
            <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: '#ef4444' }}>INC-2847</span>
            <span style={{ fontSize: 12, color: '#fff', fontWeight: 500, marginLeft: 8 }}>edge-03 SSH unreachable</span>
          </div>
          <div style={{ padding: '3px 10px', borderRadius: 6, background: 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.3)', fontFamily: M, fontSize: 10, fontWeight: 700, color: '#30ff90' }}>RESOLVED</div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>Duration: <span style={{ color: '#f59e0b', fontWeight: 600 }}>47 min</span></span>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>Root cause: <span style={{ color: '#fff', fontWeight: 500 }}>OOM kill on sshd process</span></span>
        </div>
      </GP>
      {/* Timeline */}
      <div style={{ position: 'relative', paddingLeft: 20 }}>
        <div style={{ position: 'absolute', left: 4, top: 4, bottom: 4, width: 2, background: 'rgba(255,255,255,0.06)' }} />
        {events.map((ev, i) => (
          <div key={i} style={{ position: 'relative', paddingBottom: i < events.length - 1 ? 12 : 0, paddingLeft: 16 }}>
            <div style={{ position: 'absolute', left: -1, top: 6, width: 10, height: 10, borderRadius: '50%', background: typeColors[ev.type], boxShadow: `0 0 8px ${typeColors[ev.type]}60` }} />
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)', minWidth: 55 }}>{ev.ts}</span>
              <span style={{ padding: '1px 6px', borderRadius: 3, background: `${typeColors[ev.type]}15`, fontFamily: M, fontSize: 8, fontWeight: 700, color: typeColors[ev.type], minWidth: 70, textAlign: 'center' }}>{typeLabels[ev.type]}</span>
              <span style={{ fontSize: 11, color: '#fff', fontWeight: 500, minWidth: 80 }}>{ev.actor}</span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{ev.action}</span>
              {ev.duration && <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>+{ev.duration}</span>}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, display: 'inline-block', padding: '3px 10px', borderRadius: 6, background: 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.3)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#30ff90' }}>MTTR: 47 min (target: 60 min) {'\u2713'}</div>
    </div>
  )
}

// ── CapacityPlanner ──
export function CapacityPlanner() {
  const resources = [
    { label: 'CPU', current: 62, projected: 78, color: '#38bdf8', projColor: '#38bdf880' },
    { label: 'Memory', current: 54, projected: 71, color: '#a855f7', projColor: '#a855f780' },
    { label: 'Storage', current: 47, projected: 63, color: '#30ff90', projColor: '#30ff9080' },
  ]
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>CAPACITY PLANNER</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {resources.map((r, i) => (
          <div key={i}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{r.label}</span>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
                <span style={{ color: r.color, fontWeight: 600 }}>{r.current}%</span>
                {' \u2192 '}
                <span style={{ color: r.projected >= 80 ? '#ef4444' : '#f59e0b', fontWeight: 600 }}>{r.projected}%</span>
                <span style={{ color: 'rgba(255,255,255,0.5)' }}> in 30d</span>
              </span>
            </div>
            <div style={{ position: 'relative', height: 12, borderRadius: 6, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              {/* Current usage */}
              <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${r.current}%`, borderRadius: 6, background: `linear-gradient(90deg, ${r.color}60, ${r.color})` }} />
              {/* Projected usage (dashed overlay) */}
              <div style={{ position: 'absolute', left: `${r.current}%`, top: 0, height: '100%', width: `${r.projected - r.current}%`, background: `repeating-linear-gradient(90deg, ${r.projColor} 0px, ${r.projColor} 4px, transparent 4px, transparent 8px)` }} />
              {/* 80% threshold line */}
              <div style={{ position: 'absolute', left: '80%', top: 0, bottom: 0, width: 2, background: '#ef4444', opacity: 0.6 }} />
              <div style={{ position: 'absolute', left: '80%', top: -14, fontFamily: M, fontSize: 8, color: '#ef4444', transform: 'translateX(-50%)' }}>80%</div>
            </div>
          </div>
        ))}
      </div>
      {/* Recommendation */}
      <GP style={{ padding: 12, marginTop: 14 }}>
        <div style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600, marginBottom: 4 }}>Recommendation</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', lineHeight: 1.5 }}>Add 1 node by April 15 to stay under 80% CPU threshold</div>
        <div style={{ marginTop: 6, fontFamily: M, fontSize: 10, color: '#38bdf8' }}>Cost projection: <span style={{ fontWeight: 600 }}>+$49/mo</span> for additional node</div>
      </GP>
    </div>
  )
}

// ── DeploymentTracker ──
export function DeploymentTracker() {
  const services = [
    { name: 'dashboard', status: 'healthy', statusColor: '#30ff90', detail: 'v2.4.1' },
    { name: 'collector', status: 'healthy', statusColor: '#30ff90', detail: 'v2.4.1' },
    { name: 'auth', status: 'healthy', statusColor: '#30ff90', detail: 'v2.4.1' },
    { name: 'quoxflow', status: '2 retries', statusColor: '#f59e0b', detail: 'v2.4.1' },
  ]
  const previous = ['v2.4.0', 'v2.3.9', 'v2.3.8']
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>DEPLOYMENT TRACKER</div>
      {/* Current deploy header */}
      <GP style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <span style={{ fontSize: 18, fontFamily: M, fontWeight: 800, color: '#38bdf8' }}>v2.4.1</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginLeft: 10 }}>deployed 2h ago</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ padding: '3px 10px', borderRadius: 6, background: 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.3)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#30ff90' }}>Zero-downtime</div>
            <div style={{ padding: '3px 10px', borderRadius: 6, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#ef4444', cursor: 'pointer' }}>Rollback</div>
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>4 services updated</div>
      </GP>
      {/* Service rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        {services.map((s, i) => (
          <GP key={i} style={{ padding: '8px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.statusColor, boxShadow: `0 0 6px ${s.statusColor}` }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', minWidth: 90 }}>{s.name}</span>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>{s.detail}</span>
              <span style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 4, background: `${s.statusColor}15`, fontFamily: M, fontSize: 9, fontWeight: 600, color: s.statusColor }}>{s.status === 'healthy' ? '\u2713 healthy' : '\u26A0 ' + s.status}</span>
            </div>
          </GP>
        ))}
      </div>
      {/* Previous releases */}
      <div style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.6)', marginBottom: 6 }}>Previous Releases</div>
      {previous.map((v, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: i < previous.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
          <span style={{ fontFamily: M, fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>{v}</span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{['3 days ago', '1 week ago', '2 weeks ago'][i]}</span>
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// AGENT CAPABILITY COMPARISON — 3-agent radar overlay
// ═══════════════════════════════════════════════════════════════
const ACC_AGENTS = [
  { name: 'WARDEN', color: '#10b981', scores: [95, 40, 80, 60, 30, 50] },
  { name: 'CIPHER', color: '#f59e0b', scores: [30, 90, 45, 70, 20, 85] },
  { name: 'VULCAN', color: '#3b82f6', scores: [20, 95, 30, 50, 40, 90] },
]
const ACC_AXES = ['Security', 'DevOps', 'Monitoring', 'Analysis', 'Communication', 'Automation']

export function AgentCapabilityComparison() {
  const f = useAnimFrame()
  const size = 350, cx = size / 2, cy = size / 2, maxR = size / 2 - 55
  const reveal = lerp(f, 0, 25, 0, 1)
  const n = ACC_AXES.length

  const angleFor = (i) => (i / n) * Math.PI * 2 - Math.PI / 2
  const ptFor = (i, val) => {
    const a = angleFor(i), r = (val / 100) * maxR * reveal
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }
  }

  // Find strongest agent per axis
  const strongest = ACC_AXES.map((_, ai) => {
    let best = 0, bestIdx = 0
    ACC_AGENTS.forEach((ag, idx) => { if (ag.scores[ai] > best) { best = ag.scores[ai]; bestIdx = idx } })
    return bestIdx
  })

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Capability Gap Analysis</div>
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size, flexShrink: 0 }}>
          {/* Grid rings */}
          {[25, 50, 75, 100].map((pct, i) => {
            const r = (pct / 100) * maxR
            const pts = Array.from({ length: n }, (_, j) => {
              const a = angleFor(j)
              return `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`
            }).join(' ')
            return <polygon key={i} points={pts} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={0.8} opacity={reveal} />
          })}
          {/* Axis lines */}
          {ACC_AXES.map((_, i) => {
            const a = angleFor(i), ex = cx + Math.cos(a) * maxR, ey = cy + Math.sin(a) * maxR
            return <line key={i} x1={cx} y1={cy} x2={ex} y2={ey} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} opacity={reveal} />
          })}
          {/* Agent polygons */}
          {ACC_AGENTS.map((agent, ai) => {
            const pts = Array.from({ length: n }, (_, j) => {
              const p = ptFor(j, agent.scores[j])
              return `${p.x},${p.y}`
            }).join(' ')
            return (
              <g key={ai}>
                <polygon points={pts} fill={agent.color} fillOpacity={0.08} stroke={agent.color} strokeWidth={1.5} strokeOpacity={0.5 * reveal} />
                {Array.from({ length: n }, (_, j) => {
                  const p = ptFor(j, agent.scores[j])
                  return <circle key={j} cx={p.x} cy={p.y} r={strongest[j] === ai ? 4 : 2.5} fill={agent.color} opacity={strongest[j] === ai ? 0.9 : 0.6} />
                })}
              </g>
            )
          })}
          {/* Axis labels */}
          {ACC_AXES.map((label, i) => {
            const a = angleFor(i), lx = cx + Math.cos(a) * (maxR + 28), ly = cy + Math.sin(a) * (maxR + 28)
            return <text key={i} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fill={ACC_AGENTS[strongest[i]].color} fontFamily={M} fontSize={9} fontWeight={600} opacity={reveal}>{label}</text>
          })}
        </svg>
        {/* Legend */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: lerp(f, 10, 25, 0, 1), minWidth: 120 }}>
          {ACC_AGENTS.map((a, i) => (
            <GP key={i} style={{ padding: '8px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: a.color, opacity: 0.8 }} />
                <span style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: a.color }}>{a.name}</span>
              </div>
              <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
                Avg: {Math.round(a.scores.reduce((s, v) => s + v, 0) / n)}
              </div>
            </GP>
          ))}
          <GP style={{ padding: '8px 12px', borderTopColor: 'rgba(48,255,144,0.3)' }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>STRONGEST PER AXIS</div>
            {ACC_AXES.map((ax, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 9, marginBottom: 2 }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>{ax}</span>
                <span style={{ color: ACC_AGENTS[strongest[i]].color, fontWeight: 600 }}>{ACC_AGENTS[strongest[i]].name}</span>
              </div>
            ))}
          </GP>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// TEAM CAPACITY GAUGE — Per-team utilization
// ═══════════════════════════════════════════════════════════════
const TCG_TEAMS = [
  { name: 'Platform Team', utilisation: 78, busy: 6, total: 8, objectives: 3, color: '#38bdf8', status: 'active' },
  { name: 'Security Team', utilisation: 45, busy: 2, total: 5, objectives: 1, color: '#10b981', status: 'normal' },
  { name: 'DevOps Team', utilisation: 92, busy: 4, total: 4, objectives: 5, color: '#ef4444', status: 'critical' },
  { name: 'Analytics Team', utilisation: 23, busy: 1, total: 4, objectives: 0, color: '#a855f7', status: 'idle' },
]

export function TeamCapacityGauge() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 20, 0, 1)
  const totalBusy = TCG_TEAMS.reduce((s, t) => s + t.busy, 0)
  const totalAll = TCG_TEAMS.reduce((s, t) => s + t.total, 0)

  const CircGauge = ({ pct, color, size = 64 }) => {
    const r = (size - 8) / 2, circ = 2 * Math.PI * r
    const animPct = pct * reveal
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={4} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - animPct / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`} opacity={0.8} />
        <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontFamily={M} fontSize={12} fontWeight={700}>{Math.round(animPct)}%</text>
      </svg>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, textTransform: 'uppercase' }}>Team Capacity</div>
        <div style={{ fontFamily: M, fontSize: 10, color: '#38bdf8' }}>{totalBusy}/{totalAll} agents active</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
        {TCG_TEAMS.map((team, i) => {
          const statusColor = team.status === 'critical' ? '#ef4444' : team.status === 'active' ? '#38bdf8' : team.status === 'idle' ? 'rgba(255,255,255,0.4)' : '#10b981'
          return (
            <GP key={i} style={{ padding: 12, opacity: lerp(f, i * 3, i * 3 + 10, 0, 1), borderTopColor: team.status === 'critical' ? 'rgba(239,68,68,0.3)' : undefined }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <CircGauge pct={team.utilisation} color={team.color} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, boxShadow: team.status === 'critical' ? `0 0 8px ${statusColor}` : 'none' }} />
                    <span style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: '#fff' }}>{team.name}</span>
                  </div>
                  <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 2 }}>
                    {team.busy}/{team.total} agents busy
                  </div>
                  <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>
                    {team.objectives} objective{team.objectives !== 1 ? 's' : ''} running
                  </div>
                </div>
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// MEMORY TYPE BREAKDOWN — Donut + legend
// ═══════════════════════════════════════════════════════════════
const MTB_SEGMENTS = [
  { type: 'Facts', pct: 35, color: '#06b6d4', count: 2886 },
  { type: 'Observations', pct: 18, color: '#10b981', count: 1484 },
  { type: 'Preferences', pct: 15, color: '#a855f7', count: 1237 },
  { type: 'Decisions', pct: 12, color: '#f59e0b', count: 990 },
  { type: 'Entities', pct: 10, color: '#ec4899', count: 825 },
  { type: 'Constraints', pct: 8, color: '#ef4444', count: 660 },
  { type: 'Errors', pct: 2, color: 'rgba(255,255,255,0.6)', count: 165 },
]

export function MemoryTypeBreakdown() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 25, 0, 1)
  const size = 200, cx = size / 2, cy = size / 2, r = 75, ir = 50

  let cumAngle = -Math.PI / 2
  const arcs = MTB_SEGMENTS.map(seg => {
    const startAngle = cumAngle
    const sweep = (seg.pct / 100) * Math.PI * 2 * reveal
    cumAngle += (seg.pct / 100) * Math.PI * 2
    const endAngle = startAngle + sweep
    const large = sweep > Math.PI ? 1 : 0
    const ox1 = cx + Math.cos(startAngle) * r, oy1 = cy + Math.sin(startAngle) * r
    const ox2 = cx + Math.cos(endAngle) * r, oy2 = cy + Math.sin(endAngle) * r
    const ix1 = cx + Math.cos(endAngle) * ir, iy1 = cy + Math.sin(endAngle) * ir
    const ix2 = cx + Math.cos(startAngle) * ir, iy2 = cy + Math.sin(startAngle) * ir
    const d = `M ${ox1} ${oy1} A ${r} ${r} 0 ${large} 1 ${ox2} ${oy2} L ${ix1} ${iy1} A ${ir} ${ir} 0 ${large} 0 ${ix2} ${iy2} Z`
    return { ...seg, d }
  })

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Memory Type Breakdown</div>
      <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
        {/* Donut */}
        <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
          <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }}>
            {arcs.map((arc, i) => (
              <path key={i} d={arc.d} fill={arc.color} fillOpacity={0.7} stroke="rgba(8,11,20,0.8)" strokeWidth={1.5} />
            ))}
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <span style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: '#fff' }}>8,247</span>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>memories</span>
          </div>
        </div>
        {/* Legend */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: lerp(f, 8, 25, 0, 1) }}>
          {MTB_SEGMENTS.map((seg, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: seg.color, opacity: 0.8 }} />
              <span style={{ fontFamily: F, fontSize: 11, color: '#fff', minWidth: 90 }}>{seg.type}</span>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>{seg.pct}%</span>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>{seg.count.toLocaleString()}</span>
            </div>
          ))}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8, marginTop: 4 }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 3 }}>
              Free tier: <span style={{ color: '#38bdf8', fontWeight: 600 }}>6,102 (74%)</span>
            </div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>
              Premium tier: <span style={{ color: '#a855f7', fontWeight: 600 }}>2,145 (26%)</span>
            </div>
          </div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
            Last 24h: <span style={{ color: '#10b981' }}>+127 new</span>, <span style={{ color: '#f59e0b' }}>-3 contradictions resolved</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// EVIDENCE QUALITY SCORE — Single record quality indicator
// ═══════════════════════════════════════════════════════════════
const EQS_CHECKS = [
  { label: 'All fields present', status: 'pass', color: '#10b981' },
  { label: 'Cryptographic hash verified', status: 'pass', color: '#10b981' },
  { label: 'Approval chain complete', status: 'pass', color: '#10b981' },
  { label: 'External timestamp pending', status: 'warn', color: '#f59e0b' },
  { label: 'WARD witness confirmed', status: 'pass', color: '#10b981' },
]

export function EvidenceQualityScore() {
  const f = useAnimFrame()
  const score = 94, size = 100, r = 40, circ = 2 * Math.PI * r
  const reveal = lerp(f, 0, 20, 0, 1)
  const [copied, setCopied] = useState(false)

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Evidence Quality Score</div>
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Score ring */}
        <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
          <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={6} />
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#10b981" strokeWidth={6} strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={circ * (1 - (score / 100) * reveal)}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} opacity={0.8} />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: M, fontSize: 22, fontWeight: 800, color: '#10b981' }}>{Math.round(score * reveal)}</span>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>/100</span>
          </div>
        </div>
        {/* Checks */}
        <div style={{ flex: 1, opacity: lerp(f, 5, 20, 0, 1) }}>
          {EQS_CHECKS.map((check, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: i < EQS_CHECKS.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
              <span style={{ fontFamily: M, fontSize: 12, color: check.color }}>{check.status === 'pass' ? '\u2713' : '\u26A0'}</span>
              <span style={{ fontFamily: F, fontSize: 11, color: '#fff', flex: 1 }}>{check.label}</span>
              <span style={{ fontFamily: M, fontSize: 9, color: check.color, fontWeight: 600 }}>{check.status === 'pass' ? 'PASS' : 'PENDING'}</span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>VOLT hash:</span>
            <span style={{ fontFamily: M, fontSize: 10, color: '#06b6d4' }}>8f3a2c...d71e</span>
            <div style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.2)', fontFamily: M, fontSize: 9, color: '#06b6d4', cursor: 'pointer', fontWeight: 600 }}
              onClick={() => { navigator.clipboard?.writeText('8f3a2cd71e'); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
              {copied ? '\u2713 Copied' : 'Copy'}
            </div>
          </div>
          <div style={{ display: 'inline-block', marginTop: 8, padding: '3px 12px', borderRadius: 6, background: 'linear-gradient(90deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05))', border: '1px solid rgba(245,158,11,0.3)', fontFamily: M, fontSize: 10, fontWeight: 700, color: '#f59e0b' }}>
            Gold Certification
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// AGENT MESH LATENCY — Inter-agent communication latency graph
// ═══════════════════════════════════════════════════════════════
const AML_AGENTS = [
  { id: 'commanderq', name: 'CommanderQ', color: '#38bdf8' },
  { id: 'sentinel', name: 'WARDEN', color: '#10b981' },
  { id: 'forge', name: 'VULCAN', color: '#a855f7' },
  { id: 'nova', name: 'DAEDALUS', color: '#14b8a6' },
  { id: 'cipher', name: 'CIPHER', color: '#f59e0b' },
  { id: 'atlas', name: 'HYPERION', color: '#ec4899' },
]
const AML_LINKS = [
  { from: 0, to: 1, ms: 8 }, { from: 0, to: 2, ms: 12 }, { from: 0, to: 3, ms: 15 },
  { from: 0, to: 4, ms: 11 }, { from: 0, to: 5, ms: 9 },
  { from: 1, to: 2, ms: 22 }, { from: 1, to: 5, ms: 18 },
  { from: 2, to: 3, ms: 35 }, { from: 3, to: 4, ms: 7 },
  { from: 4, to: 5, ms: 52 },
]

export function AgentMeshLatency() {
  const f = useAnimFrame()
  const size = 340, cx = size / 2, cy = size / 2, r = 110
  const reveal = lerp(f, 0, 20, 0, 1)
  const pulse = 0.6 + Math.sin(f * 0.06) * 0.3

  // Position agents: centre + hexagonal ring
  const positions = AML_AGENTS.map((a, i) => {
    if (i === 0) return { ...a, x: cx, y: cy }
    const angle = ((i - 1) / (AML_AGENTS.length - 1)) * Math.PI * 2 - Math.PI / 2
    return { ...a, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
  })

  const latColor = (ms) => ms < 10 ? '#10b981' : ms < 50 ? '#f59e0b' : '#ef4444'
  const avgMs = Math.round(AML_LINKS.reduce((s, l) => s + l.ms, 0) / AML_LINKS.length)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, textTransform: 'uppercase' }}>Agent Mesh Latency</div>
        <div style={{ padding: '3px 10px', borderRadius: 6, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', fontFamily: M, fontSize: 10, fontWeight: 600, color: '#10b981' }}>
          {avgMs}ms avg
        </div>
      </div>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }}>
        {/* Links */}
        {AML_LINKS.map((link, i) => {
          const a = positions[link.from], b = positions[link.to]
          const lc = latColor(link.ms)
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
          const linkOp = lerp(f, 5 + i * 2, 15 + i * 2, 0, 1)
          // Animated packet
          const packetT = ((f * 0.02 + i * 0.3) % 1)
          const px = a.x + (b.x - a.x) * packetT, py = a.y + (b.y - a.y) * packetT
          return (
            <g key={i} opacity={linkOp}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={lc} strokeWidth={1} strokeOpacity={0.3} />
              <circle cx={px} cy={py} r={2} fill={lc} opacity={pulse} />
              <text x={mx} y={my - 5} textAnchor="middle" fill={lc} fontFamily={M} fontSize={8} fontWeight={600}>{link.ms}ms</text>
            </g>
          )
        })}
        {/* Nodes */}
        {positions.map((a, i) => (
          <g key={i} opacity={reveal}>
            <circle cx={a.x} cy={a.y} r={i === 0 ? 18 : 14} fill={`${a.color}18`} stroke={a.color} strokeWidth={1.5} />
            <text x={a.x} y={a.y + 1} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontFamily={M} fontSize={i === 0 ? 7 : 6} fontWeight={700}>
              {i === 0 ? 'CmdQ' : a.name.slice(0, 4)}
            </text>
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontFamily: M, fontSize: 9 }}>
        <span style={{ color: '#10b981' }}>{'\u25CF'} {'<10ms'}</span>
        <span style={{ color: '#f59e0b' }}>{'\u25CF'} 10-50ms</span>
        <span style={{ color: '#ef4444' }}>{'\u25CF'} {'>50ms'}</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ERROR PROPAGATION TREE — Error cascade visualization
// ═══════════════════════════════════════════════════════════════
const EPT_NODES = [
  { id: 0, label: 'OOM Kill \u2014 edge-03 sshd', level: 0, color: '#ef4444', time: '12:34:01', x: 300, y: 30 },
  { id: 1, label: 'SSH connection refused \u2014 WARDEN scan', level: 1, color: '#f59e0b', time: '12:34:08', x: 120, y: 110 },
  { id: 2, label: 'Task timeout \u2014 objective obj-7a3f task-3', level: 1, color: '#f59e0b', time: '12:34:15', x: 300, y: 110 },
  { id: 3, label: 'Heartbeat lost \u2014 edge-03 agent', level: 1, color: '#ef4444', time: '12:34:22', x: 500, y: 110 },
  { id: 4, label: 'Objective partial failure \u2014 obj-7a3f', level: 2, color: '#f59e0b', time: '12:34:35', x: 220, y: 190 },
  { id: 5, label: 'Circuit breaker triggered \u2014 edge-03 tasks', level: 2, color: '#f59e0b', time: '12:34:47', x: 420, y: 190 },
]
const EPT_EDGES = [
  { from: 0, to: 1 }, { from: 0, to: 2 }, { from: 0, to: 3 },
  { from: 2, to: 4 }, { from: 2, to: 5 },
]

export function ErrorPropagationTree() {
  const f = useAnimFrame()
  const w = 620, h = 280
  const reveal = lerp(f, 0, 25, 0, 1)

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Error Propagation Tree</div>
      <div style={{ position: 'relative', width: w, height: h }}>
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }}>
          {EPT_EDGES.map((edge, i) => {
            const from = EPT_NODES[edge.from], to = EPT_NODES[edge.to]
            const op = lerp(f, 5 + i * 4, 15 + i * 4, 0, 1)
            return (
              <g key={i} opacity={op}>
                <line x1={from.x} y1={from.y + 20} x2={to.x} y2={to.y - 5} stroke={to.color} strokeWidth={1.5} strokeOpacity={0.4} strokeDasharray="4 3" />
                <polygon points={`${to.x},${to.y - 5} ${to.x - 3},${to.y - 10} ${to.x + 3},${to.y - 10}`} fill={to.color} opacity={0.6} />
              </g>
            )
          })}
        </svg>
        {EPT_NODES.map((node, i) => {
          const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
          return (
            <div key={i} style={{
              position: 'absolute', left: node.x, top: node.y, transform: 'translate(-50%, 0)',
              opacity: op, maxWidth: 180
            }}>
              <GP style={{ padding: '6px 10px', borderTopColor: `${node.color}40` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: node.color, boxShadow: `0 0 6px ${node.color}` }} />
                  <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>{node.time}</span>
                </div>
                <div style={{ fontFamily: F, fontSize: 10, color: '#fff', lineHeight: 1.3 }}>{node.label}</div>
              </GP>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, opacity: lerp(f, 15, 25, 0, 1) }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>
          Timeline: <span style={{ color: '#fff' }}>12:34:01 {'\u2192'} 12:34:47</span> <span style={{ color: '#f59e0b' }}>(46s cascade)</span>
        </div>
        <div style={{ padding: '3px 10px', borderRadius: 6, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#ef4444' }}>
          Root Cause: Memory pressure (92% {'\u2192'} OOM)
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// PLUGIN DEPENDENCY RESOLVER — Installation dependency tree
// ═══════════════════════════════════════════════════════════════
const PDR_REQUIRED = [
  { name: 'YouTube Connector', installed: true, cost: 0 },
  { name: 'LinkedIn Connector', installed: true, cost: 0 },
  { name: 'Google Ads Connector', installed: false, cost: 8 },
  { name: 'Anthropic API Key', installed: true, cost: 0, isConfig: true },
]
const PDR_OPTIONAL = [
  { name: 'HubSpot Connector', installed: false, cost: 12, recommended: true },
]

export function PluginDependencyResolver() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 20, 0, 1)

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Plugin Dependency Resolver</div>
      <GP style={{ padding: 14, marginBottom: 10, borderTopColor: 'rgba(56,189,248,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: '#fff' }}>Marketing Intelligence Bundle</div>
            <div style={{ fontFamily: M, fontSize: 11, color: '#38bdf8', marginTop: 2 }}>$99/mo</div>
          </div>
          <div style={{ padding: '4px 12px', borderRadius: 6, background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.3)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#a855f7' }}>
            Premium Plugin
          </div>
        </div>
      </GP>
      {/* Required */}
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 6, letterSpacing: 1 }}>REQUIRED DEPENDENCIES</div>
      {PDR_REQUIRED.map((dep, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <span style={{ fontFamily: M, fontSize: 12, color: dep.installed ? '#10b981' : '#ef4444' }}>
            {dep.installed ? '\u2713' : '\u2717'}
          </span>
          <span style={{ fontFamily: F, fontSize: 12, color: '#fff', flex: 1 }}>{dep.name}</span>
          <span style={{ fontFamily: M, fontSize: 10, color: dep.installed ? 'rgba(255,255,255,0.6)' : '#f59e0b' }}>
            {dep.installed ? (dep.isConfig ? 'configured' : 'installed') : `$${dep.cost}/mo`}
          </span>
        </div>
      ))}
      {/* Optional */}
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginTop: 12, marginBottom: 6, letterSpacing: 1 }}>OPTIONAL DEPENDENCIES</div>
      {PDR_OPTIONAL.map((dep, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
          <span style={{ fontFamily: M, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{'\u25CB'}</span>
          <span style={{ fontFamily: F, fontSize: 12, color: '#fff', flex: 1 }}>{dep.name}</span>
          {dep.recommended && <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.1)', fontFamily: M, fontSize: 8, color: '#10b981', fontWeight: 600 }}>recommended</span>}
          <span style={{ fontFamily: M, fontSize: 10, color: '#f59e0b' }}>${dep.cost}/mo</span>
        </div>
      ))}
      {/* Summary */}
      <GP style={{ padding: 12, marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>Total cost</span>
          <span style={{ fontFamily: M, fontSize: 14, fontWeight: 800, color: '#fff' }}>$99 + $8 = $107/mo</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ padding: '5px 16px', borderRadius: 8, background: 'linear-gradient(90deg, rgba(56,189,248,0.15), rgba(168,85,247,0.1))', border: '1px solid rgba(56,189,248,0.3)', fontFamily: F, fontSize: 12, fontWeight: 600, color: '#38bdf8', cursor: 'pointer' }}>
            Install with dependencies
          </div>
          <span style={{ fontFamily: M, fontSize: 10, color: '#10b981' }}>{'\u2713'} No conflicts detected</span>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// WORKFLOW SIMULATOR — Workflow execution simulator
// ═══════════════════════════════════════════════════════════════
const WFS_NODES = [
  { label: 'Trigger', icon: '\u26A1', status: 'done', color: '#10b981' },
  { label: 'Transform', icon: '\u2699', status: 'done', color: '#10b981' },
  { label: 'Decision', icon: '\u25C6', status: 'active', color: '#38bdf8' },
  { label: 'Action', icon: '\u25B6', status: 'pending', color: 'rgba(255,255,255,0.3)' },
]

export function WorkflowSimulator() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 15, 0, 1)
  const pulse = 0.6 + Math.sin(f * 0.1) * 0.4

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Workflow Simulator</div>
      {/* Flow nodes */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 16, justifyContent: 'center' }}>
        {WFS_NODES.map((node, i) => {
          const isActive = node.status === 'active'
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
              <GP style={{
                padding: '12px 18px', textAlign: 'center', minWidth: 100,
                borderTopColor: isActive ? 'rgba(56,189,248,0.5)' : node.status === 'done' ? 'rgba(16,185,129,0.3)' : undefined,
                boxShadow: isActive ? `0 0 20px rgba(56,189,248,${pulse * 0.15}), 0 5px 19px rgba(0,0,0,0.35)` : undefined,
              }}>
                <div style={{ fontSize: 20, marginBottom: 4, opacity: node.status === 'pending' ? 0.3 : 0.8 }}>{node.icon}</div>
                <div style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: isActive ? '#38bdf8' : node.status === 'done' ? '#10b981' : 'rgba(255,255,255,0.4)' }}>{node.label}</div>
                {isActive && <div style={{ fontFamily: M, fontSize: 8, color: '#38bdf8', marginTop: 4, opacity: pulse }}>PROCESSING</div>}
              </GP>
              {i < WFS_NODES.length - 1 && (
                <div style={{ width: 30, height: 2, background: i < 2 ? '#10b981' : i === 2 ? '#38bdf8' : 'rgba(255,255,255,0.1)', margin: '0 -1px', opacity: 0.5 }} />
              )}
            </div>
          )
        })}
      </div>
      {/* Detail panels */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <GP style={{ padding: 12 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 6 }}>INPUT</div>
          <div style={{ fontFamily: F, fontSize: 11, color: '#fff', marginBottom: 4 }}>Trigger: webhook received</div>
          <div style={{ fontFamily: M, fontSize: 9, color: '#06b6d4', background: 'rgba(6,182,212,0.06)', padding: '4px 8px', borderRadius: 4 }}>
            {'{'} "event": "deploy", "repo": "quox-api" {'}'}
          </div>
        </GP>
        <GP style={{ padding: 12 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 6 }}>DECISION OUTCOME</div>
          <div style={{ fontFamily: F, fontSize: 11, color: '#fff', marginBottom: 4 }}>
            Route to <span style={{ color: '#10b981', fontWeight: 600 }}>WARDEN</span> (score: 87)
          </div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Execution path highlighted</div>
        </GP>
      </div>
      {/* Bottom stats */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <GP style={{ padding: '6px 12px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>What-if:</span>
          <span style={{ fontFamily: M, fontSize: 9, color: '#f59e0b' }}>Skip decision {'\u2192'} direct action</span>
        </GP>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>
          Simulated <span style={{ color: '#fff' }}>3</span> paths, <span style={{ color: '#10b981' }}>2 successful</span>, <span style={{ color: '#f59e0b' }}>1 escalation</span>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// DOCUMENT CLUSTER — Semantic document clustering scatter
// ═══════════════════════════════════════════════════════════════
const DC_CLUSTERS = [
  { name: 'Infrastructure', color: '#06b6d4', docs: [
    { name: 'docker-setup.md', x: 80, y: 60 }, { name: 'nginx-config.md', x: 95, y: 85 },
    { name: 'k8s-deploy.md', x: 70, y: 95 }, { name: 'ssh-bastion.md', x: 110, y: 70 },
    { name: 'compose-ref.md', x: 85, y: 110 },
  ]},
  { name: 'Security', color: '#ef4444', docs: [
    { name: 'access-policy.md', x: 260, y: 70 }, { name: 'audit-rules.md', x: 280, y: 95 },
    { name: 'firewall-conf.md', x: 250, y: 110 }, { name: 'cert-mgmt.md', x: 290, y: 65 },
  ]},
  { name: 'API Docs', color: '#a855f7', docs: [
    { name: 'rest-api.md', x: 170, y: 200 }, { name: 'webhook-spec.md', x: 195, y: 220 },
    { name: 'graphql-schema.md', x: 150, y: 230 }, { name: 'auth-flow.md', x: 185, y: 245 },
    { name: 'rate-limits.md', x: 210, y: 210 }, { name: 'error-codes.md', x: 165, y: 260 },
  ]},
]

export function DocumentCluster() {
  const f = useAnimFrame()
  const w = 400, h = 300
  const reveal = lerp(f, 0, 20, 0, 1)
  const searchGlow = 0.5 + Math.sin(f * 0.08) * 0.3

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Document Cluster Map</div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <svg viewBox={`0 0 ${w} ${h}`} style={{ width: w, height: h, flexShrink: 0 }}>
          {/* Cluster hulls */}
          {DC_CLUSTERS.map((cl, ci) => {
            const pts = cl.docs.map(d => d)
            const minX = Math.min(...pts.map(p => p.x)) - 20, maxX = Math.max(...pts.map(p => p.x)) + 20
            const minY = Math.min(...pts.map(p => p.y)) - 20, maxY = Math.max(...pts.map(p => p.y)) + 20
            const ccx = (minX + maxX) / 2, ccy = (minY + maxY) / 2
            const rx = (maxX - minX) / 2 + 5, ry = (maxY - minY) / 2 + 5
            return (
              <g key={ci} opacity={reveal}>
                <ellipse cx={ccx} cy={ccy} rx={rx} ry={ry} fill={cl.color} fillOpacity={0.04} stroke={cl.color} strokeWidth={1} strokeOpacity={0.15} strokeDasharray="4 3" />
                <text x={ccx} y={minY - 8} textAnchor="middle" fill={cl.color} fontFamily={M} fontSize={9} fontWeight={600} opacity={0.8}>{cl.name}</text>
              </g>
            )
          })}
          {/* Dots */}
          {DC_CLUSTERS.map((cl, ci) => cl.docs.map((doc, di) => {
            const isDocker = doc.name.includes('docker')
            const dotOp = lerp(f, 5 + ci * 4 + di * 2, 15 + ci * 4 + di * 2, 0, 1)
            return (
              <g key={`${ci}-${di}`} opacity={dotOp}>
                {isDocker && <circle cx={doc.x} cy={doc.y} r={10} fill={cl.color} fillOpacity={searchGlow * 0.15} />}
                <circle cx={doc.x} cy={doc.y} r={isDocker ? 5 : 3.5} fill={cl.color} fillOpacity={isDocker ? 0.9 : 0.6} />
                <text x={doc.x + 8} y={doc.y + 3} fill="rgba(255,255,255,0.7)" fontFamily={M} fontSize={7}>{doc.name}</text>
              </g>
            )
          }))}
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: lerp(f, 10, 25, 0, 1), minWidth: 140 }}>
          <GP style={{ padding: '8px 12px' }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>SEARCH QUERY</div>
            <div style={{ fontFamily: M, fontSize: 11, color: '#06b6d4', fontWeight: 600 }}>"docker"</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 3 }}>2 matches highlighted</div>
          </GP>
          <GP style={{ padding: '8px 12px' }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 6 }}>CLUSTER STATS</div>
            {DC_CLUSTERS.map((cl, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: cl.color, opacity: 0.7 }} />
                <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{cl.name}</span>
                <span style={{ fontFamily: M, fontSize: 9, color: cl.color }}>{cl.docs.length}</span>
              </div>
            ))}
          </GP>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', lineHeight: 1.6 }}>
            847 documents<br />3 clusters<br />94% classified
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// USER JOURNEY MAP — Onboarding funnel
// ═══════════════════════════════════════════════════════════════
const UJM_STAGES = [
  { label: 'Sign Up', count: 1000, pct: 100 },
  { label: 'Create Org', count: 847, pct: 84.7 },
  { label: 'Deploy Agent', count: 623, pct: 62.3 },
  { label: 'First Objective', count: 412, pct: 41.2 },
  { label: 'Paid Conversion', count: 89, pct: 8.9 },
]

export function UserJourneyMap() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 20, 0, 1)
  const maxW = 450
  const colors = ['#38bdf8', '#06b6d4', '#10b981', '#a855f7', '#30ff90']

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 12, textTransform: 'uppercase' }}>User Journey Map</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {UJM_STAGES.map((stage, i) => {
          const barW = (stage.pct / 100) * maxW * reveal
          const dropoff = i > 0 ? UJM_STAGES[i - 1].count - stage.count : 0
          const dropPct = i > 0 ? ((dropoff / UJM_STAGES[i - 1].count) * 100).toFixed(1) : 0
          const op = lerp(f, i * 3, i * 3 + 10, 0, 1)
          return (
            <div key={i} style={{ opacity: op }}>
              {i > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0 2px 20', fontFamily: M, fontSize: 8, color: '#ef4444' }}>
                  {'\u25BC'} -{dropoff} ({dropPct}% drop-off)
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontFamily: F, fontSize: 11, color: '#fff', minWidth: 110, fontWeight: 500 }}>{stage.label}</span>
                <div style={{ position: 'relative', flex: 1, height: 24, maxWidth: maxW }}>
                  <div style={{ position: 'absolute', inset: 0, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }} />
                  <div style={{
                    position: 'absolute', left: 0, top: 0, height: '100%', width: barW, borderRadius: 6,
                    background: `linear-gradient(90deg, ${colors[i]}40, ${colors[i]}80)`,
                    borderRight: `2px solid ${colors[i]}`,
                  }} />
                  <div style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontFamily: M, fontSize: 10, color: '#fff', fontWeight: 600 }}>
                    {stage.count.toLocaleString()}
                  </div>
                </div>
                <span style={{ fontFamily: M, fontSize: 10, color: colors[i], fontWeight: 600, minWidth: 40 }}>{stage.pct}%</span>
              </div>
            </div>
          )
        })}
      </div>
      {/* Summary */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, opacity: lerp(f, 15, 25, 0, 1) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: M, fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>Conversion rate:</span>
          <span style={{ fontFamily: M, fontSize: 14, fontWeight: 800, color: '#30ff90' }}>8.9%</span>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>free{'\u2192'}paid</span>
          <span style={{ fontFamily: M, fontSize: 10, color: '#10b981' }}>{'\u25B2'} +1.2%</span>
        </div>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>
          Avg time to first objective: <span style={{ color: '#38bdf8', fontWeight: 600 }}>4.2 hours</span>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// LIVE TELEMETRY — Real-time system telemetry dashboard
// ═══════════════════════════════════════════════════════════════
export function LiveTelemetry() {
  const f = useAnimFrame()
  const pulse = 0.6 + Math.sin(f * 0.08) * 0.4
  const channels = [
    { label: 'API Throughput', value: 142, unit: 'req/s', color: '#10b981', baseData: [120, 135, 128, 142, 138, 145, 132, 148, 140, 142, 137, 150, 143, 139, 142] },
    { label: 'Memory Pressure', value: 67, unit: '%', color: '#06b6d4', baseData: [62, 65, 64, 67, 66, 68, 63, 69, 67, 65, 68, 66, 67, 64, 67] },
    { label: 'Error Rate', value: 0.3, unit: '%', color: '#10b981', baseData: [0.2, 0.3, 0.1, 0.4, 0.2, 0.3, 0.5, 0.2, 0.1, 0.3, 0.4, 0.2, 0.3, 0.1, 0.3] },
  ]

  const uptimeDays = 14, uptimeHours = 7, uptimeMinutes = 23

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, textTransform: 'uppercase' }}>Live Telemetry</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', boxShadow: `0 0 ${8 + pulse * 4}px #10b981`, opacity: pulse }} />
          <span style={{ fontFamily: M, fontSize: 9, color: '#10b981' }}>LIVE</span>
        </div>
      </div>
      {channels.map((ch, ci) => {
        const data = ch.baseData.map((v, i) => v + Math.sin(f * 0.05 + i * 0.5 + ci) * (ch.unit === '%' && ch.value < 1 ? 0.1 : ch.unit === '%' ? 3 : 8))
        const max = Math.max(...data) * 1.2, min = Math.min(...data) * 0.8
        const sparkW = 200, sparkH = 30
        const pts = data.map((v, i) => `${(i / (data.length - 1)) * sparkW},${sparkH - ((v - min) / (max - min)) * sparkH}`).join(' ')
        const errColor = ch.unit === '%' && ch.value < 1 ? (data[data.length - 1] > 1 ? '#ef4444' : '#10b981') : ch.color
        return (
          <GP key={ci} style={{ padding: '8px 14px', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 120 }}>
                <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>{ch.label}</div>
                <div style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: errColor }}>{ch.unit === '%' && ch.value < 1 ? data[data.length - 1].toFixed(1) : Math.round(data[data.length - 1])}<span style={{ fontSize: 10, fontWeight: 400, opacity: 0.7 }}> {ch.unit}</span></div>
              </div>
              <svg viewBox={`0 0 ${sparkW} ${sparkH}`} style={{ flex: 1, height: sparkH }}>
                <polyline points={pts} fill="none" stroke={errColor} strokeWidth={1.5} strokeLinejoin="round" opacity={0.8} />
                <polyline points={`0,${sparkH} ${pts} ${sparkW},${sparkH}`} fill={errColor} fillOpacity={0.06} stroke="none" />
              </svg>
            </div>
          </GP>
        )
      })}
      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
          Uptime: <span style={{ color: '#10b981', fontWeight: 600 }}>{uptimeDays}d {uptimeHours}h {uptimeMinutes}m</span>
        </div>
        <div style={{ padding: '3px 10px', borderRadius: 6, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#10b981' }}>
          Last incident: 3 days ago
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// COST ANALYTICS — Token/cost breakdown
// ═══════════════════════════════════════════════════════════════
const CA_AGENTS = [
  { name: 'CommanderQ', cost: 42.18, pct: 33, color: '#38bdf8' },
  { name: 'WARDEN', cost: 28.91, pct: 23, color: '#10b981' },
  { name: 'VULCAN', cost: 19.44, pct: 15, color: '#a855f7' },
  { name: 'DAEDALUS', cost: 15.22, pct: 12, color: '#14b8a6' },
  { name: 'Others', cost: 21.68, pct: 17, color: 'rgba(255,255,255,0.4)' },
]

export function CostAnalytics() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 20, 0, 1)
  const total = 127.43, budget = 200, dailyAvg = (total / 25).toFixed(2)
  const budgetPct = (total / budget) * 100
  const projection = 184
  const budgetR = 38, budgetCirc = 2 * Math.PI * budgetR

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Cost Analytics</div>
      {/* Header */}
      <GP style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>Total spend this month</div>
            <div style={{ fontFamily: M, fontSize: 28, fontWeight: 800, color: '#fff' }}>${total}</div>
            <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>Daily avg: ${dailyAvg}</div>
          </div>
          {/* Budget gauge */}
          <div style={{ position: 'relative', width: 86, height: 86 }}>
            <svg viewBox="0 0 86 86" style={{ width: 86, height: 86 }}>
              <circle cx={43} cy={43} r={budgetR} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={5} />
              <circle cx={43} cy={43} r={budgetR} fill="none" stroke={budgetPct > 80 ? '#f59e0b' : '#10b981'} strokeWidth={5} strokeLinecap="round"
                strokeDasharray={budgetCirc} strokeDashoffset={budgetCirc * (1 - (budgetPct / 100) * reveal)}
                transform="rotate(-90 43 43)" opacity={0.8} />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontFamily: M, fontSize: 14, fontWeight: 800, color: '#fff' }}>{Math.round(budgetPct * reveal)}%</span>
              <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>of $200</span>
            </div>
          </div>
        </div>
      </GP>
      {/* Agent costs — horizontal bars */}
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 6, letterSpacing: 1 }}>COST PER AGENT</div>
      {CA_AGENTS.map((agent, i) => {
        const barW = agent.pct * reveal
        const op = lerp(f, i * 3, i * 3 + 10, 0, 1)
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, opacity: op }}>
            <span style={{ fontFamily: M, fontSize: 10, color: '#fff', minWidth: 90, fontWeight: 500 }}>{agent.name}</span>
            <div style={{ flex: 1, height: 10, borderRadius: 5, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
              <div style={{ width: `${barW}%`, height: '100%', borderRadius: 5, background: `linear-gradient(90deg, ${agent.color}60, ${agent.color})` }} />
            </div>
            <span style={{ fontFamily: M, fontSize: 10, color: agent.color, fontWeight: 600, minWidth: 55, textAlign: 'right' }}>${agent.cost}</span>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', minWidth: 30 }}>{agent.pct}%</span>
          </div>
        )
      })}
      {/* Model breakdown + Projection */}
      <div style={{ display: 'flex', gap: 10, marginTop: 12, opacity: lerp(f, 10, 25, 0, 1) }}>
        <GP style={{ padding: '8px 12px', flex: 1 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>MODEL BREAKDOWN</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 10, marginBottom: 2 }}>
            <span style={{ color: '#fff' }}>Claude Opus</span>
            <span style={{ color: '#a855f7' }}>$89.20</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 10 }}>
            <span style={{ color: '#fff' }}>Claude Sonnet</span>
            <span style={{ color: '#38bdf8' }}>$38.23</span>
          </div>
        </GP>
        <GP style={{ padding: '8px 12px', flex: 1 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>PROJECTION</div>
          <div style={{ fontFamily: M, fontSize: 16, fontWeight: 800, color: projection <= budget ? '#10b981' : '#f59e0b' }}>
            ${projection}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Est. month-end</span>
            <span style={{ padding: '1px 6px', borderRadius: 4, background: projection <= budget ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)', fontFamily: M, fontSize: 8, fontWeight: 600, color: projection <= budget ? '#10b981' : '#f59e0b' }}>
              {projection <= budget ? 'Under budget' : 'Over budget'}
            </span>
          </div>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// AGENTIC TEAMS — 1. TEAM TOPOLOGY CARD
// ═══════════════════════════════════════════════════════════════
const TTC_TOPOS = [
  { id: 'star', name: 'Star', best: 'Small tasks, fast delegation', agents: 5, active: true, color: '#a855f7' },
  { id: 'hierarchical', name: 'Hierarchical', best: 'Large objectives, 3-tier control', agents: 9, active: false, color: '#38bdf8' },
  { id: 'pipeline', name: 'Pipeline', best: 'CI/CD, sequential processing', agents: 4, active: false, color: '#10b981' },
  { id: 'mesh', name: 'Mesh', best: 'Research, collaborative discovery', agents: 4, active: false, color: '#06b6d4' },
]

function TopoMiniSVG({ type, color, active }) {
  const op = active ? 0.9 : 0.5
  const glow = active ? `0 0 8px ${color}66` : 'none'
  const c = 30, r = 22, nr = 3, cr = active ? 5 : 4
  if (type === 'star') {
    const pts = Array.from({ length: 4 }, (_, i) => { const a = (i / 4) * Math.PI * 2 - Math.PI / 2; return { x: c + Math.cos(a) * r, y: c + Math.sin(a) * r } })
    return <svg viewBox="0 0 60 60" style={{ width: 60, height: 60, filter: active ? `drop-shadow(0 0 4px ${color}44)` : 'none' }}>
      {pts.map((p, i) => <line key={i} x1={c} y1={c} x2={p.x} y2={p.y} stroke={color} strokeWidth={1} opacity={op * 0.5} />)}
      {pts.map((p, i) => <circle key={`n${i}`} cx={p.x} cy={p.y} r={nr} fill={color} opacity={op} />)}
      <circle cx={c} cy={c} r={cr} fill={color} opacity={op} />
      <text x={c} y={c + 2} textAnchor="middle" fill="#fff" fontSize={5} fontWeight={700} opacity={op}>CQ</text>
    </svg>
  }
  if (type === 'hierarchical') {
    const chief = { x: c, y: 10 }, mgrs = [{ x: 14, y: 28 }, { x: 46, y: 28 }], workers = [{ x: 6, y: 48 }, { x: 22, y: 48 }, { x: 38, y: 48 }, { x: 54, y: 48 }]
    return <svg viewBox="0 0 60 60" style={{ width: 60, height: 60, filter: active ? `drop-shadow(0 0 4px ${color}44)` : 'none' }}>
      {mgrs.map((m, i) => <line key={`cm${i}`} x1={chief.x} y1={chief.y} x2={m.x} y2={m.y} stroke={color} strokeWidth={1} opacity={op * 0.5} />)}
      {workers.slice(0, 2).map((w, i) => <line key={`m0w${i}`} x1={mgrs[0].x} y1={mgrs[0].y} x2={w.x} y2={w.y} stroke={color} strokeWidth={1} opacity={op * 0.5} />)}
      {workers.slice(2).map((w, i) => <line key={`m1w${i}`} x1={mgrs[1].x} y1={mgrs[1].y} x2={w.x} y2={w.y} stroke={color} strokeWidth={1} opacity={op * 0.5} />)}
      <circle cx={chief.x} cy={chief.y} r={cr} fill={color} opacity={op} />
      {mgrs.map((m, i) => <circle key={i} cx={m.x} cy={m.y} r={nr} fill={color} opacity={op} />)}
      {workers.map((w, i) => <circle key={i} cx={w.x} cy={w.y} r={nr - 0.5} fill={color} opacity={op * 0.7} />)}
    </svg>
  }
  if (type === 'pipeline') {
    const nodes = [{ x: 8, y: c }, { x: 24, y: c }, { x: 40, y: c }, { x: 52, y: c }]
    return <svg viewBox="0 0 60 60" style={{ width: 60, height: 60, filter: active ? `drop-shadow(0 0 4px ${color}44)` : 'none' }}>
      {nodes.slice(0, -1).map((n, i) => <line key={i} x1={n.x + 3} y1={n.y} x2={nodes[i + 1].x - 3} y2={nodes[i + 1].y} stroke={color} strokeWidth={1.5} opacity={op * 0.6} />)}
      {nodes.slice(0, -1).map((n, i) => <polygon key={`a${i}`} points={`${nodes[i + 1].x - 5},${n.y - 2} ${nodes[i + 1].x - 5},${n.y + 2} ${nodes[i + 1].x - 2},${n.y}`} fill={color} opacity={op * 0.6} />)}
      {nodes.map((n, i) => <circle key={i} cx={n.x} cy={n.y} r={nr} fill={color} opacity={op} />)}
    </svg>
  }
  // mesh
  const pts = [{ x: 14, y: 14 }, { x: 46, y: 14 }, { x: 14, y: 46 }, { x: 46, y: 46 }]
  return <svg viewBox="0 0 60 60" style={{ width: 60, height: 60, filter: active ? `drop-shadow(0 0 4px ${color}44)` : 'none' }}>
    {pts.map((a, i) => pts.slice(i + 1).map((b, j) => <line key={`${i}-${j}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={0.8} opacity={op * 0.4} />))}
    {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={nr} fill={color} opacity={op} />)}
  </svg>
}

export function TeamTopologyCard() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.08) * 0.3
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8 }}>TEAM TOPOLOGY SELECTOR</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {TTC_TOPOS.map((t, i) => {
          const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
          return (
            <GP key={t.id} style={{ padding: '12px 14px', opacity: op, ...(t.active ? { borderTopColor: `${t.color}50`, boxShadow: `0 0 ${12 * pulse}px ${t.color}22, 0 5px 19px rgba(0,0,0,0.35), inset 0 1px 2px rgba(255,255,255,0.08)` } : {}) }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <TopoMiniSVG type={t.id} color={t.color} active={t.active} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: t.active ? t.color : '#fff' }}>{t.name}</span>
                    {t.active && <span style={{ padding: '1px 6px', borderRadius: 4, background: `${t.color}18`, fontFamily: M, fontSize: 8, fontWeight: 600, color: t.color }}>ACTIVE</span>}
                  </div>
                  <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4, marginBottom: 4 }}>{t.best}</div>
                  <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{t.agents} agents</div>
                </div>
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// AGENTIC TEAMS — 2. TEAM RUN DASHBOARD
// ═══════════════════════════════════════════════════════════════
const TRD_WORKERS = [
  { name: 'WARDEN', task: 'Port scan edge-01-04', pct: 67, status: 'working', color: '#f59e0b' },
  { name: 'SCOUT', task: 'Check SSL certs', pct: 100, status: 'done', color: '#10b981' },
  { name: 'NETWATCH', task: 'DNS resolution test', pct: 45, status: 'working', color: '#ec4899' },
  { name: 'CIPHER', task: 'Waiting for WARDEN results', pct: 0, status: 'waiting', color: '#6366f1' },
]
const TRD_HANDOFFS = [
  { ts: '14:30:04', from: 'SENTINEL', to: 'WARDEN', msg: 'Delegated port scan across docker fleet' },
  { ts: '14:30:05', from: 'SENTINEL', to: 'SCOUT', msg: 'Delegated SSL certificate verification' },
  { ts: '14:30:06', from: 'SENTINEL', to: 'NETWATCH', msg: 'Delegated DNS resolution checks' },
]
const TRD_STATUS_COLORS = { working: '#38bdf8', done: '#10b981', waiting: 'rgba(255,255,255,0.4)', failed: '#ef4444' }

export function TeamRunDashboard() {
  const f = useAnimFrame()
  const chiefPulse = 0.6 + Math.sin(f * 0.1) * 0.4
  const reveal = lerp(f, 0, 15, 0, 1)
  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, opacity: reveal }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Team: Security Patrol</span>
          <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(168,85,247,0.12)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#a855f7' }}>Star</span>
          <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(56,189,248,0.12)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#38bdf8' }}>RUNNING</span>
        </div>
        <span style={{ fontFamily: M, fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>4m 23s</span>
      </div>
      {/* Chief */}
      <GP style={{ padding: '10px 14px', marginBottom: 10, borderTopColor: 'rgba(239,68,68,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', opacity: chiefPulse, boxShadow: `0 0 8px rgba(239,68,68,${chiefPulse * 0.5})` }} />
          <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: '#ef4444' }}>SENTINEL</span>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>Chief — Orchestrating</span>
          <span style={{ marginLeft: 'auto', fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>4 tasks delegated</span>
        </div>
      </GP>
      {/* Workers */}
      {TRD_WORKERS.map((w, i) => {
        const op = lerp(f, 5 + i * 3, 12 + i * 3, 0, 1)
        const barW = w.pct * lerp(f, 8 + i * 3, 20 + i * 3, 0, 1)
        const sc = TRD_STATUS_COLORS[w.status]
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < TRD_WORKERS.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', opacity: op }}>
            <span style={{ fontFamily: M, fontSize: 11, fontWeight: 600, color: w.color, minWidth: 80 }}>{w.name}</span>
            <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.task}</span>
            <div style={{ width: 80, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', flexShrink: 0 }}>
              <div style={{ width: `${barW}%`, height: '100%', borderRadius: 3, background: sc, transition: 'width 0.3s' }} />
            </div>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', minWidth: 30, textAlign: 'right' }}>{w.pct}%</span>
            <span style={{ padding: '1px 6px', borderRadius: 4, background: `${sc}18`, fontFamily: M, fontSize: 8, fontWeight: 600, color: sc, minWidth: 50, textAlign: 'center' }}>
              {w.status === 'done' ? 'done \u2713' : w.status}
            </span>
          </div>
        )
      })}
      {/* Token burn */}
      <div style={{ display: 'flex', gap: 10, marginTop: 12, opacity: lerp(f, 15, 25, 0, 1) }}>
        <GP style={{ padding: '8px 12px', flex: 1 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>TOKEN BUDGET</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: M, fontSize: 14, fontWeight: 700, color: '#fff' }}>1,247</span>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>/ 5,000</span>
            <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{ width: '25%', height: '100%', borderRadius: 3, background: '#10b981' }} />
            </div>
            <span style={{ fontFamily: M, fontSize: 10, color: '#10b981', fontWeight: 600 }}>25%</span>
          </div>
        </GP>
      </div>
      {/* Handoff log */}
      <div style={{ marginTop: 10, opacity: lerp(f, 20, 30, 0, 1) }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>HANDOFF LOG</div>
        {TRD_HANDOFFS.map((h, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontFamily: M, fontSize: 9 }}>
            <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 55 }}>{h.ts}</span>
            <span style={{ color: '#ef4444', fontWeight: 600 }}>{h.from}</span>
            <span style={{ color: 'rgba(255,255,255,0.6)' }}>\u2192</span>
            <span style={{ color: '#f59e0b', fontWeight: 600 }}>{h.to}</span>
            <span style={{ color: 'rgba(255,255,255,0.7)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.msg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// AGENTIC TEAMS — 3. TEAM PERFORMANCE HISTORY
// ═══════════════════════════════════════════════════════════════
const TPH_RUNS = [
  { id: 47, s: 5, p: 1, f: 0, dur: 14, cost: 0.95 },
  { id: 48, s: 6, p: 0, f: 0, dur: 11, cost: 0.78 },
  { id: 49, s: 3, p: 1, f: 3, dur: 23, cost: 1.47 },
  { id: 50, s: 5, p: 1, f: 0, dur: 13, cost: 0.88 },
  { id: 51, s: 6, p: 0, f: 0, dur: 10, cost: 0.72 },
  { id: 52, s: 6, p: 0, f: 0, dur: 8, cost: 0.61 },
  { id: 53, s: 4, p: 2, f: 0, dur: 15, cost: 1.02 },
  { id: 54, s: 5, p: 1, f: 0, dur: 12, cost: 0.85 },
  { id: 55, s: 6, p: 0, f: 0, dur: 9, cost: 0.67 },
  { id: 56, s: 5, p: 0, f: 1, dur: 11, cost: 0.94 },
]

export function TeamPerformanceHistory() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 15, 0, 1)
  const wins = TPH_RUNS.filter(r => r.f === 0).length
  const avgDur = Math.round(TPH_RUNS.reduce((a, r) => a + r.dur, 0) / TPH_RUNS.length)
  const avgCost = (TPH_RUNS.reduce((a, r) => a + r.cost, 0) / TPH_RUNS.length).toFixed(2)
  const best = TPH_RUNS.reduce((a, r) => r.dur < a.dur && r.f === 0 ? r : a, TPH_RUNS[0])
  const worst = TPH_RUNS.reduce((a, r) => r.dur > a.dur ? r : a, TPH_RUNS[0])
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 2 }}>TEAM PERFORMANCE</div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>DevOps Alpha</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontFamily: M, fontSize: 11, color: '#10b981', fontWeight: 600 }}>Improving</span>
          <span style={{ fontFamily: M, fontSize: 14, color: '#10b981' }}>\u2191</span>
        </div>
      </div>
      {/* Run bars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
        {TPH_RUNS.map((r, i) => {
          const total = r.s + r.p + r.f
          const barReveal = lerp(f, 3 + i * 2, 15 + i * 2, 0, 1)
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: barReveal }}>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', minWidth: 24 }}>#{r.id}</span>
              <div style={{ flex: 1, height: 12, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden', display: 'flex' }}>
                <div style={{ width: `${(r.s / total) * 100 * barReveal}%`, height: '100%', background: '#10b981' }} />
                <div style={{ width: `${(r.p / total) * 100 * barReveal}%`, height: '100%', background: '#f59e0b' }} />
                <div style={{ width: `${(r.f / total) * 100 * barReveal}%`, height: '100%', background: '#ef4444' }} />
              </div>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', minWidth: 30 }}>{r.dur}m</span>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', minWidth: 40 }}>${r.cost}</span>
            </div>
          )
        })}
      </div>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 8, opacity: lerp(f, 15, 25, 0, 1) }}>
        <GP style={{ padding: '8px 12px', flex: 1, textAlign: 'center' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 2 }}>WIN RATE</div>
          <div style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: '#10b981' }}>{wins * 10}%</div>
        </GP>
        <GP style={{ padding: '8px 12px', flex: 1, textAlign: 'center' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 2 }}>AVG DURATION</div>
          <div style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: '#38bdf8' }}>{avgDur}m</div>
        </GP>
        <GP style={{ padding: '8px 12px', flex: 1, textAlign: 'center' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 2 }}>AVG COST</div>
          <div style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: '#a855f7' }}>${avgCost}</div>
        </GP>
      </div>
      {/* Best/Worst */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, opacity: lerp(f, 20, 30, 0, 1) }}>
        <GP style={{ padding: '8px 12px', flex: 1, borderTopColor: 'rgba(16,185,129,0.3)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: '#10b981', fontWeight: 600, marginBottom: 2 }}>BEST RUN</div>
          <div style={{ fontFamily: M, fontSize: 10, color: '#fff' }}>#{best.id} — {best.dur}m, ${best.cost}, all tasks succeeded</div>
        </GP>
        <GP style={{ padding: '8px 12px', flex: 1, borderTopColor: 'rgba(239,68,68,0.3)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: '#ef4444', fontWeight: 600, marginBottom: 2 }}>WORST RUN</div>
          <div style={{ fontFamily: M, fontSize: 10, color: '#fff' }}>#{worst.id} — {worst.dur}m, ${worst.cost}, {worst.f} failures</div>
        </GP>
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, marginTop: 8, opacity: lerp(f, 20, 30, 0, 1) }}>
        {[{ l: 'Success', c: '#10b981' }, { l: 'Partial', c: '#f59e0b' }, { l: 'Failed', c: '#ef4444' }].map(k => (
          <div key={k.l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: k.c, opacity: 0.8 }} />
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{k.l}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// AGENTIC TEAMS — 4. LEARNING ROUTER VIZ
// ═══════════════════════════════════════════════════════════════
const LRV_AGENTS = [
  { name: 'WARDEN', sel: 247, avg: 0.91, pct: 82, color: '#ef4444' },
  { name: 'VULCAN', sel: 189, avg: 0.78, pct: 61, color: '#a855f7' },
  { name: 'DAEDALUS', sel: 134, avg: 0.72, pct: 48, color: '#14b8a6' },
  { name: 'CIPHER', sel: 98, avg: 0.65, pct: 38, color: '#f59e0b' },
  { name: 'HYPERION', sel: 67, avg: 0.58, pct: 24, color: '#8b5cf6' },
  { name: 'CODEX', sel: 31, avg: 0.44, pct: 12, color: '#6366f1' },
]
const LRV_RECENT = [
  { q: 'scan edge-03 for open ports', agent: 'WARDEN', type: 'exploit' },
  { q: 'build new API endpoint', agent: 'VULCAN', type: 'exploit' },
  { q: 'analyze memory patterns', agent: 'CODEX', type: 'explore' },
  { q: 'generate monthly report', agent: 'DAEDALUS', type: 'exploit' },
  { q: 'check DNS propagation', agent: 'HYPERION', type: 'explore' },
]

export function LearningRouterViz() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const exploitPct = 85, explorePct = 15
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 4 }}>LEARNING ROUTER</div>
      <div style={{ fontFamily: F, fontSize: 12, color: '#fff', marginBottom: 10 }}>
        Epsilon: <span style={{ color: '#f59e0b', fontWeight: 700, fontFamily: M }}>0.15</span>
        <span style={{ color: 'rgba(255,255,255,0.6)', marginLeft: 8, fontSize: 11 }}>({exploitPct}% exploit, {explorePct}% explore)</span>
      </div>
      {/* Agent probability bars */}
      {LRV_AGENTS.map((a, i) => {
        const barW = a.pct * lerp(f, 3 + i * 2, 15 + i * 2, 0, 1)
        const op = lerp(f, 2 + i * 2, 10 + i * 2, 0, 1)
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, opacity: op }}>
            <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: a.color, minWidth: 70 }}>{a.name}</span>
            <div style={{ flex: 1, height: 10, borderRadius: 5, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
              <div style={{ width: `${barW}%`, height: '100%', borderRadius: 5, background: `linear-gradient(90deg, ${a.color}60, ${a.color})` }} />
            </div>
            <span style={{ fontFamily: M, fontSize: 10, color: a.color, fontWeight: 600, minWidth: 30, textAlign: 'right' }}>{a.pct}%</span>
            <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', minWidth: 85 }}>{a.sel} sel, avg {a.avg}</span>
          </div>
        )
      })}
      {/* Recent decisions + Pie */}
      <div style={{ display: 'flex', gap: 10, marginTop: 12, opacity: lerp(f, 15, 25, 0, 1) }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>RECENT DECISIONS</div>
          {LRV_RECENT.map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontFamily: M, fontSize: 9 }}>
              <span style={{ padding: '1px 5px', borderRadius: 3, background: d.type === 'explore' ? 'rgba(245,158,11,0.12)' : 'rgba(56,189,248,0.12)', color: d.type === 'explore' ? '#f59e0b' : '#38bdf8', fontWeight: 600, fontSize: 8, minWidth: 42, textAlign: 'center' }}>{d.type}</span>
              <span style={{ color: 'rgba(255,255,255,0.7)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.q}</span>
              <span style={{ color: '#fff', fontWeight: 600 }}>\u2192 {d.agent}</span>
            </div>
          ))}
        </div>
        {/* Mini pie */}
        <div style={{ width: 80, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <svg viewBox="0 0 60 60" style={{ width: 60, height: 60 }}>
            <circle cx={30} cy={30} r={24} fill="none" stroke="rgba(56,189,248,0.3)" strokeWidth={8} />
            <circle cx={30} cy={30} r={24} fill="none" stroke="#f59e0b" strokeWidth={8}
              strokeDasharray={`${explorePct / 100 * 150.8} ${150.8}`} strokeDashoffset={0}
              transform="rotate(-90 30 30)" opacity={0.8} />
            <text x={30} y={28} textAnchor="middle" fill="#fff" fontSize={9} fontFamily={M} fontWeight={700}>{exploitPct}%</text>
            <text x={30} y={37} textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize={7} fontFamily={M}>exploit</text>
          </svg>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            {[{ l: 'Exploit', c: '#38bdf8' }, { l: 'Explore', c: '#f59e0b' }].map(k => (
              <div key={k.l} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: k.c, opacity: 0.8 }} />
                <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.7)' }}>{k.l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// AGENTIC TEAMS — 5. FALLBACK CHAIN VIZ
// ═══════════════════════════════════════════════════════════════
const FCV_CHAINS = [
  { query: 'scan edge-03', steps: [
    { agent: 'WARDEN', score: 87, status: 'busy', color: '#ef4444' },
    { agent: 'WARDEN', score: 72, status: 'selected', color: '#f59e0b' },
  ]},
  { query: 'deploy v2.4', steps: [
    { agent: 'VULCAN', score: 91, status: 'selected', color: '#a855f7' },
  ]},
  { query: 'check DNS', steps: [
    { agent: 'MESHNET', score: 65, status: 'offline', color: '#06b6d4' },
    { agent: 'NETWATCH', score: 58, status: 'busy', color: '#ec4899' },
    { agent: 'WARDEN', score: 44, status: 'selected', color: '#ef4444' },
  ]},
]
const FCV_STATUS_COLORS = { selected: '#10b981', busy: '#f59e0b', offline: '#ef4444' }

export function FallbackChainViz() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>FALLBACK ROUTING</div>
      {FCV_CHAINS.map((chain, ci) => {
        const op = lerp(f, ci * 6, ci * 6 + 12, 0, 1)
        return (
          <GP key={ci} style={{ padding: '10px 14px', marginBottom: 8, opacity: op }}>
            <div style={{ fontFamily: M, fontSize: 10, color: '#38bdf8', marginBottom: 8 }}>"{chain.query}"</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              {chain.steps.map((step, si) => {
                const sc = FCV_STATUS_COLORS[step.status]
                const isSelected = step.status === 'selected'
                const stepOp = lerp(f, ci * 6 + si * 4, ci * 6 + si * 4 + 8, 0, 1)
                return (
                  <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: stepOp }}>
                    {si > 0 && <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>\u2192</span>}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, background: isSelected ? `${sc}12` : 'rgba(255,255,255,0.02)', border: `1px solid ${isSelected ? sc : 'rgba(255,255,255,0.06)'}` }}>
                      <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: step.color }}>{step.agent}</span>
                      <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>({step.score})</span>
                      <span style={{ fontFamily: M, fontSize: 8, fontWeight: 600, color: sc }}>{step.status === 'selected' ? '\u2713 SELECTED' : step.status === 'busy' ? 'BUSY' : 'OFFLINE \u2717'}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </GP>
        )
      })}
      {/* Stats */}
      <div style={{ display: 'flex', gap: 10, marginTop: 6, opacity: lerp(f, 18, 28, 0, 1) }}>
        <GP style={{ padding: '8px 12px', flex: 1 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>Fallback triggered <span style={{ color: '#f59e0b', fontWeight: 600 }}>23 times</span> (12%)</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>Avg fallback depth: <span style={{ color: '#38bdf8', fontWeight: 600 }}>1.3</span></div>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OPSDECK — 6. OPSDECK CANVAS
// ═══════════════════════════════════════════════════════════════
const ODC_OBJECTIVES = [
  { id: 'obj-7a3f', title: 'Deploy v2.4', pct: 67, status: 'running', color: '#10b981' },
  { id: 'obj-8b2c', title: 'Security scan', pct: 23, status: 'running', color: '#38bdf8' },
  { id: 'obj-1d4e', title: 'Nightly backup', pct: 89, status: 'running', color: '#a855f7' },
]
const ODC_EVENTS = [
  { ts: '14:34:01', msg: 'WARDEN completed port scan', color: '#10b981' },
  { ts: '14:33:45', msg: 'VULCAN pulled image v2.4.1', color: '#a855f7' },
  { ts: '14:33:22', msg: 'WARDEN detected stale lock', color: '#f59e0b' },
  { ts: '14:33:10', msg: 'DAEDALUS started report gen', color: '#14b8a6' },
  { ts: '14:32:58', msg: 'CIPHER decrypted payload OK', color: '#6366f1' },
  { ts: '14:32:40', msg: 'obj-1d4e task 4/5 done', color: '#a855f7' },
]
const ODC_HEATMAP_AGENTS = ['WARDEN', 'VULCAN', 'DAEDALUS', 'CIPHER']
const ODC_HEATMAP_DATA = [[8, 6, 9, 3], [3, 7, 5, 8], [5, 4, 7, 6], [2, 5, 3, 9]]

export function OpsDeckCanvas() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const livePulse = 0.6 + Math.sin(f * 0.12) * 0.4
  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, opacity: reveal }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>OpsDeck \u2014 Mission Control</span>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', opacity: livePulse, boxShadow: `0 0 8px rgba(16,185,129,${livePulse * 0.5})` }} />
          <span style={{ fontFamily: M, fontSize: 9, color: '#10b981', fontWeight: 600 }}>LIVE</span>
        </div>
      </div>
      {/* 3-column layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
        {/* Left: Objectives */}
        <GP style={{ padding: '10px 12px' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8 }}>ACTIVE OBJECTIVES</div>
          {ODC_OBJECTIVES.map((obj, i) => {
            const op = lerp(f, 3 + i * 3, 10 + i * 3, 0, 1)
            return (
              <div key={i} style={{ marginBottom: 8, opacity: op }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: obj.color, opacity: 0.8 }} />
                  <span style={{ fontFamily: F, fontSize: 10, color: '#fff', fontWeight: 600, flex: 1 }}>{obj.title}</span>
                  <span style={{ fontFamily: M, fontSize: 9, color: obj.color, fontWeight: 600 }}>{obj.pct}%</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div style={{ width: `${obj.pct}%`, height: '100%', borderRadius: 2, background: obj.color }} />
                </div>
              </div>
            )
          })}
        </GP>
        {/* Centre: Agent heatmap */}
        <GP style={{ padding: '10px 12px' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8 }}>AGENT ACTIVITY</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto repeat(4, 1fr)', gap: 3, alignItems: 'center' }}>
            <div />
            {['T-3', 'T-2', 'T-1', 'Now'].map(t => <span key={t} style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.6)', textAlign: 'center' }}>{t}</span>)}
            {ODC_HEATMAP_AGENTS.map((agent, ai) => (
              <>
                <span key={`l${ai}`} style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.7)' }}>{agent.slice(0, 4)}</span>
                {ODC_HEATMAP_DATA[ai].map((v, vi) => {
                  const intensity = v / 10
                  const color = `rgba(56,189,248,${0.1 + intensity * 0.7})`
                  return <div key={`${ai}-${vi}`} style={{ height: 18, borderRadius: 3, background: color, opacity: lerp(f, 5 + ai * 2 + vi, 12 + ai * 2 + vi, 0, 1) }} />
                })}
              </>
            ))}
          </div>
        </GP>
        {/* Right: Event stream */}
        <GP style={{ padding: '10px 12px' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8 }}>EVENT STREAM</div>
          {ODC_EVENTS.map((ev, i) => {
            const op = lerp(f, 4 + i * 2, 12 + i * 2, 0, 1)
            return (
              <div key={i} style={{ display: 'flex', gap: 6, padding: '3px 0', opacity: op, borderBottom: i < ODC_EVENTS.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', minWidth: 48 }}>{ev.ts}</span>
                <span style={{ fontFamily: M, fontSize: 8, color: ev.color, flex: 1 }}>{ev.msg}</span>
              </div>
            )
          })}
        </GP>
      </div>
      {/* Bottom strip */}
      <div style={{ display: 'flex', gap: 6, opacity: lerp(f, 12, 22, 0, 1) }}>
        {[
          { l: 'Objectives', v: '3 active', c: '#10b981' },
          { l: 'Tasks', v: '12 running', c: '#38bdf8' },
          { l: 'Agents', v: '8/16', c: '#a855f7' },
          { l: 'Tokens', v: '4.2K', c: '#f59e0b' },
          { l: 'Uptime', v: '14d', c: '#06b6d4' },
        ].map((m, i) => (
          <GP key={i} style={{ padding: '6px 10px', flex: 1, textAlign: 'center' }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>{m.l}</div>
            <div style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: m.c }}>{m.v}</div>
          </GP>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OPSDECK — 7. OBJECTIVE NODE GRAPH
// ═══════════════════════════════════════════════════════════════
const ONG_NODES = [
  { id: 'root', x: 300, y: 30, label: 'Deploy v2.4 to production', agent: 'CommanderQ', status: 'running', color: '#a855f7' },
  { id: 'pull', x: 100, y: 120, label: 'Pull images', agent: 'VULCAN', status: 'done', color: '#10b981', dur: '14s' },
  { id: 'migrate', x: 250, y: 120, label: 'Run migrations', agent: 'CODEX', status: 'done', color: '#10b981', dur: '23s' },
  { id: 'health', x: 400, y: 120, label: 'Health check', agent: 'WARDEN', status: 'running', color: '#38bdf8', dur: '...' },
  { id: 'dns', x: 500, y: 120, label: 'Update DNS', agent: 'MESHNET', status: 'pending', color: 'rgba(255,255,255,0.3)', dur: '--' },
]
const ONG_EDGES = [
  { from: 'root', to: 'pull' }, { from: 'root', to: 'migrate' }, { from: 'root', to: 'health' }, { from: 'root', to: 'dns' },
  { from: 'migrate', to: 'health' }, { from: 'health', to: 'dns' },
]

export function ObjectiveNodeGraph() {
  const f = useAnimFrame()
  const nodeMap = {}
  ONG_NODES.forEach(n => { nodeMap[n.id] = n })
  const pulse = 0.6 + Math.sin(f * 0.1) * 0.4
  return (
    <div style={{ position: 'relative', width: 600, height: 200 }}>
      <svg width={600} height={200} style={{ position: 'absolute', inset: 0 }}>
        {ONG_EDGES.map((e, i) => {
          const src = nodeMap[e.from], dst = nodeMap[e.to]
          const op = lerp(f, 3 + i * 2, 10 + i * 2, 0, 1)
          const isDep = (e.from === 'migrate' && e.to === 'health') || (e.from === 'health' && e.to === 'dns')
          return <line key={i} x1={src.x} y1={src.y + 16} x2={dst.x} y2={dst.y - 16} stroke={isDep ? '#f59e0b' : 'rgba(255,255,255,0.15)'} strokeWidth={isDep ? 1.5 : 1} strokeDasharray={isDep ? '4 3' : 'none'} opacity={op} />
        })}
        {/* Animated flow dots on dependency edges */}
        {ONG_EDGES.filter(e => (e.from === 'migrate' && e.to === 'health')).map((e, i) => {
          const src = nodeMap[e.from], dst = nodeMap[e.to]
          const t = (f % 30) / 30
          const dx = src.x + (dst.x - src.x) * t, dy = (src.y + 16) + ((dst.y - 16) - (src.y + 16)) * t
          return <circle key={`dot${i}`} cx={dx} cy={dy} r={2} fill="#f59e0b" opacity={0.7} />
        })}
      </svg>
      {ONG_NODES.map((n, i) => {
        const op = lerp(f, 2 + i * 2, 8 + i * 2, 0, 1)
        const isRoot = n.id === 'root'
        const isRunning = n.status === 'running'
        return (
          <div key={n.id} style={{
            position: 'absolute', left: n.x, top: n.y, transform: 'translate(-50%, -50%)',
            padding: isRoot ? '6px 14px' : '4px 10px', borderRadius: 8, opacity: op,
            background: isRoot ? 'rgba(168,85,247,0.08)' : 'rgba(255,255,255,0.02)',
            border: `1px solid ${isRunning ? `${n.color}50` : n.status === 'done' ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.06)'}`,
            boxShadow: isRoot ? `0 0 ${12 * pulse}px rgba(168,85,247,0.15)` : isRunning ? `0 0 8px ${n.color}22` : 'none',
            whiteSpace: 'nowrap',
          }}>
            <div style={{ fontFamily: F, fontSize: isRoot ? 11 : 9, fontWeight: 600, color: '#fff', marginBottom: 2 }}>{n.label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontFamily: M, fontSize: 8, color: n.color }}>{n.agent}</span>
              {n.dur && <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.6)' }}>{n.dur}</span>}
              <span style={{ padding: '0px 4px', borderRadius: 3, background: `${n.color}15`, fontFamily: M, fontSize: 7, fontWeight: 600, color: n.color }}>
                {n.status === 'done' ? '\u2713' : n.status === 'running' ? '\u25CF' : '\u25CB'}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OPSDECK — 8. ZOMBIE PANEL VIEW
// ═══════════════════════════════════════════════════════════════
const ZPV_ZOMBIES = [
  { id: 'obj-3a1f', title: 'Backup NAS', stuck: '47m', expected: '15m', agent: 'KEEPER', reason: 'Last heartbeat 12m ago', color: '#ef4444' },
  { id: 'obj-8b2c', title: 'Generate report', stuck: '23m', expected: '8m', agent: 'DAEDALUS', reason: 'Waiting for WARDEN (busy)', color: '#f59e0b' },
  { id: 'obj-1d4e', title: 'DNS propagation check', stuck: '2h', expected: '5m', agent: 'MESHNET', reason: 'Agent offline', color: '#ef4444' },
]

export function ZombiePanelView() {
  const f = useAnimFrame()
  const warnPulse = 0.6 + Math.sin(f * 0.12) * 0.4
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 16 }}>\u26A0</span>
        <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Zombie Detection</span>
        <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(255,255,255,0.06)', fontFamily: M, fontSize: 8, fontWeight: 700, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.05em' }}>SAMPLE DATA</span>
        <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(239,68,68,0.12)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#ef4444' }}>{ZPV_ZOMBIES.length} stuck</span>
      </div>
      {ZPV_ZOMBIES.map((z, i) => {
        const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
        return (
          <GP key={i} style={{ padding: '12px 14px', marginBottom: 8, opacity: op, borderTopColor: `${z.color}30` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{z.id}</span>
                  <span style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: '#fff' }}>{z.title}</span>
                </div>
                <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
                  Stuck <span style={{ color: z.color, fontWeight: 600 }}>{z.stuck}</span>
                  <span style={{ color: 'rgba(255,255,255,0.5)' }}> (expected {z.expected})</span>
                  <span style={{ color: 'rgba(255,255,255,0.5)' }}> \u2014 Agent: </span>
                  <span style={{ color: '#38bdf8', fontWeight: 600 }}>{z.agent}</span>
                </div>
                <div style={{ fontFamily: M, fontSize: 9, color: z.color, marginTop: 3, opacity: warnPulse }}>{z.reason}</div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {['Retry', 'Reassign', 'Abort'].map((btn, bi) => (
                  <span key={bi} style={{
                    padding: '3px 8px', borderRadius: 4, fontFamily: M, fontSize: 8, fontWeight: 600, cursor: 'pointer',
                    background: btn === 'Abort' ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.04)',
                    color: btn === 'Abort' ? '#ef4444' : btn === 'Retry' ? '#10b981' : '#38bdf8',
                    border: `1px solid ${btn === 'Abort' ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.08)'}`,
                  }}>{btn}</span>
                ))}
              </div>
            </div>
          </GP>
        )
      })}
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', marginTop: 4, opacity: lerp(f, 15, 25, 0, 1) }}>
        Auto-recovery: <span style={{ color: '#10b981', fontWeight: 600 }}>2 auto-recovered in last hour</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OPSDECK — 9. TASK DEPENDENCY MATRIX
// ═══════════════════════════════════════════════════════════════
const TDM_TASKS = ['Pull', 'Build', 'Test', 'Migrate', 'Deploy', 'Verify']
const TDM_DEPS = [[0,0,0,0,0,0],[1,0,0,0,0,0],[0,1,0,0,0,0],[0,0,0,0,0,0],[0,0,1,0,0,0],[0,0,0,0,1,0]]
const TDM_STATUS = ['done', 'done', 'running', 'running', 'pending', 'pending']
const TDM_CRITICAL = [0, 1, 2, 4, 5] // Pull->Build->Test->Deploy->Verify
const TDM_STATUS_COLORS = { done: '#10b981', running: '#38bdf8', pending: 'rgba(255,255,255,0.3)' }

export function TaskDependencyMatrix() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 15, 0, 1)
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>TASK DEPENDENCY MATRIX</div>
      <div style={{ display: 'inline-grid', gridTemplateColumns: `auto repeat(${TDM_TASKS.length}, 40px)`, gap: 2, opacity: reveal }}>
        <div />
        {TDM_TASKS.map((t, i) => (
          <div key={i} style={{ fontFamily: M, fontSize: 8, color: TDM_STATUS_COLORS[TDM_STATUS[i]], textAlign: 'center', fontWeight: 600, padding: '4px 0' }}>{t}</div>
        ))}
        {TDM_TASKS.map((row, ri) => (
          <>
            <div key={`l${ri}`} style={{ fontFamily: M, fontSize: 8, color: TDM_STATUS_COLORS[TDM_STATUS[ri]], fontWeight: 600, display: 'flex', alignItems: 'center', paddingRight: 6 }}>{row}</div>
            {TDM_TASKS.map((_, ci) => {
              const isDep = TDM_DEPS[ri][ci] === 1
              const isSelf = ri === ci
              const isCrit = TDM_CRITICAL.includes(ri) && TDM_CRITICAL.includes(ci) && isDep
              const cellOp = lerp(f, 5 + ri + ci, 15 + ri + ci, 0, 1)
              return (
                <div key={`${ri}-${ci}`} style={{
                  width: 40, height: 28, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: isSelf ? 'rgba(255,255,255,0.02)' : isDep ? `${isCrit ? '#f59e0b' : '#38bdf8'}10` : 'rgba(255,255,255,0.01)',
                  border: `1px solid ${isCrit ? 'rgba(245,158,11,0.3)' : isDep ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.03)'}`,
                  opacity: cellOp,
                }}>
                  {isSelf ? <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.2)' }}>\u2014</span> :
                    isDep ? <span style={{ fontSize: 10, color: isCrit ? '#f59e0b' : '#38bdf8' }}>\u25CF</span> :
                    <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.15)' }}>\u25CB</span>}
                </div>
              )
            })}
          </>
        ))}
      </div>
      <div style={{ marginTop: 10, opacity: lerp(f, 15, 25, 0, 1) }}>
        <div style={{ fontFamily: M, fontSize: 9, color: '#f59e0b', marginBottom: 4 }}>Critical path: Pull \u2192 Build \u2192 Test \u2192 Deploy \u2192 Verify (4 tasks, est. 18 min)</div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Parallel: Migrate runs alongside Test</div>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, opacity: lerp(f, 18, 28, 0, 1) }}>
        {[{ l: 'Done', c: '#10b981' }, { l: 'Running', c: '#38bdf8' }, { l: 'Pending', c: 'rgba(255,255,255,0.3)' }, { l: 'Critical', c: '#f59e0b' }].map(k => (
          <div key={k.l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: k.c, opacity: 0.8 }} />
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.7)' }}>{k.l}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OPSDECK — 10. HEARTBEAT MONITOR
// ═══════════════════════════════════════════════════════════════
const HBM_AGENTS = [
  { name: 'WARDEN', hb: '2s', status: 'fresh' }, { name: 'VULCAN', hb: '5s', status: 'fresh' },
  { name: 'DAEDALUS', hb: '8s', status: 'fresh' }, { name: 'CIPHER', hb: '12s', status: 'fresh' },
  { name: 'HYPERION', hb: '3s', status: 'fresh' }, { name: 'CODEX', hb: '18s', status: 'fresh' },
  { name: 'WARDEN', hb: '7s', status: 'fresh' }, { name: 'SCOUT', hb: '22s', status: 'fresh' },
  { name: 'NETWATCH', hb: '4s', status: 'fresh' }, { name: 'KEEPER', hb: '15s', status: 'fresh' },
  { name: 'INSIGHT', hb: '6s', status: 'fresh' }, { name: 'ORACLE', hb: '9s', status: 'fresh' },
  { name: 'VIGIL', hb: '45s', status: 'warm' }, { name: 'METRICS', hb: '1m 20s', status: 'warm' },
  { name: 'MESHNET', hb: '3m 10s', status: 'stale' }, { name: 'GEMINI', hb: '8m', status: 'dead' },
]
const HBM_STATUS_COLORS = { fresh: '#10b981', warm: '#f59e0b', stale: '#ef4444', dead: 'rgba(255,255,255,0.25)' }

export function HeartbeatMonitor() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const freshPulse = 0.7 + Math.sin(f * 0.1) * 0.3
  const stalePulse = 0.5 + Math.sin(f * 0.2) * 0.5
  const healthy = HBM_AGENTS.filter(a => a.status === 'fresh' || a.status === 'warm').length
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, opacity: reveal }}>
        <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Heartbeat Monitor \u2014 {healthy}/16 healthy</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {HBM_AGENTS.map((a, i) => {
          const sc = HBM_STATUS_COLORS[a.status]
          const op = lerp(f, 2 + i, 10 + i, 0, 1)
          const p = a.status === 'fresh' ? freshPulse : a.status === 'stale' ? stalePulse : 1
          return (
            <GP key={i} style={{ padding: '8px 10px', opacity: op, borderTopColor: `${sc}30` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: sc, opacity: p, boxShadow: a.status !== 'dead' ? `0 0 4px ${sc}44` : 'none' }} />
                <span style={{ fontFamily: M, fontSize: 8, fontWeight: 600, color: a.status === 'dead' ? 'rgba(255,255,255,0.3)' : '#fff' }}>{a.name}</span>
              </div>
              <div style={{ fontFamily: M, fontSize: 8, color: sc }}>{a.status === 'dead' ? '\u2717 ' + a.hb : a.hb + ' ago'}</div>
            </GP>
          )
        })}
      </div>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginTop: 8, opacity: lerp(f, 15, 25, 0, 1) }}>
        Auto-recovery: <span style={{ color: '#10b981', fontWeight: 600 }}>MESHNET auto-restarted 3m ago</span>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 6, opacity: lerp(f, 18, 28, 0, 1) }}>
        {[{ l: 'Fresh (<30s)', c: '#10b981' }, { l: 'Warm (30s-2m)', c: '#f59e0b' }, { l: 'Stale (2-5m)', c: '#ef4444' }, { l: 'Dead (>5m)', c: 'rgba(255,255,255,0.25)' }].map(k => (
          <div key={k.l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: k.c, opacity: 0.8 }} />
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.7)' }}>{k.l}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OBJECTIVES — 11. OBJECTIVE TIMELINE
// ═══════════════════════════════════════════════════════════════
const OTL_EVENTS = [
  { ts: '14:30:00', label: 'Created', actor: 'user', type: 'create', color: '#38bdf8' },
  { ts: '14:30:02', label: 'Decomposed', actor: 'CommanderQ', detail: '6 tasks', type: 'system', color: '#a855f7' },
  { ts: '14:30:03', label: 'Team assigned', actor: 'Security Patrol', detail: 'Star topology', type: 'system', color: '#6366f1' },
  { ts: '14:30:04', label: 'Execution started', actor: '', type: 'start', color: '#10b981' },
  { ts: '14:32:15', label: 'Task 3 failed', actor: 'CIPHER', detail: 'SSH timeout', type: 'error', color: '#ef4444' },
  { ts: '14:32:45', label: 'Auto-retry succeeded', actor: '', type: 'recovery', color: '#f59e0b' },
  { ts: '14:34:23', label: 'Completed', actor: '', detail: 'Duration: 4m 23s', type: 'complete', color: '#10b981' },
]

export function ObjectiveTimeline() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>OBJECTIVE LIFECYCLE</div>
      <div style={{ position: 'relative', paddingLeft: 28 }}>
        <div style={{ position: 'absolute', left: 12, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.06)' }} />
        {OTL_EVENTS.map((ev, i) => {
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          const isLast = i === OTL_EVENTS.length - 1
          return (
            <div key={i} style={{ position: 'relative', marginBottom: isLast ? 0 : 8, opacity: op, transform: `translateY(${lerp(f, i * 3, i * 3 + 6, 6, 0)}px)` }}>
              <div style={{ position: 'absolute', left: -22, top: 8, width: 8, height: 8, borderRadius: '50%', background: ev.color, opacity: 0.8, boxShadow: `0 0 6px ${ev.color}44` }} />
              <GP style={{ padding: '8px 12px', borderTopColor: `${ev.color}25` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff' }}>{ev.label}</span>
                    {ev.actor && <span style={{ fontFamily: M, fontSize: 9, color: ev.color }}>{ev.actor}</span>}
                    {ev.detail && <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{ev.detail}</span>}
                  </div>
                  <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{ev.ts}</span>
                </div>
                {isLast && <div style={{ marginTop: 4 }}>
                  <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.12)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#10b981' }}>COMPLETED</span>
                </div>}
              </GP>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OBJECTIVES — 12. OBJECTIVE COMPARISON
// ═══════════════════════════════════════════════════════════════
const OC_RUNS = [
  { label: 'Run A', date: 'March 23', dur: '4m 23s', cost: '$0.87', tasks: '6/6', success: 100, topology: 'Star', durSec: 263, costNum: 0.87 },
  { label: 'Run B', date: 'March 24', dur: '7m 12s', cost: '$1.34', tasks: '5/6 (1 retry)', success: 83, topology: 'Hierarchical', durSec: 432, costNum: 1.34 },
]

export function ObjectiveComparison() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 15, 0, 1)
  const durDelta = Math.round((1 - OC_RUNS[0].durSec / OC_RUNS[1].durSec) * 100)
  const costDelta = Math.round((1 - OC_RUNS[0].costNum / OC_RUNS[1].costNum) * 100)
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10 }}>OBJECTIVE COMPARISON</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        {OC_RUNS.map((r, i) => {
          const isA = i === 0
          const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
          return (
            <GP key={i} style={{ padding: '12px 14px', opacity: op, borderTopColor: isA ? 'rgba(16,185,129,0.3)' : 'rgba(56,189,248,0.3)' }}>
              <div style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: isA ? '#10b981' : '#38bdf8', marginBottom: 8 }}>{r.label} <span style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 400, fontSize: 9 }}>{r.date}</span></div>
              {[{ l: 'Duration', v: r.dur }, { l: 'Cost', v: r.cost }, { l: 'Tasks', v: r.tasks }, { l: 'Success', v: `${r.success}%` }, { l: 'Topology', v: r.topology }].map((m, mi) => (
                <div key={mi} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: mi < 4 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>
                  <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{m.l}</span>
                  <span style={{ fontFamily: M, fontSize: 10, color: '#fff', fontWeight: 600 }}>{m.v}</span>
                </div>
              ))}
            </GP>
          )
        })}
      </div>
      {/* Deltas */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, opacity: lerp(f, 10, 20, 0, 1) }}>
        {[{ l: 'Duration', v: `-${durDelta}%`, c: '#10b981' }, { l: 'Cost', v: `-${costDelta}%`, c: '#10b981' }, { l: 'Success', v: '100% vs 83%', c: '#10b981' }].map((d, i) => (
          <GP key={i} style={{ padding: '6px 10px', flex: 1, textAlign: 'center' }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.7)', marginBottom: 2 }}>{d.l}</div>
            <div style={{ fontFamily: M, fontSize: 14, fontWeight: 700, color: d.c }}>{d.v}</div>
          </GP>
        ))}
      </div>
      {/* Learning */}
      <GP style={{ padding: '10px 14px', opacity: lerp(f, 15, 25, 0, 1), borderTopColor: 'rgba(168,85,247,0.3)' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: '#a855f7', fontWeight: 600, marginBottom: 3 }}>LEARNING</div>
        <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.8)', lineHeight: 1.5 }}>Run A used star topology, Run B used hierarchical \u2014 star was faster for this objective.</div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 3 }}>Saved to Wisdom Store: star topology preferred for &lt;6 tasks</div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OBJECTIVES — 13. OBJECTIVE TEMPLATE GALLERY
// ═══════════════════════════════════════════════════════════════
const OTG_TEMPLATES = [
  { name: 'Security Scan', uses: 47, avgDur: '3m', topo: 'Star', chief: 'WARDEN', color: '#ef4444' },
  { name: 'Deploy to Prod', uses: 23, avgDur: '12m', topo: 'Pipeline', chief: 'VULCAN', color: '#a855f7' },
  { name: 'Nightly Backup', uses: 89, avgDur: '8m', topo: 'Star', chief: 'KEEPER', color: '#10b981' },
  { name: 'Generate Report', uses: 12, avgDur: '5m', topo: 'Star', chief: 'DAEDALUS', color: '#14b8a6' },
  { name: 'Infrastructure Audit', uses: 8, avgDur: '25m', topo: 'Hierarchical', chief: 'WARDEN', color: '#f59e0b' },
  { name: 'DNS Health Check', uses: 34, avgDur: '2m', topo: 'Star', chief: 'MESHNET', color: '#06b6d4' },
]
const OTG_TOPO_COLORS = { Star: '#a855f7', Pipeline: '#10b981', Hierarchical: '#38bdf8' }

export function ObjectiveTemplateGallery() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1 }}>OBJECTIVE TEMPLATES</div>
        <span style={{ padding: '3px 10px', borderRadius: 5, background: 'rgba(56,189,248,0.08)', fontFamily: M, fontSize: 9, fontWeight: 600, color: '#38bdf8', cursor: 'pointer', border: '1px solid rgba(56,189,248,0.2)' }}>+ Create from last objective</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {OTG_TEMPLATES.map((t, i) => {
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          const tc = OTG_TOPO_COLORS[t.topo] || '#fff'
          return (
            <GP key={i} style={{ padding: '12px 14px', opacity: op }}>
              <div style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: '#fff', marginBottom: 6 }}>{t.name}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                <span style={{ padding: '1px 6px', borderRadius: 4, background: `${tc}15`, fontFamily: M, fontSize: 8, fontWeight: 600, color: tc }}>{t.topo}</span>
                <span style={{ padding: '1px 6px', borderRadius: 4, background: `${t.color}12`, fontFamily: M, fontSize: 8, fontWeight: 600, color: t.color }}>{t.chief}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>
                <span>Used {t.uses}x</span>
                <span>Avg {t.avgDur}</span>
              </div>
              <div style={{
                padding: '4px 0', borderRadius: 4, fontFamily: M, fontSize: 9, fontWeight: 600,
                color: '#10b981', textAlign: 'center', cursor: 'pointer',
                background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)',
              }}>\u25B6 Run</div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OBJECTIVES — 14. BUDGET TRACKER
// ═══════════════════════════════════════════════════════════════
const BT_TASKS = [
  { name: 'Decomposition', tokens: 234, pct: 2, color: '#6366f1' },
  { name: 'WARDEN scan', tokens: 2891, pct: 29, color: '#ef4444' },
  { name: 'VULCAN analysis', tokens: 1456, pct: 15, color: '#a855f7' },
  { name: 'DAEDALUS report', tokens: 2189, pct: 22, color: '#14b8a6' },
  { name: 'Remaining tasks', tokens: 2100, pct: 21, color: 'rgba(255,255,255,0.3)' },
]

export function BudgetTracker() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 15, 0, 1)
  const used = 7234, budget = 10000, pct = Math.round(used / budget * 100)
  const projected = 8870
  const gaugeR = 40, gaugeC = 2 * Math.PI * gaugeR
  const warnThresh = 80
  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 4 }}>BUDGET TRACKER</div>
      <div style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 10 }}>Full Infrastructure Audit</div>
      {/* Gauge + stats */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 14 }}>
        <div style={{ position: 'relative', width: 100, height: 100, flexShrink: 0 }}>
          <svg viewBox="0 0 100 100" style={{ width: 100, height: 100 }}>
            <circle cx={50} cy={50} r={gaugeR} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={7} />
            <circle cx={50} cy={50} r={gaugeR} fill="none" stroke={pct > warnThresh ? '#f59e0b' : '#38bdf8'} strokeWidth={7}
              strokeLinecap="round" strokeDasharray={gaugeC} strokeDashoffset={gaugeC * (1 - (pct / 100) * reveal)}
              transform="rotate(-90 50 50)" opacity={0.8} />
            {/* Warning threshold line */}
            <circle cx={50} cy={50} r={gaugeR} fill="none" stroke="#ef4444" strokeWidth={1}
              strokeDasharray={`2 ${gaugeC - 2}`} strokeDashoffset={gaugeC * (1 - warnThresh / 100)}
              transform="rotate(-90 50 50)" opacity={0.4} />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: pct > warnThresh ? '#f59e0b' : '#fff' }}>{Math.round(pct * reveal)}%</span>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>{used.toLocaleString()} / {budget.toLocaleString()}</span>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          {BT_TASKS.map((t, i) => {
            const barW = t.pct * lerp(f, 5 + i * 2, 15 + i * 2, 0, 1)
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, opacity: lerp(f, 3 + i * 2, 10 + i * 2, 0, 1) }}>
                <span style={{ fontFamily: M, fontSize: 9, color: t.color, minWidth: 90, fontWeight: 500 }}>{t.name}</span>
                <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                  <div style={{ width: `${barW}%`, height: '100%', borderRadius: 4, background: t.color, opacity: 0.8 }} />
                </div>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', minWidth: 50, textAlign: 'right' }}>{t.tokens.toLocaleString()} ({t.pct}%)</span>
              </div>
            )
          })}
        </div>
      </div>
      {/* Projection + toggle */}
      <div style={{ display: 'flex', gap: 8, opacity: lerp(f, 15, 25, 0, 1) }}>
        <GP style={{ padding: '8px 12px', flex: 1, borderTopColor: 'rgba(16,185,129,0.3)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 2 }}>PROJECTION</div>
          <div style={{ fontFamily: M, fontSize: 14, fontWeight: 700, color: '#10b981' }}>Est. total: {projected.toLocaleString()} tokens (within budget) \u2713</div>
        </GP>
        <GP style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 28, height: 14, borderRadius: 7, background: 'rgba(16,185,129,0.3)', position: 'relative', cursor: 'pointer' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#10b981', position: 'absolute', right: 2, top: 2 }} />
          </div>
          <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>Pause if exceeds</span>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// OBJECTIVES — 15. OBJECTIVE QUEUE VIEW
// ═══════════════════════════════════════════════════════════════
const OQV_RUNNING = [
  { id: 'obj-7a3f', title: 'Deploy v2.4', pct: 67, team: 'VULCAN team', elapsed: '4m', color: '#10b981' },
  { id: 'obj-8b2c', title: 'Security scan', pct: 23, team: 'WARDEN team', elapsed: '1m', color: '#38bdf8' },
]
const OQV_PAUSED = [
  { id: 'obj-1d4e', title: 'Budget exceeded', pct: 80, reason: 'Paused by Guardian', color: '#f59e0b' },
]
const OQV_QUEUE = [
  { pri: 'P1', title: 'Critical patch edge-03', sched: '14:45', color: '#ef4444' },
  { pri: 'P2', title: 'Nightly backup', sched: '15:00', color: '#f59e0b' },
  { pri: 'P3', title: 'Report generation', sched: '15:30', color: '#a855f7' },
  { pri: 'P4', title: 'DNS check', sched: '16:00', color: '#38bdf8' },
  { pri: 'P5', title: 'Log rotation', sched: '16:30', color: 'rgba(255,255,255,0.5)' },
]

export function ObjectiveQueueView() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, opacity: reveal }}>
        <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Objective Queue</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ fontFamily: M, fontSize: 9, color: '#10b981' }}>2 running</span>
          <span style={{ fontFamily: M, fontSize: 9, color: '#f59e0b' }}>1 paused</span>
          <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>5 pending</span>
        </div>
      </div>
      {/* Running */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 9, color: '#10b981', letterSpacing: 1, marginBottom: 6 }}>RUNNING</div>
        {OQV_RUNNING.map((obj, i) => {
          const op = lerp(f, 2 + i * 3, 8 + i * 3, 0, 1)
          return (
            <GP key={i} style={{ padding: '10px 14px', marginBottom: 6, opacity: op, borderTopColor: 'rgba(16,185,129,0.25)', borderLeftColor: 'rgba(16,185,129,0.15)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{obj.id}</span>
                <span style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff', flex: 1 }}>{obj.title}</span>
                <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{obj.team}</span>
                <div style={{ width: 60, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div style={{ width: `${obj.pct}%`, height: '100%', borderRadius: 3, background: obj.color }} />
                </div>
                <span style={{ fontFamily: M, fontSize: 10, color: obj.color, fontWeight: 600, minWidth: 28 }}>{obj.pct}%</span>
                <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{obj.elapsed}</span>
              </div>
            </GP>
          )
        })}
      </div>
      {/* Paused */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 9, color: '#f59e0b', letterSpacing: 1, marginBottom: 6 }}>PAUSED</div>
        {OQV_PAUSED.map((obj, i) => (
          <GP key={i} style={{ padding: '10px 14px', marginBottom: 6, opacity: lerp(f, 8, 16, 0, 1), borderTopColor: 'rgba(245,158,11,0.25)', borderLeftColor: 'rgba(245,158,11,0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{obj.id}</span>
              <span style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff', flex: 1 }}>{obj.title}</span>
              <span style={{ fontFamily: M, fontSize: 9, color: '#f59e0b' }}>{obj.pct}%</span>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{obj.reason}</span>
            </div>
          </GP>
        ))}
      </div>
      {/* Queue */}
      <div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', letterSpacing: 1, marginBottom: 6 }}>QUEUE</div>
        {OQV_QUEUE.map((obj, i) => {
          const op = lerp(f, 10 + i * 2, 18 + i * 2, 0, 1)
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: i < OQV_QUEUE.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none', opacity: op }}>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.3)', cursor: 'grab' }}>\u2261</span>
              <span style={{ padding: '1px 6px', borderRadius: 4, background: `${obj.color}12`, fontFamily: M, fontSize: 9, fontWeight: 700, color: obj.color, minWidth: 22, textAlign: 'center' }}>{obj.pri}</span>
              <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{obj.title}</span>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{obj.sched}</span>
            </div>
          )
        })}
      </div>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 8, opacity: lerp(f, 20, 30, 0, 1) }}>
        Estimated queue drain: <span style={{ color: '#38bdf8', fontWeight: 600 }}>47 min</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// EVOLVED HOLOGRID SERIES — 3D Perspective Grids with Agents & Circuits
// ═══════════════════════════════════════════════════════════════

// ─── Shared HoloGrid utilities ─────────────────────────────────
function holoVertices(cols, rows, t, amplitude) {
  const v = []
  for (let r = 0; r <= rows; r++) {
    const row = []
    for (let c = 0; c <= cols; c++) {
      const wave = Math.sin(c * 0.3 + t) * Math.cos(r * 0.25 + t * 0.7) * amplitude + Math.sin((c + r) * 0.15 + t * 1.3) * amplitude * 0.4
      row.push(wave)
    }
    v.push(row)
  }
  return v
}

function holoGridLines(cols, rows, cellW, cellH, vertices) {
  const hLines = [], vLines = []
  for (let r = 0; r <= rows; r++) {
    let d = ''
    for (let c = 0; c <= cols; c++) d += (c === 0 ? 'M' : 'L') + ` ${c * cellW} ${r * cellH - vertices[r][c]}`
    hLines.push(d)
  }
  for (let c = 0; c <= cols; c++) {
    let d = ''
    for (let r = 0; r <= rows; r++) d += (r === 0 ? 'M' : 'L') + ` ${c * cellW} ${r * cellH - vertices[r][c]}`
    vLines.push(d)
  }
  return { hLines, vLines }
}

function holoGetY(vertices, col, row, cellH) {
  const rc = Math.floor(col), rr = Math.floor(row)
  const fc = col - rc, fr = row - rr
  const v00 = vertices[rr]?.[rc] || 0
  const v10 = vertices[rr]?.[rc + 1] || 0
  const v01 = vertices[rr + 1]?.[rc] || 0
  const v11 = vertices[rr + 1]?.[rc + 1] || 0
  return row * cellH - (v00 * (1 - fc) * (1 - fr) + v10 * fc * (1 - fr) + v01 * (1 - fc) * fr + v11 * fc * fr)
}

function holoCircuitPath(vertices, fromCol, fromRow, toCol, toRow, cellW, cellH, steps = 24) {
  let d = ''
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const c = fromCol + (toCol - fromCol) * t
    const r = fromRow + (toRow - fromRow) * t
    const x = c * cellW
    const y = holoGetY(vertices, c, r, cellH)
    d += (i === 0 ? 'M' : 'L') + ` ${x} ${y}`
  }
  return d
}

// ─── 1. HOLO AGENT GRID — Star Topology ─────────────────────────
const HAG_AGENTS = [
  { name: 'CommanderQ', col: 10, row: 7, color: '#a855f7', r: 14, glow: true },
  { name: 'WARDEN', col: 3, row: 2, color: '#10b981', r: 9 },
  { name: 'VULCAN', col: 17, row: 2, color: '#3b82f6', r: 9 },
  { name: 'DAEDALUS', col: 3, row: 11, color: '#a855f7', r: 9 },
  { name: 'CIPHER', col: 17, row: 11, color: '#f59e0b', r: 9 },
]

export function HoloAgentGrid() {
  const f = useAnimFrame()
  const cols = 20, rows = 14, cellW = 30, cellH = 26, amp = 8
  const gridW = cols * cellW, gridH = rows * cellH
  const t = f * 0.04
  const verts = holoVertices(cols, rows, t, amp)
  const { hLines, vLines } = holoGridLines(cols, rows, cellW, cellH, verts)
  const fadeIn = lerp(f, 0, 20, 0, 1)
  const pad = amp + 30
  const vb = `${-pad} ${-pad - amp - 30} ${gridW + pad * 2} ${gridH + pad * 2 + amp + 30}`
  const cmdQ = HAG_AGENTS[0]

  return (
    <div style={{ width: '100%', height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', opacity: fadeIn, contain: 'layout' }}>
      <div style={{ perspective: 800, perspectiveOrigin: '50% 30%' }}>
        <div style={{ transform: 'rotateX(55deg)', transformStyle: 'preserve-3d' }}>
          <svg viewBox={vb} style={{ width: 650, height: 380, overflow: 'visible' }}>
            <defs>
              {HAG_AGENTS.map(a => (
                <radialGradient key={`g-${a.name}`} id={`hag-glow-${a.name}`}>
                  <stop offset="0%" stopColor={a.color} stopOpacity={0.6} />
                  <stop offset="100%" stopColor={a.color} stopOpacity={0} />
                </radialGradient>
              ))}
            </defs>
            {/* Grid lines */}
            {hLines.map((d, i) => <path key={`h-${i}`} d={d} fill="none" stroke="#38bdf8" strokeWidth={0.5} opacity={0.15} />)}
            {vLines.map((d, i) => <path key={`v-${i}`} d={d} fill="none" stroke="#38bdf8" strokeWidth={0.5} opacity={0.15} />)}
            {/* Circuit traces from CommanderQ to each agent */}
            {HAG_AGENTS.slice(1).map((a, i) => {
              const path = holoCircuitPath(verts, cmdQ.col, cmdQ.row, a.col, a.row, cellW, cellH, 30)
              const dashOffset = -f * 2
              return (
                <g key={`circuit-${i}`}>
                  <path d={path} fill="none" stroke={a.color} strokeWidth={1.5} opacity={0.3} />
                  <path d={path} fill="none" stroke={a.color} strokeWidth={1} opacity={0.7} strokeDasharray="6 8" strokeDashoffset={dashOffset} />
                </g>
              )
            })}
            {/* Data packets traveling along circuits */}
            {HAG_AGENTS.slice(1).map((a, i) => {
              const progress = ((f * 0.02 + i * 0.25) % 1)
              const pc = cmdQ.col + (a.col - cmdQ.col) * progress
              const pr = cmdQ.row + (a.row - cmdQ.row) * progress
              const px = pc * cellW
              const py = holoGetY(verts, pc, pr, cellH)
              return (
                <g key={`pkt-${i}`}>
                  <circle cx={px} cy={py} r={4} fill={a.color} opacity={0.9}>
                    <animate attributeName="r" values="3;5;3" dur="1s" repeatCount="indefinite" />
                  </circle>
                  <circle cx={px} cy={py} r={8} fill={a.color} opacity={0.2} />
                </g>
              )
            })}
            {/* Agent nodes */}
            {HAG_AGENTS.map((a, i) => {
              const ax = a.col * cellW
              const ay = holoGetY(verts, a.col, a.row, cellH)
              const pulse = a.glow ? 1 + Math.sin(f * 0.1) * 0.15 : 1
              const agentReveal = lerp(f, 5 + i * 4, 15 + i * 4, 0, 1)
              return (
                <g key={`agent-${a.name}`} opacity={agentReveal}>
                  {/* Glow */}
                  <circle cx={ax} cy={ay} r={a.r * 3} fill={`url(#hag-glow-${a.name})`} opacity={0.4 + (a.glow ? Math.sin(f * 0.08) * 0.2 : 0)} />
                  {/* Node circle */}
                  <circle cx={ax} cy={ay} r={a.r * pulse} fill="rgba(8,11,20,0.8)" stroke={a.color} strokeWidth={2} />
                  <circle cx={ax} cy={ay} r={a.r * 0.5} fill={a.color} opacity={0.6} />
                  {/* Status dot — green active */}
                  <circle cx={ax + a.r + 4} cy={ay - a.r + 2} r={3} fill="#10b981" />
                  {/* Agent label */}
                  <text x={ax} y={ay - a.r - 10} textAnchor="middle" fill="rgba(255,255,255,0.9)" fontFamily={M} fontSize={a.glow ? 10 : 8} fontWeight={600}>{a.name}</text>
                </g>
              )
            })}
            {/* Title label */}
            <text x={gridW / 2} y={-amp - 18} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontFamily={M} fontSize={9} letterSpacing={2}>STAR TOPOLOGY — 5 AGENTS, 4 CIRCUITS</text>
          </svg>
        </div>
      </div>
    </div>
  )
}

// ─── 2. HOLO HIERARCHY GRID — Hierarchical Topology (3 tiers) ────
const HHG_TIERS = [
  { tier: 0, agents: [{ name: 'QUOX', col: 11, row: 2, color: '#f59e0b', r: 16, glow: true }] },
  { tier: 1, agents: [
    { name: 'WARDEN', col: 4, row: 7, color: '#10b981', r: 11 },
    { name: 'VULCAN', col: 11, row: 7, color: '#3b82f6', r: 11 },
    { name: 'DAEDALUS', col: 18, row: 7, color: '#a855f7', r: 11 },
  ]},
  { tier: 2, agents: [
    { name: 'WARDEN', col: 2, row: 13, color: '#ef4444', r: 7 },
    { name: 'SCOUT', col: 5, row: 13, color: '#06b6d4', r: 7 },
    { name: 'CODEX', col: 8, row: 13, color: '#6366f1', r: 7 },
    { name: 'HYPERION', col: 11, row: 13, color: '#ec4899', r: 7 },
    { name: 'CIPHER', col: 14, row: 13, color: '#f59e0b', r: 7 },
    { name: 'HERALD', col: 17, row: 13, color: '#14b8a6', r: 7 },
  ]},
]

export function HoloHierarchyGrid() {
  const f = useAnimFrame()
  const cols = 22, rows = 16, cellW = 28, cellH = 24, amp = 6
  const gridW = cols * cellW, gridH = rows * cellH
  const t = f * 0.035
  const verts = holoVertices(cols, rows, t, amp)
  const { hLines, vLines } = holoGridLines(cols, rows, cellW, cellH, verts)
  const fadeIn = lerp(f, 0, 20, 0, 1)
  const pad = amp + 30
  const vb = `${-pad} ${-pad - amp - 30} ${gridW + pad * 2} ${gridH + pad * 2 + amp + 30}`
  const allAgents = HHG_TIERS.flatMap(t => t.agents)
  const connections = []
  // Tier 0 → Tier 1
  HHG_TIERS[0].agents.forEach(p => HHG_TIERS[1].agents.forEach(c => connections.push({ from: p, to: c, thick: true })))
  // Tier 1 → Tier 2 (each manager connects to 2 workers)
  HHG_TIERS[1].agents.forEach((p, pi) => {
    const workers = HHG_TIERS[2].agents.slice(pi * 2, pi * 2 + 2)
    workers.forEach(w => connections.push({ from: p, to: w, thick: false }))
  })

  return (
    <div style={{ width: '100%', height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', opacity: fadeIn, contain: 'layout' }}>
      <div style={{ perspective: 800, perspectiveOrigin: '50% 25%' }}>
        <div style={{ transform: 'rotateX(52deg)', transformStyle: 'preserve-3d' }}>
          <svg viewBox={vb} style={{ width: 650, height: 400, overflow: 'visible' }}>
            {/* Grid */}
            {hLines.map((d, i) => <path key={`h-${i}`} d={d} fill="none" stroke="#f59e0b" strokeWidth={0.4} opacity={0.12} />)}
            {vLines.map((d, i) => <path key={`v-${i}`} d={d} fill="none" stroke="#f59e0b" strokeWidth={0.4} opacity={0.12} />)}
            {/* Tier band highlights */}
            {[2, 7, 13].map((tierRow, ti) => {
              const y1 = holoGetY(verts, 0, tierRow - 0.8, cellH)
              const y2 = holoGetY(verts, 0, tierRow + 0.8, cellH)
              return <rect key={`band-${ti}`} x={-10} y={y1} width={gridW + 20} height={y2 - y1} fill={['#f59e0b', '#3b82f6', '#a855f7'][ti]} opacity={0.03} rx={4} />
            })}
            {/* Circuit traces: top→down */}
            {connections.map((conn, i) => {
              const path = holoCircuitPath(verts, conn.from.col, conn.from.row, conn.to.col, conn.to.row, cellW, cellH, 20)
              return (
                <g key={`conn-${i}`}>
                  <path d={path} fill="none" stroke={conn.to.color} strokeWidth={conn.thick ? 1.5 : 1} opacity={0.25} />
                  <path d={path} fill="none" stroke={conn.to.color} strokeWidth={conn.thick ? 1 : 0.6} opacity={0.5} strokeDasharray="5 7" strokeDashoffset={-f * 1.5} />
                  {/* Delegation arrow packets */}
                  {(() => {
                    const progress = ((f * 0.015 + i * 0.12) % 1)
                    const pc = conn.from.col + (conn.to.col - conn.from.col) * progress
                    const pr = conn.from.row + (conn.to.row - conn.from.row) * progress
                    return <circle cx={pc * cellW} cy={holoGetY(verts, pc, pr, cellH)} r={3} fill={conn.to.color} opacity={0.85} />
                  })()}
                </g>
              )
            })}
            {/* Agent nodes */}
            {allAgents.map((a, i) => {
              const ax = a.col * cellW, ay = holoGetY(verts, a.col, a.row, cellH)
              const pulse = a.glow ? 1 + Math.sin(f * 0.1) * 0.12 : 1
              const reveal = lerp(f, 3 + i * 2, 12 + i * 2, 0, 1)
              return (
                <g key={`a-${a.name}`} opacity={reveal}>
                  <circle cx={ax} cy={ay} r={a.r * 2.5} fill={a.color} opacity={0.08 + (a.glow ? Math.sin(f * 0.07) * 0.06 : 0)} />
                  <circle cx={ax} cy={ay} r={a.r * pulse} fill="rgba(8,11,20,0.85)" stroke={a.color} strokeWidth={a.glow ? 2.5 : 1.5} />
                  <circle cx={ax} cy={ay} r={a.r * 0.4} fill={a.color} opacity={0.7} />
                  <circle cx={ax + a.r + 3} cy={ay - a.r + 1} r={2.5} fill="#10b981" />
                  <text x={ax} y={ay - a.r - 8} textAnchor="middle" fill="rgba(255,255,255,0.85)" fontFamily={M} fontSize={a.glow ? 10 : 7} fontWeight={600}>{a.name}</text>
                </g>
              )
            })}
            {/* Labels */}
            <text x={gridW / 2} y={-amp - 18} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontFamily={M} fontSize={9} letterSpacing={2}>HIERARCHICAL — 10 AGENTS, 3 TIERS</text>
            {/* Tier labels on left side */}
            <text x={-20} y={holoGetY(verts, 0, 2, cellH)} fill="rgba(255,255,255,0.4)" fontFamily={M} fontSize={7} textAnchor="end">T0</text>
            <text x={-20} y={holoGetY(verts, 0, 7, cellH)} fill="rgba(255,255,255,0.4)" fontFamily={M} fontSize={7} textAnchor="end">T1</text>
            <text x={-20} y={holoGetY(verts, 0, 13, cellH)} fill="rgba(255,255,255,0.4)" fontFamily={M} fontSize={7} textAnchor="end">T2</text>
          </svg>
        </div>
      </div>
    </div>
  )
}

// ─── 3. HOLO PIPELINE GRID — Pipeline/CI-CD Topology ─────────────
const HPG_STAGES = [
  { name: 'VULCAN', stage: 'Code', col: 3, row: 5, color: '#3b82f6', status: 'complete' },
  { name: 'CODEX', stage: 'Build', col: 8, row: 5, color: '#6366f1', status: 'complete' },
  { name: 'WARDEN', stage: 'Test', col: 13, row: 5, color: '#10b981', status: 'complete' },
  { name: 'DAEDALUS', stage: 'Stage', col: 18, row: 5, color: '#a855f7', status: 'active' },
  { name: 'VULCAN', stage: 'Deploy', col: 23, row: 5, color: '#f59e0b', status: 'pending' },
]

export function HoloPipelineGrid() {
  const f = useAnimFrame()
  const cols = 26, rows = 10, cellW = 24, cellH = 28, amp = 6
  const gridW = cols * cellW, gridH = rows * cellH
  const t = f * 0.03
  const verts = holoVertices(cols, rows, t, amp)
  const { hLines, vLines } = holoGridLines(cols, rows, cellW, cellH, verts)
  const fadeIn = lerp(f, 0, 20, 0, 1)
  const pad = amp + 30
  const vb = `${-pad} ${-pad - amp - 40} ${gridW + pad * 2} ${gridH + pad * 2 + amp + 60}`

  const statusColor = (s) => s === 'complete' ? '#10b981' : s === 'active' ? '#38bdf8' : 'rgba(255,255,255,0.3)'
  const activeStage = HPG_STAGES.findIndex(s => s.status === 'active')

  return (
    <div style={{ width: '100%', height: 380, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', opacity: fadeIn, contain: 'layout' }}>
      <div style={{ perspective: 800, perspectiveOrigin: '50% 35%' }}>
        <div style={{ transform: 'rotateX(50deg)', transformStyle: 'preserve-3d' }}>
          <svg viewBox={vb} style={{ width: 650, height: 340, overflow: 'visible' }}>
            {/* Grid */}
            {hLines.map((d, i) => <path key={`h-${i}`} d={d} fill="none" stroke="#30ff90" strokeWidth={0.4} opacity={0.1} />)}
            {vLines.map((d, i) => <path key={`v-${i}`} d={d} fill="none" stroke="#30ff90" strokeWidth={0.4} opacity={0.1} />)}
            {/* Heavy pipeline trace connecting all stages */}
            {HPG_STAGES.slice(0, -1).map((s, i) => {
              const next = HPG_STAGES[i + 1]
              const path = holoCircuitPath(verts, s.col, s.row, next.col, next.row, cellW, cellH, 30)
              const isComplete = s.status === 'complete' && next.status !== 'pending'
              const isActive = s.status === 'active' || next.status === 'active'
              return (
                <g key={`pipe-${i}`}>
                  <path d={path} fill="none" stroke={isComplete ? '#10b981' : isActive ? '#38bdf8' : 'rgba(255,255,255,0.15)'} strokeWidth={3} opacity={isComplete ? 0.4 : 0.2} />
                  <path d={path} fill="none" stroke={isComplete ? '#10b981' : isActive ? '#38bdf8' : 'rgba(255,255,255,0.1)'} strokeWidth={1.5} opacity={0.8} strokeDasharray={isActive ? '8 6' : isComplete ? 'none' : '4 8'} strokeDashoffset={isActive ? -f * 3 : 0} />
                  {/* Data pulse flowing left to right */}
                  {(isComplete || isActive) && (() => {
                    const progress = ((f * 0.025 + i * 0.2) % 1)
                    const pc = s.col + (next.col - s.col) * progress
                    const pr = s.row + (next.row - s.row) * progress
                    return <circle cx={pc * cellW} cy={holoGetY(verts, pc, pr, cellH)} r={isActive ? 5 : 3} fill={isComplete ? '#10b981' : '#38bdf8'} opacity={0.9}>
                      {isActive && <animate attributeName="r" values="4;6;4" dur="0.8s" repeatCount="indefinite" />}
                    </circle>
                  })()}
                </g>
              )
            })}
            {/* Stage nodes */}
            {HPG_STAGES.map((s, i) => {
              const ax = s.col * cellW, ay = holoGetY(verts, s.col, s.row, cellH)
              const isActive = s.status === 'active'
              const pulse = isActive ? 1 + Math.sin(f * 0.12) * 0.1 : 1
              const reveal = lerp(f, 3 + i * 4, 14 + i * 4, 0, 1)
              const sc = statusColor(s.status)
              return (
                <g key={`stage-${i}`} opacity={reveal}>
                  {/* Glow for active */}
                  {isActive && <circle cx={ax} cy={ay} r={30} fill="#38bdf8" opacity={0.06 + Math.sin(f * 0.08) * 0.04} />}
                  {/* Node */}
                  <circle cx={ax} cy={ay} r={12 * pulse} fill="rgba(8,11,20,0.85)" stroke={sc} strokeWidth={isActive ? 2.5 : s.status === 'complete' ? 2 : 1} />
                  <circle cx={ax} cy={ay} r={5} fill={sc} opacity={s.status === 'pending' ? 0.3 : 0.7} />
                  {/* Status check for complete */}
                  {s.status === 'complete' && <text x={ax} y={ay + 4} textAnchor="middle" fill="#10b981" fontSize={12} fontWeight={700}>&#10003;</text>}
                  {/* Labels */}
                  <text x={ax} y={ay - 18} textAnchor="middle" fill="rgba(255,255,255,0.85)" fontFamily={M} fontSize={8} fontWeight={600}>{s.name}</text>
                  <text x={ax} y={ay + 22} textAnchor="middle" fill="rgba(255,255,255,0.6)" fontFamily={M} fontSize={7}>{s.stage}</text>
                  {/* Stage number */}
                  <text x={ax} y={ay + 34} textAnchor="middle" fill={sc} fontFamily={M} fontSize={7} fontWeight={600}>Stage {i + 1}</text>
                </g>
              )
            })}
            {/* Title */}
            <text x={gridW / 2} y={-amp - 22} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontFamily={M} fontSize={9} letterSpacing={2}>PIPELINE — 5 STAGES, SEQUENTIAL FLOW</text>
            {/* Progress bar at bottom */}
            {(() => {
              const barY = gridH + amp + 20
              const barW = gridW * 0.6
              const barX = (gridW - barW) / 2
              const progress = (activeStage + 0.5) / HPG_STAGES.length
              return (
                <g>
                  <rect x={barX} y={barY} width={barW} height={6} rx={3} fill="rgba(255,255,255,0.06)" />
                  <rect x={barX} y={barY} width={barW * progress} height={6} rx={3} fill="#38bdf8" opacity={0.7} />
                  <text x={gridW / 2} y={barY + 18} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontFamily={M} fontSize={8}>Stage {activeStage + 1}/{HPG_STAGES.length} — {HPG_STAGES[activeStage].stage}</text>
                </g>
              )
            })()}
          </svg>
        </div>
      </div>
    </div>
  )
}

// ─── 4. HOLO MESH GRID — Mesh Topology (all interconnected) ──────
const HMG_AGENTS = [
  { name: 'WARDEN', col: 9, row: 2, color: '#10b981' },
  { name: 'VULCAN', col: 15, row: 2, color: '#3b82f6' },
  { name: 'DAEDALUS', col: 17, row: 6, color: '#a855f7' },
  { name: 'CIPHER', col: 13, row: 10, color: '#f59e0b' },
  { name: 'CODEX', col: 5, row: 10, color: '#6366f1' },
  { name: 'HYPERION', col: 3, row: 6, color: '#ec4899' },
]
const HMG_ACTIVE_PAIRS = [['WARDEN', 'CIPHER'], ['DAEDALUS', 'VULCAN'], ['HYPERION', 'CODEX'], ['WARDEN', 'DAEDALUS']]

export function HoloMeshGrid() {
  const f = useAnimFrame()
  const cols = 20, rows = 12, cellW = 30, cellH = 28, amp = 7
  const gridW = cols * cellW, gridH = rows * cellH
  const t = f * 0.04
  const verts = holoVertices(cols, rows, t, amp)
  const { hLines, vLines } = holoGridLines(cols, rows, cellW, cellH, verts)
  const fadeIn = lerp(f, 0, 20, 0, 1)
  const pad = amp + 30
  const vb = `${-pad} ${-pad - amp - 30} ${gridW + pad * 2} ${gridH + pad * 2 + amp + 30}`

  // Generate all mesh connections (every agent to every other)
  const connections = []
  for (let i = 0; i < HMG_AGENTS.length; i++) {
    for (let j = i + 1; j < HMG_AGENTS.length; j++) {
      const a = HMG_AGENTS[i], b = HMG_AGENTS[j]
      const isActive = HMG_ACTIVE_PAIRS.some(([x, y]) => (x === a.name && y === b.name) || (x === b.name && y === a.name))
      connections.push({ from: a, to: b, active: isActive })
    }
  }
  const activeCount = connections.filter(c => c.active).length

  return (
    <div style={{ width: '100%', height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', opacity: fadeIn, contain: 'layout' }}>
      <div style={{ perspective: 800, perspectiveOrigin: '50% 30%' }}>
        <div style={{ transform: 'rotateX(54deg)', transformStyle: 'preserve-3d' }}>
          <svg viewBox={vb} style={{ width: 650, height: 370, overflow: 'visible' }}>
            {/* Grid with subtle hex overlay */}
            {hLines.map((d, i) => <path key={`h-${i}`} d={d} fill="none" stroke="#a855f7" strokeWidth={0.4} opacity={0.12} />)}
            {vLines.map((d, i) => <path key={`v-${i}`} d={d} fill="none" stroke="#a855f7" strokeWidth={0.4} opacity={0.12} />)}
            {/* Hex pattern overlay on some cells */}
            {[3, 6, 9, 12, 15].map(c => [3, 6, 9].map(r => {
              const hx = c * cellW, hy = holoGetY(verts, c, r, cellH)
              const hr = 10
              const hex = Array.from({ length: 6 }, (_, k) => {
                const angle = (Math.PI / 3) * k - Math.PI / 6
                return `${hx + hr * Math.cos(angle)},${hy + hr * Math.sin(angle)}`
              }).join(' ')
              return <polygon key={`hex-${c}-${r}`} points={hex} fill="none" stroke="#a855f7" strokeWidth={0.3} opacity={0.08} />
            })).flat()}
            {/* Mesh connections */}
            {connections.map((conn, i) => {
              const path = holoCircuitPath(verts, conn.from.col, conn.from.row, conn.to.col, conn.to.row, cellW, cellH, 20)
              return (
                <g key={`mesh-${i}`}>
                  <path d={path} fill="none" stroke={conn.active ? conn.from.color : 'rgba(255,255,255,0.15)'} strokeWidth={conn.active ? 2 : 0.5} opacity={conn.active ? 0.5 : 0.15} />
                  {conn.active && <path d={path} fill="none" stroke={conn.from.color} strokeWidth={1} opacity={0.8} strokeDasharray="6 6" strokeDashoffset={-f * 2} />}
                  {/* Bidirectional data packets on active connections */}
                  {conn.active && [0.3, 0.7].map((baseP, pi) => {
                    const progress = ((f * 0.02 + i * 0.15 + baseP) % 1)
                    const dir = pi === 0 ? 1 : -1
                    const p = dir === 1 ? progress : 1 - progress
                    const pc = conn.from.col + (conn.to.col - conn.from.col) * p
                    const pr = conn.from.row + (conn.to.row - conn.from.row) * p
                    return <circle key={`pkt-${pi}`} cx={pc * cellW} cy={holoGetY(verts, pc, pr, cellH)} r={3} fill={pi === 0 ? conn.from.color : conn.to.color} opacity={0.9} />
                  })}
                </g>
              )
            })}
            {/* Agent nodes */}
            {HMG_AGENTS.map((a, i) => {
              const ax = a.col * cellW, ay = holoGetY(verts, a.col, a.row, cellH)
              const reveal = lerp(f, 2 + i * 3, 12 + i * 3, 0, 1)
              return (
                <g key={`a-${a.name}`} opacity={reveal}>
                  <circle cx={ax} cy={ay} r={24} fill={a.color} opacity={0.06} />
                  <circle cx={ax} cy={ay} r={11} fill="rgba(8,11,20,0.85)" stroke={a.color} strokeWidth={2} />
                  <circle cx={ax} cy={ay} r={5} fill={a.color} opacity={0.7} />
                  <circle cx={ax + 13} cy={ay - 9} r={2.5} fill="#10b981" />
                  <text x={ax} y={ay - 16} textAnchor="middle" fill="rgba(255,255,255,0.85)" fontFamily={M} fontSize={8} fontWeight={600}>{a.name}</text>
                </g>
              )
            })}
            {/* Title */}
            <text x={gridW / 2} y={-amp - 18} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontFamily={M} fontSize={9} letterSpacing={2}>MESH — {HMG_AGENTS.length} AGENTS, {connections.length} CONNECTIONS, {activeCount} ACTIVE</text>
          </svg>
        </div>
      </div>
    </div>
  )
}

// ─── 5. HOLO BATTLEFIELD — Full Operations View on 3D Grid ───────
const HBF_INFRA = [
  { name: 'edge-01', col: 3, row: 5, color: '#2496ed', status: 'online' },
  { name: 'edge-02', col: 3, row: 9, color: '#2496ed', status: 'online' },
  { name: 'edge-03', col: 3, row: 13, color: '#f59e0b', status: 'warning' },
]
const HBF_AGENTS = [
  { name: 'CommanderQ', col: 13, row: 5, color: '#a855f7', r: 13, glow: true },
  { name: 'WARDEN', col: 10, row: 9, color: '#10b981', r: 8 },
  { name: 'VULCAN', col: 16, row: 9, color: '#3b82f6', r: 8 },
  { name: 'DAEDALUS', col: 10, row: 13, color: '#a855f7', r: 8 },
  { name: 'CIPHER', col: 16, row: 13, color: '#f59e0b', r: 8 },
]
const HBF_STORES = [
  { name: 'Postgres', col: 24, row: 6, color: '#336791' },
  { name: 'Qdrant', col: 24, row: 12, color: '#dc2626' },
]

export function HoloBattlefield() {
  const f = useAnimFrame()
  const cols = 28, rows = 18, cellW = 22, cellH = 22, amp = 5
  const gridW = cols * cellW, gridH = rows * cellH
  const t = f * 0.03
  const verts = holoVertices(cols, rows, t, amp)
  const { hLines, vLines } = holoGridLines(cols, rows, cellW, cellH, verts)
  const fadeIn = lerp(f, 0, 25, 0, 1)
  const pad = amp + 40
  const vb = `${-pad} ${-pad - amp - 50} ${gridW + pad * 2} ${gridH + pad * 2 + amp + 70}`

  const cmdQ = HBF_AGENTS[0]

  // Data flow colors per type
  const flowColors = { infra: '#2496ed', agent: '#a855f7', store: '#dc2626' }

  return (
    <div style={{ width: '100%', height: 480, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', opacity: fadeIn, contain: 'layout' }}>
      <div style={{ perspective: 900, perspectiveOrigin: '50% 28%' }}>
        <div style={{ transform: 'rotateX(52deg)', transformStyle: 'preserve-3d' }}>
          <svg viewBox={vb} style={{ width: 700, height: 450, overflow: 'visible' }}>
            <defs>
              <linearGradient id="hbf-grid-grad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="50%" stopColor="#a855f7" />
                <stop offset="100%" stopColor="#38bdf8" />
              </linearGradient>
            </defs>
            {/* Grid — cyan→purple gradient lines */}
            {hLines.map((d, i) => {
              const pct = i / rows
              const col = pct < 0.5 ? '#38bdf8' : '#a855f7'
              return <path key={`h-${i}`} d={d} fill="none" stroke={col} strokeWidth={0.4} opacity={0.1} />
            })}
            {vLines.map((d, i) => <path key={`v-${i}`} d={d} fill="none" stroke="url(#hbf-grid-grad)" strokeWidth={0.3} opacity={0.1} />)}

            {/* Zone labels (floating above) */}
            <text x={3 * cellW} y={holoGetY(verts, 3, 2.5, cellH) - 8} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={7} letterSpacing={1}>INFRASTRUCTURE</text>
            <text x={13 * cellW} y={holoGetY(verts, 13, 2.5, cellH) - 8} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={7} letterSpacing={1}>AGENT CLUSTER</text>
            <text x={24 * cellW} y={holoGetY(verts, 24, 2.5, cellH) - 8} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={7} letterSpacing={1}>DATA STORES</text>

            {/* Infrastructure nodes — rectangular blocks */}
            {HBF_INFRA.map((node, i) => {
              const nx = node.col * cellW, ny = holoGetY(verts, node.col, node.row, cellH)
              const isWarn = node.status === 'warning'
              const pulse = isWarn ? 0.5 + Math.sin(f * 0.15) * 0.4 : 0.7
              const reveal = lerp(f, 4 + i * 3, 14 + i * 3, 0, 1)
              return (
                <g key={`infra-${i}`} opacity={reveal}>
                  {isWarn && <rect x={nx - 22} y={ny - 14} width={44} height={28} rx={4} fill="#f59e0b" opacity={0.08 + Math.sin(f * 0.1) * 0.05} />}
                  <rect x={nx - 20} y={ny - 12} width={40} height={24} rx={3} fill="rgba(8,11,20,0.85)" stroke={node.color} strokeWidth={isWarn ? 2 : 1.5} opacity={pulse} />
                  <circle cx={nx + 14} cy={ny - 6} r={2} fill={isWarn ? '#f59e0b' : '#10b981'} />
                  <text x={nx} y={ny + 3} textAnchor="middle" fill="rgba(255,255,255,0.8)" fontFamily={M} fontSize={6} fontWeight={600}>{node.name}</text>
                </g>
              )
            })}

            {/* Data store blocks — tall rectangles (cylinder-like) */}
            {HBF_STORES.map((store, i) => {
              const sx = store.col * cellW, sy = holoGetY(verts, store.col, store.row, cellH)
              const reveal = lerp(f, 8 + i * 4, 18 + i * 4, 0, 1)
              return (
                <g key={`store-${i}`} opacity={reveal}>
                  <rect x={sx - 18} y={sy - 20} width={36} height={40} rx={4} fill="rgba(8,11,20,0.85)" stroke={store.color} strokeWidth={1.5} />
                  {/* Cylinder top ellipse */}
                  <ellipse cx={sx} cy={sy - 18} rx={16} ry={4} fill="rgba(8,11,20,0.9)" stroke={store.color} strokeWidth={1} />
                  <text x={sx} y={sy + 4} textAnchor="middle" fill="rgba(255,255,255,0.8)" fontFamily={M} fontSize={6} fontWeight={600}>{store.name}</text>
                </g>
              )
            })}

            {/* Circuit traces: infra → agents */}
            {HBF_INFRA.map((node, i) => {
              const target = HBF_AGENTS[Math.min(i + 1, HBF_AGENTS.length - 1)]
              const path = holoCircuitPath(verts, node.col, node.row, target.col, target.row, cellW, cellH, 20)
              const progress = ((f * 0.018 + i * 0.3) % 1)
              const pc = node.col + (target.col - node.col) * progress
              const pr = node.row + (target.row - node.row) * progress
              return (
                <g key={`ic-${i}`}>
                  <path d={path} fill="none" stroke={flowColors.infra} strokeWidth={1} opacity={0.2} />
                  <path d={path} fill="none" stroke={flowColors.infra} strokeWidth={0.7} opacity={0.5} strokeDasharray="4 6" strokeDashoffset={-f * 1.5} />
                  <circle cx={pc * cellW} cy={holoGetY(verts, pc, pr, cellH)} r={2.5} fill={flowColors.infra} opacity={0.9} />
                </g>
              )
            })}

            {/* Circuit traces: agents → stores (star from CommanderQ) */}
            {HBF_AGENTS.slice(1).map((a, i) => {
              const path = holoCircuitPath(verts, cmdQ.col, cmdQ.row, a.col, a.row, cellW, cellH, 16)
              return (
                <g key={`ac-${i}`}>
                  <path d={path} fill="none" stroke={a.color} strokeWidth={0.8} opacity={0.2} />
                  <path d={path} fill="none" stroke={a.color} strokeWidth={0.5} opacity={0.6} strokeDasharray="3 5" strokeDashoffset={-f * 1.2} />
                </g>
              )
            })}
            {HBF_STORES.map((store, i) => {
              const path = holoCircuitPath(verts, cmdQ.col, cmdQ.row, store.col, store.row, cellW, cellH, 20)
              const progress = ((f * 0.02 + i * 0.5) % 1)
              const pc = cmdQ.col + (store.col - cmdQ.col) * progress
              const pr = cmdQ.row + (store.row - cmdQ.row) * progress
              return (
                <g key={`sc-${i}`}>
                  <path d={path} fill="none" stroke={store.color} strokeWidth={1} opacity={0.25} />
                  <path d={path} fill="none" stroke={store.color} strokeWidth={0.7} opacity={0.6} strokeDasharray="5 5" strokeDashoffset={-f * 1.8} />
                  <circle cx={pc * cellW} cy={holoGetY(verts, pc, pr, cellH)} r={2.5} fill={store.color} opacity={0.85} />
                </g>
              )
            })}

            {/* Agent nodes */}
            {HBF_AGENTS.map((a, i) => {
              const ax = a.col * cellW, ay = holoGetY(verts, a.col, a.row, cellH)
              const pulse = a.glow ? 1 + Math.sin(f * 0.1) * 0.12 : 1
              const reveal = lerp(f, 6 + i * 2, 16 + i * 2, 0, 1)
              return (
                <g key={`ba-${a.name}`} opacity={reveal}>
                  {a.glow && <circle cx={ax} cy={ay} r={a.r * 2.5} fill={a.color} opacity={0.06 + Math.sin(f * 0.07) * 0.04} />}
                  <circle cx={ax} cy={ay} r={a.r * pulse} fill="rgba(8,11,20,0.85)" stroke={a.color} strokeWidth={a.glow ? 2 : 1.5} />
                  <circle cx={ax} cy={ay} r={a.r * 0.4} fill={a.color} opacity={0.6} />
                  <circle cx={ax + a.r + 3} cy={ay - a.r + 2} r={2} fill="#10b981" />
                  <text x={ax} y={ay - a.r - 7} textAnchor="middle" fill="rgba(255,255,255,0.85)" fontFamily={M} fontSize={a.glow ? 8 : 7} fontWeight={600}>{a.name}</text>
                </g>
              )
            })}

            {/* Floating status panels above zones */}
            {[
              { x: 3, y: 3, text: '3 hosts online', color: '#2496ed', warn: '1 warning' },
              { x: 13, y: 3, text: '5 agents active', color: '#a855f7' },
              { x: 24, y: 3, text: '2 stores synced', color: '#336791' },
            ].map((panel, i) => {
              const px = panel.x * cellW, py = holoGetY(verts, panel.x, panel.y, cellH) - 30
              const reveal = lerp(f, 15 + i * 3, 25 + i * 3, 0, 1)
              return (
                <g key={`panel-${i}`} opacity={reveal}>
                  <rect x={px - 40} y={py - 10} width={80} height={panel.warn ? 28 : 18} rx={4} fill="rgba(8,11,20,0.7)" stroke={panel.color} strokeWidth={0.5} opacity={0.8} />
                  <text x={px} y={py + 2} textAnchor="middle" fill={panel.color} fontFamily={M} fontSize={7} fontWeight={600}>{panel.text}</text>
                  {panel.warn && <text x={px} y={py + 14} textAnchor="middle" fill="#f59e0b" fontFamily={M} fontSize={6}>{panel.warn}</text>}
                </g>
              )
            })}

            {/* Title */}
            <text x={gridW / 2} y={-amp - 35} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontFamily={M} fontSize={9} letterSpacing={2}>OPERATIONS BATTLEFIELD — FULL STACK VIEW</text>

            {/* Bottom metric strip */}
            {(() => {
              const my = gridH + amp + 25
              const reveal = lerp(f, 20, 30, 0, 1)
              const metrics = [
                { label: 'CPU', value: '23%', color: '#30ff90' },
                { label: 'MEM', value: '62%', color: '#38bdf8' },
                { label: 'Tasks', value: '12', color: '#a855f7' },
                { label: 'Tokens', value: '4.2K', color: '#f59e0b' },
              ]
              return (
                <g opacity={reveal}>
                  <rect x={gridW * 0.15} y={my - 10} width={gridW * 0.7} height={20} rx={6} fill="rgba(8,11,20,0.6)" stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />
                  {metrics.map((m, i) => {
                    const mx = gridW * 0.15 + 30 + i * (gridW * 0.7 - 60) / 3
                    return (
                      <g key={`m-${i}`}>
                        <text x={mx} y={my + 1} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={6}>{m.label}</text>
                        <text x={mx + 24} y={my + 1} textAnchor="middle" fill={m.color} fontFamily={M} fontSize={7} fontWeight={700}>{m.value}</text>
                      </g>
                    )
                  })}
                </g>
              )
            })()}
          </svg>
        </div>
      </div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// OPSDECK 3D CONCEPT ART — Cognitive Core Visualization Suite
// ═══════════════════════════════════════════════════════════════

// ─── 1. CognitiveCoreMap — Full Scene Overview (Top-Down) ───
export function CognitiveCoreMap() {
  const f = useAnimFrame()
  const W = 500, H = 500, cx = W / 2, cy = H / 2
  const rot = f * 0.003
  const pulse = 0.6 + Math.sin(f * 0.06) * 0.4

  // Fibonacci spiral positions for agent mesh
  const agentDots = Array.from({ length: 16 }, (_, i) => {
    const phi = (1 + Math.sqrt(5)) / 2
    const theta = 2 * Math.PI * i / phi + rot * 0.5
    const r = 12 + (i / 16) * 6
    const scale = r * 8
    const states = ['dim','dim','dim','dim','dim','dim','dim','dim','indigo','indigo','indigo','indigo','green','green','red','amber']
    const colors = { dim: 'rgba(255,255,255,0.2)', indigo: '#818cf8', green: '#30ff90', red: '#ef4444', amber: '#f59e0b' }
    return { x: cx + Math.cos(theta) * scale, y: cy + Math.sin(theta) * scale, color: colors[states[i]], state: states[i] }
  })

  // Objective clusters in execution layer
  const objClusters = [
    { angle: rot * 0.3 + 0.8, r: 200, tasks: 5 },
    { angle: rot * 0.3 + 3.5, r: 220, tasks: 4 },
  ]

  // Memory crystals
  const crystals = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2 + rot * 0.2
    const r = 155 + Math.sin(i * 1.7) * 20
    const types = ['rose','indigo','violet','cyan','amber','rose','indigo','violet','cyan','amber','rose','indigo']
    const cols = { rose: '#ec4899', indigo: '#818cf8', violet: '#a78bfa', cyan: '#22d3ee', amber: '#f59e0b' }
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, color: cols[types[i]], type: types[i] }
  })

  // Shell health segments
  const shellSegs = 12
  const shellHealth = [95,88,92,97,91,85,78,96,90,94,82,87]
  const shellColors = ['#a78bfa','#ec4899','#818cf8','#30ff90','#22d3ee','#3b82f6','#f59e0b','#30ff90','#818cf8','#a78bfa','#22d3ee','#3b82f6']

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>COGNITIVE CORE MAP — ORBITAL VIEW</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: 'radial-gradient(circle at 50% 50%, rgba(15,10,30,1) 0%, rgba(5,2,15,1) 100%)', borderRadius: 8 }}>
        <defs>
          <radialGradient id="ccm-nucleus-glow"><stop offset="0%" stopColor="#818cf8" stopOpacity="0.8"/><stop offset="50%" stopColor="#6366f1" stopOpacity="0.3"/><stop offset="100%" stopColor="transparent" stopOpacity="0"/></radialGradient>
          <filter id="ccm-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="ccm-glow-lg"><feGaussianBlur stdDeviation="6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>

        {/* Zone labels */}
        <text x={cx} y={30} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontFamily={M} fontSize={8} letterSpacing={2}>CORE SHELL</text>
        <text x={cx + 120} y={cy - 140} textAnchor="start" fill="rgba(255,255,255,0.25)" fontFamily={M} fontSize={7}>MEMORY LATTICE</text>
        <text x={cx + 80} y={cy - 80} textAnchor="start" fill="rgba(255,255,255,0.25)" fontFamily={M} fontSize={7}>EXECUTION LAYER</text>
        <text x={cx + 55} y={cy - 35} textAnchor="start" fill="rgba(255,255,255,0.25)" fontFamily={M} fontSize={7}>AGENT MESH</text>

        {/* Zone 5: Core Shell — 12 arc segments */}
        {Array.from({ length: shellSegs }, (_, i) => {
          const a1 = (i / shellSegs) * Math.PI * 2 - Math.PI / 2 + rot * 0.1
          const a2 = ((i + 0.85) / shellSegs) * Math.PI * 2 - Math.PI / 2 + rot * 0.1
          const r = 195
          const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r
          const x2 = cx + Math.cos(a2) * r, y2 = cy + Math.sin(a2) * r
          const op = (shellHealth[i] / 100) * 0.8
          return <path key={`shell-${i}`} d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`} fill="none" stroke={shellColors[i]} strokeWidth={3} opacity={op} filter="url(#ccm-glow)"/>
        })}

        {/* Zone 4: Memory crystals */}
        {crystals.map((c, i) => {
          const sz = 4 + Math.sin(i * 2.3) * 2
          return <g key={`crys-${i}`} opacity={0.7}>
            <polygon points={`${c.x},${c.y - sz} ${c.x + sz},${c.y + sz * 0.6} ${c.x - sz},${c.y + sz * 0.6}`} fill="none" stroke={c.color} strokeWidth={1} filter="url(#ccm-glow)"/>
          </g>
        })}

        {/* Zone 3: Execution clusters */}
        {objClusters.map((cl, ci) => {
          const ox = cx + Math.cos(cl.angle) * cl.r * 0.45
          const oy = cy + Math.sin(cl.angle) * cl.r * 0.45
          return <g key={`obj-${ci}`}>
            <circle cx={ox} cy={oy} r={8} fill="none" stroke="#818cf8" strokeWidth={1.5} opacity={0.6} filter="url(#ccm-glow)"/>
            {Array.from({ length: cl.tasks }, (_, ti) => {
              const ta = (ti / cl.tasks) * Math.PI * 2 + f * 0.02 * (ci + 1)
              const tr = 16 + ti * 3
              return <circle key={ti} cx={ox + Math.cos(ta) * tr} cy={oy + Math.sin(ta) * tr} r={2} fill={ti < 2 ? '#30ff90' : 'rgba(255,255,255,0.2)'} filter="url(#ccm-glow)"/>
            })}
          </g>
        })}

        {/* Zone 2: Agent mesh dots */}
        {agentDots.map((a, i) => (
          <circle key={`ag-${i}`} cx={a.x} cy={a.y} r={a.state === 'dim' ? 2 : 3} fill={a.color} filter={a.state !== 'dim' ? 'url(#ccm-glow)' : undefined}/>
        ))}

        {/* Delegation arcs */}
        <path d={`M ${cx} ${cy} Q ${cx + 40} ${cy - 60} ${agentDots[8].x} ${agentDots[8].y}`} fill="none" stroke="#22d3ee" strokeWidth={1} opacity={0.6} filter="url(#ccm-glow)" strokeDasharray="4 3"/>
        <path d={`M ${cx} ${cy} Q ${cx - 30} ${cy + 50} ${agentDots[12].x} ${agentDots[12].y}`} fill="none" stroke="#22d3ee" strokeWidth={1} opacity={0.5} filter="url(#ccm-glow)" strokeDasharray="4 3"/>

        {/* Focus beam */}
        <line x1={cx} y1={cy} x2={cx + Math.cos(rot * 2) * 200} y2={cy + Math.sin(rot * 2) * 200} stroke="#818cf8" strokeWidth={0.5} opacity={0.15}/>

        {/* Zone 1: Nucleus */}
        <circle cx={cx} cy={cy} r={40} fill="url(#ccm-nucleus-glow)"/>
        <circle cx={cx} cy={cy} r={5} fill="#818cf8" opacity={pulse} filter="url(#ccm-glow-lg)"/>
        {/* Orbital rings */}
        {[12, 18, 24].map((r, i) => (
          <ellipse key={`orb-${i}`} cx={cx} cy={cy} rx={r} ry={r * 0.4} fill="none" stroke="#818cf8" strokeWidth={0.5} opacity={0.3} transform={`rotate(${i * 60 + f * 0.3} ${cx} ${cy})`}/>
        ))}
        <text x={cx} y={cy + 3} textAnchor="middle" fill="rgba(255,255,255,0.8)" fontFamily={M} fontSize={6} fontWeight={700}>NUCLEUS</text>

        {/* Stats bar */}
        <rect x={W * 0.1} y={H - 30} width={W * 0.8} height={18} rx={4} fill="rgba(8,11,20,0.7)" stroke="rgba(255,255,255,0.08)" strokeWidth={0.5}/>
        <text x={W * 0.15} y={H - 18} fill="rgba(255,255,255,0.6)" fontFamily={M} fontSize={7}>5 zones</text>
        <text x={W * 0.35} y={H - 18} fill="#818cf8" fontFamily={M} fontSize={7}>16 agents</text>
        <text x={W * 0.55} y={H - 18} fill="#22d3ee" fontFamily={M} fontSize={7}>2 objectives</text>
        <text x={W * 0.75} y={H - 18} fill="#a78bfa" fontFamily={M} fontSize={7}>12 implants</text>
      </svg>
    </div>
  )
}

// ─── 2. AgentMeshConstellation — The Agent Constellation ───
export function AgentMeshConstellation() {
  const f = useAnimFrame()
  const W = 600, H = 400, cx = W / 2, cy = H / 2

  const agents = [
    { id: 'QUOX', role: 'orchestrator', x: cx, y: cy, r: 10, color: '#a78bfa', shape: 'ico', state: 'thinking' },
    { id: 'WARDEN', role: 'manager', x: cx - 70, y: cy - 50, r: 7, color: '#10b981', shape: 'oct', state: 'executing' },
    { id: 'DAEDALUS', role: 'manager', x: cx + 80, y: cy - 40, r: 7, color: '#38bdf8', shape: 'oct', state: 'thinking' },
    { id: 'CIPHER', role: 'manager', x: cx + 10, y: cy - 80, r: 7, color: '#f59e0b', shape: 'oct', state: 'thinking' },
    { id: 'VULCAN', role: 'specialist', x: cx - 130, y: cy - 20, r: 5, color: '#3b82f6', shape: 'tet', state: 'executing' },
    { id: 'HYPERION', role: 'specialist', x: cx - 100, y: cy + 60, r: 5, color: '#8b5cf6', shape: 'tet', state: 'idle' },
    { id: 'MESHNET', role: 'specialist', x: cx - 40, y: cy + 80, r: 5, color: '#06b6d4', shape: 'tet', state: 'idle' },
    { id: 'NETWATCH', role: 'specialist', x: cx + 50, y: cy + 70, r: 5, color: '#ec4899', shape: 'tet', state: 'idle' },
    { id: 'CODEX', role: 'specialist', x: cx + 130, y: cy + 30, r: 5, color: '#6366f1', shape: 'tet', state: 'idle' },
    { id: 'METRICS', role: 'specialist', x: cx + 120, y: cy - 80, r: 5, color: '#14b8a6', shape: 'tet', state: 'idle' },
    { id: 'INSIGHT', role: 'specialist', x: cx - 50, y: cy - 100, r: 5, color: '#30ff90', shape: 'tet', state: 'idle' },
    { id: 'ORACLE', role: 'specialist', x: cx + 160, y: cy - 10, r: 5, color: '#f97316', shape: 'tet', state: 'idle' },
    { id: 'VIGIL', role: 'specialist', x: cx - 160, y: cy + 40, r: 5, color: '#eab308', shape: 'tet', state: 'blocked' },
    { id: 'COREY', role: 'specialist', x: cx - 20, y: cy + 120, r: 5, color: '#a855f7', shape: 'tet', state: 'idle' },
    { id: 'YOUTUBE', role: 'plugin', x: cx + 170, y: cy + 80, r: 6, color: '#ef4444', shape: 'dod', state: 'thinking' },
    { id: 'LINKEDIN', role: 'plugin', x: cx - 170, y: cy + 100, r: 6, color: '#0077b5', shape: 'dod', state: 'idle' },
  ]

  const stateColors = { idle: 'rgba(255,255,255,0.2)', thinking: '#818cf8', executing: '#30ff90', blocked: '#ef4444' }

  // Connection lines between agents that can delegate
  const connections = [
    [0,1],[0,2],[0,3],[0,4],[0,5],[1,4],[1,10],[2,9],[2,8],[3,5],[3,11]
  ]

  // Active delegation arcs
  const delegations = [
    { from: 0, to: 1, label: 'scan edge-03' },
    { from: 0, to: 4, label: 'deploy v2.4' },
  ]

  const scanRing = (x, y, r, speed) => {
    const a = f * speed
    return { cx: x + Math.cos(a) * (r + 4), cy: y + Math.sin(a) * (r + 4) }
  }

  const renderShape = (ag) => {
    const col = stateColors[ag.state] || ag.color
    const glow = ag.state !== 'idle'
    if (ag.shape === 'ico') {
      // Icosahedron approximation — hexagon
      const pts = Array.from({length:6}, (_,i) => {
        const a = i * Math.PI / 3
        return `${ag.x + Math.cos(a) * ag.r},${ag.y + Math.sin(a) * ag.r}`
      }).join(' ')
      return <polygon points={pts} fill="none" stroke={col} strokeWidth={1.5} filter={glow ? 'url(#amc-glow)' : undefined}/>
    }
    if (ag.shape === 'oct') {
      const pts = Array.from({length:8}, (_,i) => {
        const a = i * Math.PI / 4
        return `${ag.x + Math.cos(a) * ag.r},${ag.y + Math.sin(a) * ag.r}`
      }).join(' ')
      return <polygon points={pts} fill="none" stroke={col} strokeWidth={1.2} filter={glow ? 'url(#amc-glow)' : undefined}/>
    }
    if (ag.shape === 'dod') {
      const pts = Array.from({length:10}, (_,i) => {
        const a = i * Math.PI / 5
        const rd = i % 2 === 0 ? ag.r : ag.r * 0.7
        return `${ag.x + Math.cos(a) * rd},${ag.y + Math.sin(a) * rd}`
      }).join(' ')
      return <polygon points={pts} fill="none" stroke={col} strokeWidth={1} filter={glow ? 'url(#amc-glow)' : undefined}/>
    }
    // tetrahedron — triangle
    return <polygon points={`${ag.x},${ag.y - ag.r} ${ag.x + ag.r * 0.87},${ag.y + ag.r * 0.5} ${ag.x - ag.r * 0.87},${ag.y + ag.r * 0.5}`} fill="none" stroke={col} strokeWidth={1} filter={glow ? 'url(#amc-glow)' : undefined}/>
  }

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>AGENT MESH CONSTELLATION</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: 'radial-gradient(circle at 50% 50%, rgba(12,8,28,1) 0%, rgba(3,1,10,1) 100%)', borderRadius: 8 }}>
        <defs>
          <filter id="amc-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="amc-glow-lg"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>

        {/* Connection lines */}
        {connections.map(([fi, ti], i) => (
          <line key={`conn-${i}`} x1={agents[fi].x} y1={agents[fi].y} x2={agents[ti].x} y2={agents[ti].y} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5}/>
        ))}

        {/* Delegation arcs */}
        {delegations.map((d, i) => {
          const src = agents[d.from], tgt = agents[d.to]
          const mx = (src.x + tgt.x) / 2, my = (src.y + tgt.y) / 2 - 30
          const progress = ((f * 0.02 + i * 0.5) % 1)
          const t = progress
          const px = (1-t)*(1-t)*src.x + 2*(1-t)*t*mx + t*t*tgt.x
          const py = (1-t)*(1-t)*src.y + 2*(1-t)*t*my + t*t*tgt.y
          return <g key={`del-${i}`}>
            <path d={`M ${src.x} ${src.y} Q ${mx} ${my} ${tgt.x} ${tgt.y}`} fill="none" stroke="#22d3ee" strokeWidth={1} opacity={0.4} filter="url(#amc-glow)"/>
            <circle cx={px} cy={py} r={2.5} fill="#22d3ee" filter="url(#amc-glow-lg)"/>
            <text x={(src.x + tgt.x) / 2} y={(src.y + tgt.y) / 2 - 38} textAnchor="middle" fill="rgba(34,211,238,0.6)" fontFamily={M} fontSize={6}>{d.label}</text>
          </g>
        })}

        {/* Agent nodes */}
        {agents.map((ag, i) => {
          const sr = scanRing(ag.x, ag.y, ag.r, 0.04 + i * 0.003)
          return <g key={`ag-${i}`}>
            {renderShape(ag)}
            {ag.state !== 'idle' && <circle cx={sr.cx} cy={sr.cy} r={1.5} fill={stateColors[ag.state]} opacity={0.6}/>}
            <text x={ag.x} y={ag.y + ag.r + 10} textAnchor="middle" fill={ag.state !== 'idle' ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)'} fontFamily={M} fontSize={6} fontWeight={ag.role === 'orchestrator' ? 700 : 400}>{ag.id}</text>
          </g>
        })}

        {/* Stats bar */}
        <rect x={W * 0.1} y={H - 28} width={W * 0.8} height={18} rx={4} fill="rgba(8,11,20,0.7)" stroke="rgba(255,255,255,0.08)" strokeWidth={0.5}/>
        <text x={W * 0.14} y={H - 16} fill="rgba(255,255,255,0.6)" fontFamily={M} fontSize={7}>16 agents</text>
        <text x={W * 0.32} y={H - 16} fill="#818cf8" fontFamily={M} fontSize={7}>4 thinking</text>
        <text x={W * 0.50} y={H - 16} fill="#30ff90" fontFamily={M} fontSize={7}>2 executing</text>
        <text x={W * 0.68} y={H - 16} fill="#ef4444" fontFamily={M} fontSize={7}>1 blocked</text>
        <text x={W * 0.82} y={H - 16} fill="rgba(255,255,255,0.4)" fontFamily={M} fontSize={7}>9 idle</text>
      </svg>
    </div>
  )
}

// ─── 3. ExecutionSolarSystem — Objective Cluster Detail ───
export function ExecutionSolarSystem() {
  const f = useAnimFrame()
  const W = 500, H = 400, cx = W / 2, cy = H / 2

  const tasks = [
    { name: 'Pull images', status: 'done', orbit: 50, speed: 0.008, offset: 0, agent: null },
    { name: 'Run migrations', status: 'done', orbit: 70, speed: 0.012, offset: 2, agent: null },
    { name: 'Health check', status: 'running', orbit: 95, speed: 0.035, offset: 1, agent: 'WARDEN' },
    { name: 'Update DNS', status: 'pending', orbit: 120, speed: 0.005, offset: 3, agent: null },
    { name: 'Notify team', status: 'pending', orbit: 140, speed: 0.004, offset: 5, agent: null },
    { name: 'Verify deploy', status: 'pending', orbit: 160, speed: 0.003, offset: 0.5, agent: null },
  ]

  const statusColors = { done: '#30ff90', running: '#22d3ee', pending: 'rgba(255,255,255,0.2)' }
  const completed = tasks.filter(t => t.status === 'done').length
  const total = tasks.length
  const progressAngle = (completed / total) * Math.PI * 2
  const pulse = 0.7 + Math.sin(f * 0.08) * 0.3

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>EXECUTION SOLAR SYSTEM</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: 'radial-gradient(circle at 50% 50%, rgba(15,10,30,1) 0%, rgba(3,1,10,1) 100%)', borderRadius: 8 }}>
        <defs>
          <filter id="ess-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="ess-glow-lg"><feGaussianBlur stdDeviation="6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <radialGradient id="ess-core-grad"><stop offset="0%" stopColor="#818cf8" stopOpacity="0.6"/><stop offset="60%" stopColor="#6366f1" stopOpacity="0.2"/><stop offset="100%" stopColor="transparent" stopOpacity="0"/></radialGradient>
        </defs>

        {/* Orbit tracks */}
        {tasks.map((t, i) => (
          <circle key={`orbit-${i}`} cx={cx} cy={cy} r={t.orbit} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} strokeDasharray={t.status === 'pending' ? '3 6' : 'none'}/>
        ))}

        {/* Core objective */}
        <circle cx={cx} cy={cy} r={35} fill="url(#ess-core-grad)"/>
        <circle cx={cx} cy={cy} r={20} fill="none" stroke="#818cf8" strokeWidth={1.5} opacity={0.7} filter="url(#ess-glow)"/>

        {/* Progress arc */}
        {(() => {
          const r = 24
          const sx = cx + Math.cos(-Math.PI/2) * r, sy = cy + Math.sin(-Math.PI/2) * r
          const ex = cx + Math.cos(-Math.PI/2 + progressAngle) * r, ey = cy + Math.sin(-Math.PI/2 + progressAngle) * r
          const large = progressAngle > Math.PI ? 1 : 0
          return <path d={`M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey}`} fill="none" stroke="#30ff90" strokeWidth={2.5} strokeLinecap="round" filter="url(#ess-glow)"/>
        })()}

        <text x={cx} y={cy - 4} textAnchor="middle" fill="rgba(255,255,255,0.9)" fontFamily={F} fontSize={9} fontWeight={700}>Deploy v2.4</text>
        <text x={cx} y={cy + 8} textAnchor="middle" fill="#30ff90" fontFamily={M} fontSize={8} fontWeight={600}>{completed}/{total}</text>

        {/* Task nodes */}
        {tasks.map((t, i) => {
          const a = f * t.speed + t.offset
          const tx = cx + Math.cos(a) * t.orbit
          const ty = cy + Math.sin(a) * t.orbit
          const r = t.status === 'running' ? 5 + Math.sin(f * 0.1) * 1 : t.status === 'done' ? 4 : 3
          const op = t.status === 'done' ? 0.5 + Math.sin(f * 0.03 + i) * 0.2 : t.status === 'running' ? pulse : 0.4

          return <g key={`task-${i}`}>
            <circle cx={tx} cy={ty} r={r} fill={statusColors[t.status]} opacity={op} filter={t.status === 'running' ? 'url(#ess-glow-lg)' : t.status === 'done' ? 'url(#ess-glow)' : undefined}/>
            <text x={tx} y={ty - r - 5} textAnchor="middle" fill={statusColors[t.status]} fontFamily={M} fontSize={6} opacity={0.8}>{t.name}</text>
            {t.agent && <>
              <line x1={tx} y1={ty} x2={tx + 45} y2={ty - 20} stroke="#22d3ee" strokeWidth={0.5} opacity={0.5} strokeDasharray="2 2"/>
              <text x={tx + 48} y={ty - 18} fill="#22d3ee" fontFamily={M} fontSize={6} opacity={0.7}>{t.agent}</text>
            </>}
          </g>
        })}

        {/* Bottom stats */}
        <rect x={W * 0.12} y={H - 30} width={W * 0.76} height={18} rx={4} fill="rgba(8,11,20,0.7)" stroke="rgba(255,255,255,0.08)" strokeWidth={0.5}/>
        <text x={W * 0.16} y={H - 18} fill="rgba(255,255,255,0.6)" fontFamily={M} fontSize={7}>4m 23s elapsed</text>
        <text x={W * 0.50} y={H - 18} fill="rgba(255,255,255,0.4)" fontFamily={M} fontSize={7}>|</text>
        <text x={W * 0.55} y={H - 18} fill="#f59e0b" fontFamily={M} fontSize={7}>1,247 / 5,000 tokens</text>
      </svg>
    </div>
  )
}

// ─── 4. MemoryLatticeView — Crystal Field ───
export function MemoryLatticeView() {
  const f = useAnimFrame()
  const W = 600, H = 350, cx = W / 2, cy = H / 2

  const crystalTypes = {
    entity: { color: '#ec4899', shape: 'cube' },
    fact: { color: '#818cf8', shape: 'octahedron' },
    decision: { color: '#a78bfa', shape: 'pyramid' },
    preference: { color: '#22d3ee', shape: 'sphere' },
    openloop: { color: '#f59e0b', shape: 'torus' },
    observation: { color: 'rgba(255,255,255,0.4)', shape: 'disc' },
  }

  const crystals = [
    { type: 'entity', label: 'edge-01', x: 80, y: 80 },
    { type: 'entity', label: 'hyp-01', x: 180, y: 140 },
    { type: 'entity', label: 'WARDEN', x: 420, y: 90 },
    { type: 'entity', label: 'gw-01', x: 520, y: 200 },
    { type: 'entity', label: 'VULCAN', x: 100, y: 240 },
    { type: 'entity', label: 'edge-02', x: 340, y: 260 },
    { type: 'fact', label: 'nginx:443', x: 150, y: 60 },
    { type: 'fact', label: 'v2.4 stable', x: 300, y: 120 },
    { type: 'fact', label: 'qdrant:6333', x: 450, y: 170 },
    { type: 'fact', label: 'bastion SSH', x: 240, y: 200 },
    { type: 'fact', label: '16 agents', x: 380, y: 40 },
    { type: 'decision', label: 'deploy prod', x: 200, y: 280 },
    { type: 'decision', label: 'scale docker', x: 500, y: 120 },
    { type: 'decision', label: 'enable MCP', x: 130, y: 170 },
    { type: 'decision', label: 'OAuth first', x: 470, y: 280 },
    { type: 'preference', label: 'UK English', x: 350, y: 180 },
    { type: 'preference', label: 'concise', x: 80, y: 310 },
    { type: 'preference', label: 'no emojis', x: 260, y: 60 },
    { type: 'preference', label: 'dark mode', x: 530, y: 50 },
    { type: 'openloop', label: 'SSL renew', x: 300, y: 300 },
    { type: 'openloop', label: 'GPU setup', x: 450, y: 310 },
    { type: 'openloop', label: 'Phase 5.5', x: 180, y: 320 },
    { type: 'observation', label: 'cpu spike', x: 400, y: 220 },
    { type: 'observation', label: 'login ok', x: 60, y: 160 },
    { type: 'observation', label: 'build pass', x: 540, y: 270 },
  ]

  // Related connections
  const links = [[0,6],[1,9],[2,10],[3,9],[4,11],[5,13],[7,11],[8,15],[12,1],[14,18]]

  const renderCrystal = (c, i) => {
    const ct = crystalTypes[c.type]
    const drift = Math.sin(f * 0.01 + i * 1.3) * 4
    const x = c.x + drift * 0.5
    const y = c.y + Math.cos(f * 0.008 + i * 0.7) * 3
    const op = c.type === 'openloop' ? 0.5 + Math.sin(f * 0.06 + i) * 0.4 : 0.7
    const sz = c.type === 'openloop' ? 7 : c.type === 'entity' ? 6 : 5

    let shape
    if (ct.shape === 'cube') {
      shape = <rect x={x - sz} y={y - sz} width={sz * 2} height={sz * 2} fill="none" stroke={ct.color} strokeWidth={1} transform={`rotate(${f * 0.2 + i * 30} ${x} ${y})`}/>
    } else if (ct.shape === 'octahedron') {
      const pts = Array.from({length:8}, (_,j) => { const a = j * Math.PI / 4; return `${x + Math.cos(a) * sz},${y + Math.sin(a) * sz}` }).join(' ')
      shape = <polygon points={pts} fill="none" stroke={ct.color} strokeWidth={1}/>
    } else if (ct.shape === 'pyramid') {
      shape = <polygon points={`${x},${y - sz} ${x + sz},${y + sz * 0.7} ${x - sz},${y + sz * 0.7}`} fill="none" stroke={ct.color} strokeWidth={1}/>
    } else if (ct.shape === 'sphere') {
      shape = <circle cx={x} cy={y} r={sz} fill="none" stroke={ct.color} strokeWidth={1}/>
    } else if (ct.shape === 'torus') {
      shape = <>
        <circle cx={x} cy={y} r={sz} fill="none" stroke={ct.color} strokeWidth={1.5}/>
        <circle cx={x} cy={y} r={sz * 0.5} fill="none" stroke={ct.color} strokeWidth={0.5} opacity={0.5}/>
      </>
    } else {
      shape = <ellipse cx={x} cy={y} rx={sz} ry={sz * 0.35} fill="none" stroke={ct.color} strokeWidth={0.8}/>
    }

    return <g key={`crys-${i}`} opacity={op}>
      {shape}
      <text x={x} y={y + sz + 10} textAnchor="middle" fill={ct.color} fontFamily={M} fontSize={5.5} opacity={0.7}>{c.label}</text>
    </g>
  }

  // Focus beam
  const beamAngle = f * 0.005
  const bx = cx + Math.cos(beamAngle) * 280
  const by = cy + Math.sin(beamAngle) * 150

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>MEMORY LATTICE — CRYSTAL FIELD</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: 'radial-gradient(ellipse at 50% 50%, rgba(15,8,30,1) 0%, rgba(3,1,10,1) 100%)', borderRadius: 8 }}>
        <defs>
          <filter id="mlv-glow"><feGaussianBlur stdDeviation="2.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>

        {/* Focus beam */}
        <line x1={cx} y1={cy} x2={bx} y2={by} stroke="#818cf8" strokeWidth={1} opacity={0.1}/>

        {/* Connection threads */}
        {links.map(([a, b], i) => {
          const ca = crystals[a], cb = crystals[b]
          return <line key={`link-${i}`} x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} stroke="rgba(255,255,255,0.04)" strokeWidth={0.5}/>
        })}

        {/* Crystals */}
        {crystals.map((c, i) => renderCrystal(c, i))}

        {/* Legend */}
        {[
          { label: 'Entity', color: '#ec4899', x: 40 },
          { label: 'Fact', color: '#818cf8', x: 110 },
          { label: 'Decision', color: '#a78bfa', x: 165 },
          { label: 'Preference', color: '#22d3ee', x: 235 },
          { label: 'Open Loop', color: '#f59e0b', x: 320 },
          { label: 'Observation', color: 'rgba(255,255,255,0.5)', x: 400 },
        ].map((l, i) => (
          <g key={`leg-${i}`}>
            <circle cx={l.x} cy={H - 14} r={3} fill={l.color} opacity={0.7}/>
            <text x={l.x + 7} y={H - 11} fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={6}>{l.label}</text>
          </g>
        ))}

        {/* Stats */}
        <text x={W - 10} y={H - 11} textAnchor="end" fill="rgba(255,255,255,0.4)" fontFamily={M} fontSize={6.5}>8,247 memories | 3 open loops | 127 new (24h)</text>
      </svg>
    </div>
  )
}

// ─── 5. CoreShellHealth — Implant Health Visualization ───
export function CoreShellHealth() {
  const f = useAnimFrame()
  const W = 400, H = 400, cx = W / 2, cy = H / 2, R = 160

  const implants = [
    { name: 'quox-sense', health: 95, color: '#a78bfa' },
    { name: 'quox-memory', health: 88, color: '#ec4899' },
    { name: 'quox-executive', health: 92, color: '#818cf8' },
    { name: 'quox-temporal', health: 97, color: '#30ff90' },
    { name: 'quox-focus', health: 91, color: '#22d3ee' },
    { name: 'quox-value', health: 85, color: '#3b82f6' },
    { name: 'quox-insight', health: 78, color: '#f59e0b' },
    { name: 'quox-guard', health: 96, color: '#30ff90' },
    { name: 'quox-dream', health: 90, color: '#818cf8' },
    { name: 'quox-reflect', health: 94, color: '#a78bfa' },
    { name: 'quox-learn', health: 82, color: '#22d3ee' },
    { name: 'quox-predict', health: 87, color: '#3b82f6' },
  ]

  const rot = f * 0.002
  const avgHealth = Math.round(implants.reduce((s, im) => s + im.health, 0) / implants.length)
  const avgColor = avgHealth > 90 ? '#30ff90' : avgHealth > 80 ? '#f59e0b' : '#ef4444'

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>CORE SHELL HEALTH — IMPLANT MONITOR</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: 'radial-gradient(circle at 50% 50%, rgba(12,8,25,1) 0%, rgba(3,1,10,1) 100%)', borderRadius: 8 }}>
        <defs>
          <filter id="csh-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="csh-glow-sm"><feGaussianBlur stdDeviation="1.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>

        {/* Arc segments */}
        {implants.map((im, i) => {
          const gap = 0.012
          const segAngle = (Math.PI * 2) / implants.length
          const a1 = i * segAngle - Math.PI / 2 + rot + gap
          const a2 = (i + 1) * segAngle - Math.PI / 2 + rot - gap
          const x1 = cx + Math.cos(a1) * R, y1 = cy + Math.sin(a1) * R
          const x2 = cx + Math.cos(a2) * R, y2 = cy + Math.sin(a2) * R
          const op = (im.health / 100) * 0.85
          const degraded = im.health < 80
          const midA = (a1 + a2) / 2
          const lx = cx + Math.cos(midA) * (R + 20), ly = cy + Math.sin(midA) * (R + 20)
          const textAnchor = lx > cx ? 'start' : 'end'

          return <g key={`seg-${i}`}>
            {/* Main arc */}
            <path d={`M ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2}`} fill="none" stroke={im.color} strokeWidth={8} opacity={op} filter="url(#csh-glow)" strokeLinecap="round"/>
            {/* Degraded indicator */}
            {degraded && <path d={`M ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2}`} fill="none" stroke="#f59e0b" strokeWidth={2} opacity={0.3 + Math.sin(f * 0.06) * 0.2} strokeLinecap="round"/>}
            {/* Inner thin ring at same position */}
            <path d={`M ${cx + Math.cos(a1) * (R - 12)} ${cy + Math.sin(a1) * (R - 12)} A ${R - 12} ${R - 12} 0 0 1 ${cx + Math.cos(a2) * (R - 12)} ${cy + Math.sin(a2) * (R - 12)}`} fill="none" stroke={im.color} strokeWidth={0.5} opacity={0.15}/>
            {/* Label */}
            <text x={lx} y={ly - 4} textAnchor={textAnchor} fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={5.5}>{im.name}</text>
            <text x={lx} y={ly + 5} textAnchor={textAnchor} fill={degraded ? '#f59e0b' : im.color} fontFamily={M} fontSize={7} fontWeight={600}>{im.health}%</text>
          </g>
        })}

        {/* Centre health display */}
        <circle cx={cx} cy={cy} r={55} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={0.5}/>
        <text x={cx} y={cy - 12} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={8} letterSpacing={2}>SYSTEM HEALTH</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fill={avgColor} fontFamily={M} fontSize={28} fontWeight={700} filter="url(#csh-glow)">{avgHealth}%</text>
        <text x={cx} y={cy + 28} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontFamily={M} fontSize={6}>12 implants monitored</text>
      </svg>
    </div>
  )
}

// ─── 6. DelegationArcDemo — Delegation Animation ───
export function DelegationArcDemo() {
  const f = useAnimFrame()
  const W = 500, H = 300, cx = 80, cy = H / 2

  const targets = [
    { name: 'WARDEN', x: 380, y: 60, label: 'scan edge-03', color: '#10b981' },
    { name: 'VULCAN', x: 400, y: 150, label: 'deploy v2.4', color: '#3b82f6' },
    { name: 'DAEDALUS', x: 370, y: 240, label: 'generate report', color: '#38bdf8' },
  ]

  const cycleTime = 120 // frames per cycle
  const stagger = 6 // frames between arc starts

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>DELEGATION ARC DEMO</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: 'linear-gradient(135deg, rgba(10,6,22,1) 0%, rgba(5,2,15,1) 100%)', borderRadius: 8 }}>
        <defs>
          <filter id="dad-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="dad-glow-lg"><feGaussianBlur stdDeviation="6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <radialGradient id="dad-src-glow"><stop offset="0%" stopColor="#a78bfa" stopOpacity="0.5"/><stop offset="100%" stopColor="transparent" stopOpacity="0"/></radialGradient>
        </defs>

        {/* Source node — QUOX */}
        <circle cx={cx} cy={cy} r={30} fill="url(#dad-src-glow)"/>
        <polygon points={`${cx},${cy-12} ${cx+10},${cy-4} ${cx+10},${cy+8} ${cx},${cy+12} ${cx-10},${cy+8} ${cx-10},${cy-4}`} fill="none" stroke="#a78bfa" strokeWidth={1.5} filter="url(#dad-glow)"/>
        <text x={cx} y={cy + 2} textAnchor="middle" fill="rgba(255,255,255,0.9)" fontFamily={M} fontSize={7} fontWeight={700}>QUOX</text>

        {/* Delegation arcs */}
        {targets.map((tgt, i) => {
          const localF = (f - i * stagger + cycleTime * 100) % cycleTime
          const progress = Math.min(1, Math.max(0, localF / (cycleTime * 0.5)))
          const fadeIn = Math.min(1, localF / 10)
          const fadeOut = localF > cycleTime * 0.7 ? 1 - (localF - cycleTime * 0.7) / (cycleTime * 0.3) : 1

          const mx = (cx + tgt.x) / 2
          const my = tgt.y + (cy - tgt.y) * 0.3 - 30

          // Bezier point
          const t = progress
          const px = (1-t)*(1-t)*cx + 2*(1-t)*t*mx + t*t*tgt.x
          const py = (1-t)*(1-t)*cy + 2*(1-t)*t*my + t*t*tgt.y

          // Trail points
          const trailPts = []
          for (let s = 0; s < 8; s++) {
            const tt = Math.max(0, t - s * 0.03)
            trailPts.push({
              x: (1-tt)*(1-tt)*cx + 2*(1-tt)*tt*mx + tt*tt*tgt.x,
              y: (1-tt)*(1-tt)*cy + 2*(1-tt)*tt*my + tt*tt*tgt.y,
              op: (1 - s / 8) * 0.6
            })
          }

          // Target flash
          const flash = progress > 0.95 ? 0.6 + Math.sin(f * 0.2) * 0.3 : 0

          return <g key={`arc-${i}`} opacity={fadeIn * fadeOut}>
            {/* Arc path */}
            <path d={`M ${cx} ${cy} Q ${mx} ${my} ${tgt.x} ${tgt.y}`} fill="none" stroke="#22d3ee" strokeWidth={0.8} opacity={0.2}/>

            {/* Trail */}
            {progress > 0.01 && trailPts.map((tp, ti) => (
              <circle key={`trail-${i}-${ti}`} cx={tp.x} cy={tp.y} r={2 - ti * 0.2} fill="#22d3ee" opacity={tp.op}/>
            ))}

            {/* Head dot */}
            {progress > 0.01 && progress < 1 && <circle cx={px} cy={py} r={3.5} fill="#22d3ee" filter="url(#dad-glow-lg)"/>}

            {/* Target node */}
            <circle cx={tgt.x} cy={tgt.y} r={12} fill="none" stroke={tgt.color} strokeWidth={1} opacity={0.6}/>
            {flash > 0 && <circle cx={tgt.x} cy={tgt.y} r={16} fill="none" stroke={tgt.color} strokeWidth={1.5} opacity={flash} filter="url(#dad-glow)"/>}
            <text x={tgt.x} y={tgt.y + 3} textAnchor="middle" fill="rgba(255,255,255,0.8)" fontFamily={M} fontSize={6} fontWeight={600}>{tgt.name}</text>

            {/* Label */}
            <text x={(cx + tgt.x) / 2 + 10} y={my - 6} textAnchor="middle" fill="rgba(34,211,238,0.5)" fontFamily={M} fontSize={6}>{tgt.label} {'\u2192'} {tgt.name}</text>
          </g>
        })}

        {/* Bottom label */}
        <rect x={W * 0.15} y={H - 28} width={W * 0.7} height={18} rx={4} fill="rgba(8,11,20,0.7)" stroke="rgba(255,255,255,0.08)" strokeWidth={0.5}/>
        <text x={W / 2} y={H - 16} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={7}>Fan-out delegation — 3 agents activated in 0.6s</text>
      </svg>
    </div>
  )
}

// ─── 7. TopologyTransition — Team Topology Morphing ───
export function TopologyTransition() {
  const f = useAnimFrame()
  const PW = 140, PH = 160, gap = 10
  const W = PW * 4 + gap * 3 + 20, H = PH + 50

  const agentNames = ['QUOX', 'WARDEN', 'VULCAN', 'DAEDALUS', 'HYPERION', 'CODEX']
  const agentColors = ['#a78bfa', '#10b981', '#3b82f6', '#38bdf8', '#8b5cf6', '#6366f1']
  const activeIdx = Math.floor((f * 0.008) % 4)

  const layouts = {
    star: (cx, cy) => {
      const positions = [{ x: cx, y: cy }]
      for (let i = 1; i < 6; i++) {
        const a = ((i - 1) / 5) * Math.PI * 2 - Math.PI / 2
        positions.push({ x: cx + Math.cos(a) * 40, y: cy + Math.sin(a) * 40 })
      }
      return { positions, edges: [[0,1],[0,2],[0,3],[0,4],[0,5]] }
    },
    hierarchical: (cx, cy) => ({
      positions: [
        { x: cx, y: cy - 40 },
        { x: cx - 30, y: cy - 5 },
        { x: cx + 30, y: cy - 5 },
        { x: cx - 40, y: cy + 30 },
        { x: cx, y: cy + 30 },
        { x: cx + 40, y: cy + 30 },
      ],
      edges: [[0,1],[0,2],[1,3],[1,4],[2,5]]
    }),
    pipeline: (cx, cy) => ({
      positions: Array.from({length:6}, (_, i) => ({ x: cx - 50 + i * 20, y: cy })),
      edges: [[0,1],[1,2],[2,3],[3,4],[4,5]]
    }),
    mesh: (cx, cy) => {
      const positions = Array.from({length:6}, (_, i) => {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2
        return { x: cx + Math.cos(a) * 38, y: cy + Math.sin(a) * 38 }
      })
      const edges = []
      for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) edges.push([i, j])
      return { positions, edges }
    },
  }

  const topoNames = ['Star', 'Hierarchical', 'Pipeline', 'Mesh']
  const topoKeys = ['star', 'hierarchical', 'pipeline', 'mesh']

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>TOPOLOGY TRANSITION — TEAM MORPHING</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: 'linear-gradient(180deg, rgba(8,5,18,1) 0%, rgba(3,1,10,1) 100%)', borderRadius: 8 }}>
        <defs>
          <filter id="tt-glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>

        {topoKeys.map((key, pi) => {
          const px = 10 + pi * (PW + gap)
          const panelCx = px + PW / 2
          const panelCy = 40 + PH / 2 - 10
          const isActive = pi === activeIdx
          const layout = layouts[key](panelCx, panelCy)

          return <g key={`panel-${pi}`}>
            {/* Panel background */}
            <rect x={px} y={30} width={PW} height={PH} rx={6} fill={isActive ? 'rgba(129,140,248,0.06)' : 'rgba(255,255,255,0.01)'} stroke={isActive ? 'rgba(129,140,248,0.3)' : 'rgba(255,255,255,0.06)'} strokeWidth={isActive ? 1.5 : 0.5}/>
            {isActive && <rect x={px} y={30} width={PW} height={PH} rx={6} fill="none" stroke="#818cf8" strokeWidth={1} opacity={0.15} filter="url(#tt-glow)"/>}

            {/* Title */}
            <text x={panelCx} y={44} textAnchor="middle" fill={isActive ? '#818cf8' : 'rgba(255,255,255,0.5)'} fontFamily={M} fontSize={7} fontWeight={700}>{topoNames[pi]}</text>

            {/* Edges */}
            {layout.edges.map(([a, b], ei) => (
              <line key={`e-${pi}-${ei}`} x1={layout.positions[a].x} y1={layout.positions[a].y} x2={layout.positions[b].x} y2={layout.positions[b].y} stroke={isActive ? 'rgba(129,140,248,0.25)' : 'rgba(255,255,255,0.08)'} strokeWidth={0.5}/>
            ))}

            {/* Nodes */}
            {layout.positions.map((pos, ni) => (
              <g key={`n-${pi}-${ni}`}>
                <circle cx={pos.x} cy={pos.y} r={ni === 0 ? 5 : 3.5} fill={agentColors[ni]} opacity={isActive ? 0.8 : 0.4} filter={isActive ? 'url(#tt-glow)' : undefined}/>
                <text x={pos.x} y={pos.y + 10} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontFamily={M} fontSize={4}>{agentNames[ni]}</text>
              </g>
            ))}
          </g>
        })}

        {/* Bottom label */}
        <text x={W / 2} y={H - 8} textAnchor="middle" fill="rgba(255,255,255,0.35)" fontFamily={M} fontSize={6.5}>Agents rearrange on objective start — animated over 1.5s</text>
      </svg>
    </div>
  )
}

// ─── 8. OpsDeck3DPreview — The Big Combined Preview ───
export function OpsDeck3DPreview() {
  const f = useAnimFrame()
  const W = 650, H = 400

  const pulse = 0.6 + Math.sin(f * 0.05) * 0.4

  // Holo-grid floor lines (perspective converging)
  const vanishX = W / 2, vanishY = H * 0.35
  const gridLines = []
  // Horizontal lines
  for (let i = 0; i < 15; i++) {
    const t = i / 14
    const y = vanishY + t * t * (H - vanishY - 20)
    const spread = t * W * 0.6
    gridLines.push({ x1: vanishX - spread, y1: y, x2: vanishX + spread, y2: y, op: t * 0.15 })
  }
  // Vertical converging lines
  for (let i = 0; i < 12; i++) {
    const t = (i / 11 - 0.5) * 2
    gridLines.push({
      x1: vanishX + t * 20, y1: vanishY,
      x2: vanishX + t * W * 0.55, y2: H - 20,
      op: 0.08
    })
  }

  // Agent dots scattered in middle zone
  const agentDots = Array.from({length:12}, (_, i) => {
    const a = (i / 12) * Math.PI * 2 + f * 0.004
    const r = 60 + Math.sin(i * 2.1) * 25
    const depth = 0.5 + Math.sin(i * 1.3) * 0.3
    return {
      x: vanishX + Math.cos(a) * r * depth,
      y: vanishY + 15 + Math.sin(a) * r * 0.3 * depth,
      r: 1.5 + depth,
      color: ['#818cf8','#30ff90','#22d3ee','#a78bfa','#10b981','#ec4899'][i % 6],
      op: 0.3 + depth * 0.5
    }
  })

  // Objective clusters
  const objClusters = [
    { x: vanishX - 120, y: vanishY + 50, tasks: 4 },
    { x: vanishX + 100, y: vanishY + 70, tasks: 3 },
  ]

  // Memory crystals in outer zone
  const memoryCrystals = Array.from({length:8}, (_, i) => {
    const a = (i / 8) * Math.PI * 2 + f * 0.002
    const r = 140 + Math.sin(i * 3) * 30
    return {
      x: vanishX + Math.cos(a) * r * 0.7,
      y: vanishY + Math.sin(a) * r * 0.25 - 10,
      color: ['#ec4899','#818cf8','#a78bfa','#22d3ee','#f59e0b','#ec4899','#818cf8','#a78bfa'][i]
    }
  })

  // Ambient particles
  const particles = Array.from({length:30}, (_, i) => ({
    x: (Math.sin(i * 7.3 + f * 0.003) * 0.5 + 0.5) * W,
    y: (Math.cos(i * 4.1 + f * 0.002) * 0.5 + 0.5) * H,
    op: 0.05 + Math.sin(f * 0.02 + i) * 0.03
  }))

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>OPSDECK 3D — COGNITIVE CORE PREVIEW</div>
      <div style={{ position: 'relative', width: '100%', maxWidth: W, borderRadius: 8, overflow: 'hidden', background: 'linear-gradient(180deg, rgba(5,2,15,1) 0%, rgba(10,5,25,1) 40%, rgba(8,4,20,1) 100%)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
          <defs>
            <radialGradient id="o3d-nucleus"><stop offset="0%" stopColor="#818cf8" stopOpacity="0.7"/><stop offset="40%" stopColor="#6366f1" stopOpacity="0.3"/><stop offset="100%" stopColor="transparent" stopOpacity="0"/></radialGradient>
            <radialGradient id="o3d-ambient"><stop offset="0%" stopColor="#a78bfa" stopOpacity="0.08"/><stop offset="100%" stopColor="transparent" stopOpacity="0"/></radialGradient>
            <filter id="o3d-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            <filter id="o3d-glow-lg"><feGaussianBlur stdDeviation="8" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            <linearGradient id="o3d-vignette" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgba(5,2,15,0.6)"/><stop offset="30%" stopColor="transparent"/><stop offset="70%" stopColor="transparent"/><stop offset="100%" stopColor="rgba(5,2,15,0.8)"/></linearGradient>
          </defs>

          {/* Ambient glow */}
          <circle cx={vanishX} cy={vanishY} r={200} fill="url(#o3d-ambient)"/>

          {/* Holo-grid floor */}
          {gridLines.map((l, i) => (
            <line key={`grid-${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#818cf8" strokeWidth={0.5} opacity={l.op}/>
          ))}

          {/* Core shell wireframe */}
          <ellipse cx={vanishX} cy={vanishY} rx={180} ry={80} fill="none" stroke="rgba(129,140,248,0.12)" strokeWidth={0.8}/>
          <ellipse cx={vanishX} cy={vanishY} rx={180} ry={80} fill="none" stroke="rgba(129,140,248,0.06)" strokeWidth={0.5} transform={`rotate(30 ${vanishX} ${vanishY})`}/>
          <ellipse cx={vanishX} cy={vanishY} rx={180} ry={80} fill="none" stroke="rgba(129,140,248,0.06)" strokeWidth={0.5} transform={`rotate(60 ${vanishX} ${vanishY})`}/>
          <ellipse cx={vanishX} cy={vanishY} rx={140} ry={60} fill="none" stroke="rgba(129,140,248,0.06)" strokeWidth={0.5}/>

          {/* Memory crystals in outer zone */}
          {memoryCrystals.map((mc, i) => (
            <polygon key={`mc-${i}`} points={`${mc.x},${mc.y-4} ${mc.x+3},${mc.y+2} ${mc.x-3},${mc.y+2}`} fill="none" stroke={mc.color} strokeWidth={0.8} opacity={0.5}/>
          ))}

          {/* Objective clusters */}
          {objClusters.map((cl, ci) => (
            <g key={`ocl-${ci}`}>
              <circle cx={cl.x} cy={cl.y} r={6} fill="none" stroke="#818cf8" strokeWidth={1} opacity={0.5} filter="url(#o3d-glow)"/>
              {Array.from({length:cl.tasks}, (_, ti) => {
                const ta = (ti / cl.tasks) * Math.PI * 2 + f * 0.02
                return <circle key={ti} cx={cl.x + Math.cos(ta) * 14} cy={cl.y + Math.sin(ta) * 6} r={1.5} fill={ti === 0 ? '#30ff90' : 'rgba(255,255,255,0.2)'}/>
              })}
            </g>
          ))}

          {/* Agent dots */}
          {agentDots.map((a, i) => (
            <circle key={`ag-${i}`} cx={a.x} cy={a.y} r={a.r} fill={a.color} opacity={a.op} filter="url(#o3d-glow)"/>
          ))}

          {/* Delegation arcs */}
          <path d={`M ${vanishX} ${vanishY} Q ${vanishX - 60} ${vanishY - 30} ${vanishX - 120} ${vanishY + 50}`} fill="none" stroke="#22d3ee" strokeWidth={1} opacity={0.3} filter="url(#o3d-glow)" strokeDasharray="4 3"/>
          <path d={`M ${vanishX} ${vanishY} Q ${vanishX + 50} ${vanishY + 20} ${vanishX + 100} ${vanishY + 70}`} fill="none" stroke="#22d3ee" strokeWidth={1} opacity={0.25} filter="url(#o3d-glow)" strokeDasharray="4 3"/>

          {/* Nucleus glow at centre */}
          <circle cx={vanishX} cy={vanishY} r={50} fill="url(#o3d-nucleus)"/>
          <circle cx={vanishX} cy={vanishY} r={6} fill="#818cf8" opacity={pulse} filter="url(#o3d-glow-lg)"/>

          {/* Ambient particles */}
          {particles.map((p, i) => (
            <circle key={`pt-${i}`} cx={p.x} cy={p.y} r={0.8} fill="rgba(255,255,255,1)" opacity={p.op}/>
          ))}

          {/* Vignette overlay */}
          <rect x={0} y={0} width={W} height={H} fill="url(#o3d-vignette)"/>

          {/* HUD overlay */}
          <rect x={10} y={H - 28} width={W - 20} height={20} rx={4} fill="rgba(8,11,20,0.8)" stroke="rgba(129,140,248,0.15)" strokeWidth={0.5}/>
          <circle cx={24} cy={H - 18} r={3} fill="#30ff90" opacity={pulse}/>
          <text x={34} y={H - 14.5} fill="rgba(255,255,255,0.7)" fontFamily={M} fontSize={7.5} fontWeight={600}>QUOXCORE</text>
          <text x={110} y={H - 14.5} fill="rgba(255,255,255,0.35)" fontFamily={M} fontSize={7}>connected</text>
          <text x={175} y={H - 14.5} fill="rgba(255,255,255,0.25)" fontFamily={M} fontSize={7}>|</text>
          <text x={190} y={H - 14.5} fill="#818cf8" fontFamily={M} fontSize={7}>12/16 agents</text>
          <text x={280} y={H - 14.5} fill="rgba(255,255,255,0.25)" fontFamily={M} fontSize={7}>|</text>
          <text x={295} y={H - 14.5} fill="#22d3ee" fontFamily={M} fontSize={7}>1 objective</text>
          <text x={375} y={H - 14.5} fill="rgba(255,255,255,0.25)" fontFamily={M} fontSize={7}>|</text>
          <text x={390} y={H - 14.5} fill="#30ff90" fontFamily={M} fontSize={7}>67%</text>

          {/* Top left label */}
          <text x={15} y={18} fill="rgba(129,140,248,0.4)" fontFamily={M} fontSize={7} letterSpacing={2}>OPSDECK 3D</text>
          <text x={15} y={28} fill="rgba(255,255,255,0.2)" fontFamily={M} fontSize={6}>Cognitive Core — Immersive View</text>
        </svg>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 9. OPSDECK FULL PAGE — Complete Glass Dashboard Concept
// ═══════════════════════════════════════════════════════════════
const gl = (extra = {}) => ({
  backdropFilter: 'var(--glass-blur-strong)', WebkitBackdropFilter: 'var(--glass-blur-strong)',
  background: 'linear-gradient(145deg,rgba(255,255,255,0.02) 0%,rgba(255,255,255,0.005) 100%)',
  borderTop: '1px solid rgba(255,255,255,0.35)', borderLeft: '1px solid rgba(255,255,255,0.25)',
  borderRight: '1px solid transparent', borderBottom: '1px solid transparent',
  borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.35),inset 0 1px 2px rgba(255,255,255,0.06)',
  position: 'relative', overflow: 'hidden', ...extra
})
const Shim = () => <div style={{ position:'absolute',inset:0,borderRadius:'inherit',pointerEvents:'none',background:'linear-gradient(105deg,rgba(255,255,255,0.04) 0%,transparent 35%,transparent 65%,rgba(255,255,255,0.01) 100%)' }}/>

const OFP_OBJECTIVES = [
  { id: 'obj-7a3f', name: 'Deploy v2.4', pct: 67, topo: 'star', state: 'running', color: '#30ff90' },
  { id: 'obj-8b2c', name: 'Security Scan', pct: 100, topo: 'pipeline', state: 'done', color: '#818cf8' },
  { id: 'obj-1d4e', name: 'Backup NAS', pct: 47, topo: 'star', state: 'zombie', color: '#f59e0b', stuckMin: 47 },
]
const OFP_QUEUE = [
  { name: 'Rotate certs', priority: 'high', color: '#ef4444' },
  { name: 'Update DNS', priority: 'medium', color: '#f59e0b' },
  { name: 'Sync configs', priority: 'low', color: '#3b82f6' },
]
const OFP_EVENTS = [
  { ts: '14:32', agent: 'WARDEN', color: '#10b981', text: 'started port scan on edge-01-04' },
  { ts: '14:31', agent: 'VULCAN', color: '#3b82f6', text: 'completed PR review #142' },
  { ts: '14:30', agent: 'CODEX', color: '#6366f1', text: 'generated test suite for auth module' },
  { ts: '14:29', agent: 'DAEDALUS', color: '#a855f7', text: 'indexed 340 new memory entries' },
  { ts: '14:28', agent: 'CIPHER', color: '#f59e0b', text: 'decrypted backup payload (AES-256)' },
  { ts: '14:27', agent: 'HYPERION', color: '#8b5cf6', text: 'discovered 3 new hosts on subnet' },
  { ts: '14:26', agent: 'WARDEN', color: '#10b981', text: 'cleared CVE-2026-1234 false positive' },
  { ts: '14:25', agent: 'VULCAN', color: '#3b82f6', text: 'pushed hotfix to staging branch' },
]
const OFP_AGENTS_GRID = [
  ['VULCAN','#3b82f6','busy'], ['WARDEN','#10b981','busy'], ['CODEX','#6366f1','busy'], ['DAEDALUS','#a855f7','busy'],
  ['CIPHER','#f59e0b','busy'], ['HYPERION','#8b5cf6','busy'], ['VIGIL','#22d3ee','idle'], ['COREY','#ec4899','busy'],
  ['MESHNET','#06b6d4','idle'], ['NETWATCH','#ef4444','busy'], ['ORACLE','#14b8a6','idle'], ['INSIGHT','#f97316','idle'],
  ['METRICS','#84cc16','idle'], ['GEMINI','#d946ef','idle'], ['ARCHIVIST','#38bdf8','idle'], ['QUOX','#818cf8','busy'],
]
const OFP_GRAPH_NODES = [
  { id: 'orch', name: 'VULCAN', x: 220, y: 90, r: 16, color: '#3b82f6', task: 'Orchestrating', state: 'active' },
  { id: 'a1', name: 'WARDEN', x: 80, y: 40, r: 11, color: '#10b981', task: 'Health check', state: 'executing' },
  { id: 'a2', name: 'CODEX', x: 360, y: 40, r: 11, color: '#6366f1', task: 'Run migrations', state: 'done' },
  { id: 'a3', name: 'DAEDALUS', x: 80, y: 150, r: 11, color: '#a855f7', task: 'Pull images', state: 'done' },
  { id: 'a4', name: 'CIPHER', x: 360, y: 150, r: 11, color: '#f59e0b', task: 'Update DNS', state: 'pending' },
]
const OFP_GRAPH_EDGES = [['orch','a1'],['orch','a2'],['orch','a3'],['orch','a4']]
const OFP_BOTTOM_EVENTS = [
  { icon: '\u25B6', text: 'Scan started', color: '#10b981' },
  { icon: '\u2713', text: 'PR merged', color: '#3b82f6' },
  { icon: '\u26A1', text: 'Delegated', color: '#22d3ee' },
  { icon: '\u2713', text: 'Tests pass', color: '#30ff90' },
  { icon: '\u21BB', text: 'Retried', color: '#f59e0b' },
  { icon: '\u2717', text: 'Timeout', color: '#ef4444' },
]

export function OpsDeckFullPage() {
  const f = useAnimFrame()
  const pulse = 0.6 + Math.sin(f * 0.06) * 0.4
  const scanAngle = (f * 2) % 360

  const stateColor = (s) => s === 'executing' ? '#30ff90' : s === 'done' ? '#818cf8' : s === 'pending' ? 'rgba(255,255,255,0.3)' : '#30ff90'

  return (
    <div style={{ width: 660, fontFamily: F, color: '#fff', background: 'linear-gradient(180deg,rgba(5,2,15,1) 0%,rgba(10,5,25,1) 100%)', borderRadius: 12, overflow: 'hidden', ...gl({ padding: 0, borderRadius: 12 }) }}>
      <Shim/>
      <div style={{ position: 'relative', zIndex: 1 }}>
        {/* TOP STRIP — System Pulse */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#30ff90', opacity: pulse, boxShadow: '0 0 6px #30ff9066' }}/>
            <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: '#818cf8' }}>QuoxEngine</span>
          </div>
          {[
            { label: 'Connected', color: '#30ff90' },
            { label: '3 objectives', color: '#22d3ee' },
            { label: '8/16 agents', color: '#818cf8' },
            { label: '4.2K tokens', color: '#a78bfa' },
            { label: '14d uptime', color: '#10b981' },
          ].map((p, i) => (
            <span key={i} style={{ fontFamily: M, fontSize: 8, padding: '2px 8px', borderRadius: 8, background: `${p.color}12`, color: p.color, border: `1px solid ${p.color}25` }}>{p.label}</span>
          ))}
        </div>

        {/* MAIN BODY — 3 columns */}
        <div style={{ display: 'flex', minHeight: 460 }}>
          {/* LEFT COLUMN — Objectives + Queue */}
          <div style={{ width: 200, borderRight: '1px solid rgba(255,255,255,0.06)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', letterSpacing: 1, marginBottom: 2 }}>ACTIVE OBJECTIVES</div>
            {OFP_OBJECTIVES.map((obj, i) => (
              <div key={i} style={{ ...gl({ padding: '8px 10px', borderRadius: 8 }), borderTopColor: `${obj.color}30` }}>
                <Shim/>
                <div style={{ position: 'relative', zIndex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>{obj.id}</span>
                    {obj.state === 'zombie' && <span style={{ fontFamily: M, fontSize: 7, color: '#f59e0b', opacity: 0.6 + Math.sin(f * 0.1) * 0.4 }}>{'\u26A0'} stuck {obj.stuckMin}m</span>}
                    {obj.state === 'done' && <span style={{ fontFamily: M, fontSize: 7, color: '#30ff90' }}>{'\u2713'}</span>}
                    {obj.state === 'running' && <span style={{ fontFamily: M, fontSize: 7, color: '#30ff90' }}>{'\u25CF'}</span>}
                  </div>
                  <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 4 }}>{obj.name}</div>
                  <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: 4 }}>
                    <div style={{ width: `${obj.pct}%`, height: '100%', borderRadius: 2, background: obj.color, opacity: 0.7, transition: 'width 0.3s' }}/>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 8 }}>
                    <span style={{ color: obj.color }}>{obj.pct}%</span>
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 7, padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.04)' }}>{'\u2605'} {obj.topo}</span>
                  </div>
                </div>
              </div>
            ))}
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', letterSpacing: 1, marginTop: 6, marginBottom: 2 }}>QUEUE</div>
            {OFP_QUEUE.map((q, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', ...gl({ padding: '4px 8px', borderRadius: 6 }) }}>
                <Shim/>
                <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <span style={{ fontFamily: M, fontSize: 7, padding: '1px 5px', borderRadius: 3, background: `${q.color}20`, color: q.color, fontWeight: 600 }}>{q.priority}</span>
                  <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.8)' }}>{q.name}</span>
                </div>
              </div>
            ))}
          </div>

          {/* CENTRE COLUMN — Metrics + Node Graph */}
          <div style={{ flex: 1, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Top metric cards */}
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { label: 'Tasks Running', value: '12', color: '#30ff90' },
                { label: 'Agents Busy', value: '8', color: '#818cf8' },
                { label: 'Token Burn', value: '1.2K/hr', color: '#22d3ee' },
                { label: 'Success Rate', value: '94%', color: '#10b981' },
              ].map((m, i) => (
                <div key={i} style={{ flex: 1, ...gl({ padding: '8px 10px', borderRadius: 8 }), borderTopColor: `${m.color}30` }}>
                  <Shim/>
                  <div style={{ position: 'relative', zIndex: 1, textAlign: 'center' }}>
                    <div style={{ fontFamily: F, fontSize: 18, fontWeight: 700, color: m.color }}>{m.value}</div>
                    <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>{m.label}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Node graph area */}
            <div style={{ flex: 1, ...gl({ padding: 0, borderRadius: 8 }), minHeight: 200 }}>
              <Shim/>
              <div style={{ position: 'relative', zIndex: 1 }}>
                <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', padding: '6px 10px', letterSpacing: 1 }}>OBJECTIVE DECOMPOSITION — obj-7a3f Deploy v2.4</div>
                <svg viewBox="0 0 440 200" style={{ width: '100%', display: 'block' }}>
                  <defs>
                    <filter id="ofp-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
                  </defs>
                  {/* Edges */}
                  {OFP_GRAPH_EDGES.map(([from, to], i) => {
                    const fn = OFP_GRAPH_NODES.find(n => n.id === from)
                    const tn = OFP_GRAPH_NODES.find(n => n.id === to)
                    return <line key={i} x1={fn.x} y1={fn.y} x2={tn.x} y2={tn.y} stroke="rgba(129,140,248,0.15)" strokeWidth={1.5} strokeDasharray="4 3"/>
                  })}
                  {/* Nodes */}
                  {OFP_GRAPH_NODES.map((n, i) => {
                    const sc = n.state === 'executing' ? stateColor(n.state) : n.color
                    return <g key={i}>
                      {/* Scanning ring for active nodes */}
                      {(n.state === 'executing' || n.state === 'active') && <circle cx={n.x} cy={n.y} r={n.r + 4} fill="none" stroke={sc} strokeWidth={0.8} opacity={0.3} strokeDasharray={`${n.r * 0.8} ${n.r * 5}`} transform={`rotate(${scanAngle} ${n.x} ${n.y})`}/>}
                      <circle cx={n.x} cy={n.y} r={n.r} fill={`${n.color}15`} stroke={n.color} strokeWidth={1.2} filter="url(#ofp-glow)"/>
                      <circle cx={n.x} cy={n.y} r={3} fill={sc} opacity={n.state === 'pending' ? 0.3 : 0.8}/>
                      <text x={n.x} y={n.y - n.r - 6} textAnchor="middle" fill={n.color} fontFamily={M} fontSize={8} fontWeight={700}>{n.name}</text>
                      <text x={n.x} y={n.y + n.r + 12} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={7}>{n.task}</text>
                      {n.state === 'done' && <text x={n.x + n.r + 4} y={n.y + 3} fill="#30ff90" fontFamily={M} fontSize={8}>{'\u2713'}</text>}
                    </g>
                  })}
                </svg>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN — Events + Team + Heartbeat */}
          <div style={{ width: 220, borderLeft: '1px solid rgba(255,255,255,0.06)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', letterSpacing: 1 }}>EVENT STREAM</div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {OFP_EVENTS.map((ev, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5, opacity: lerp(f, i * 2, i * 2 + 6, 0, 1) }}>
                  <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>{ev.ts}</span>
                  <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)', lineHeight: 1.3 }}>
                    <span style={{ color: ev.color, fontWeight: 600 }}>{ev.agent}</span>{' '}{ev.text}
                  </div>
                </div>
              ))}
            </div>
            {/* Team topology mini */}
            <div style={{ ...gl({ padding: 8, borderRadius: 8 }) }}>
              <Shim/>
              <div style={{ position: 'relative', zIndex: 1 }}>
                <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>TEAM TOPOLOGY</div>
                <svg viewBox="0 0 180 80" style={{ width: '100%' }}>
                  {/* Star layout: chief centre, 4 workers */}
                  {[{ x: 90, y: 40, r: 6, c: '#3b82f6', n: 'VULCAN' }].concat(
                    [0,1,2,3].map(i => {
                      const a = (i / 4) * Math.PI * 2 - Math.PI / 2
                      const cols = ['#10b981','#6366f1','#a855f7','#f59e0b']
                      const names = ['SEN','COD','NOV','CIP']
                      return { x: 90 + Math.cos(a) * 32, y: 40 + Math.sin(a) * 28, r: 4, c: cols[i], n: names[i] }
                    })
                  ).map((n, i) => (
                    <g key={i}>
                      {i > 0 && <line x1={90} y1={40} x2={n.x} y2={n.y} stroke="rgba(255,255,255,0.08)" strokeWidth={0.5}/>}
                      <circle cx={n.x} cy={n.y} r={n.r} fill={`${n.c}25`} stroke={n.c} strokeWidth={0.8}/>
                      <text x={n.x} y={n.y + n.r + 8} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={5}>{n.n}</text>
                    </g>
                  ))}
                </svg>
              </div>
            </div>
            {/* Agent heartbeat grid */}
            <div style={{ ...gl({ padding: 8, borderRadius: 8 }) }}>
              <Shim/>
              <div style={{ position: 'relative', zIndex: 1 }}>
                <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>AGENT HEARTBEAT</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
                  {OFP_AGENTS_GRID.map(([name, color, state], i) => (
                    <div key={i} style={{ textAlign: 'center' }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, opacity: state === 'busy' ? (0.6 + Math.sin(f * 0.08 + i) * 0.4) : 0.25, margin: '0 auto 2px', boxShadow: state === 'busy' ? `0 0 4px ${color}44` : 'none' }}/>
                      <div style={{ fontFamily: M, fontSize: 5, color: 'rgba(255,255,255,0.4)' }}>{name.slice(0,3)}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* BOTTOM STRIP — Event Timeline Pills */}
        <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
          {OFP_BOTTOM_EVENTS.map((ev, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 8, background: `${ev.color}10`, border: `1px solid ${ev.color}20`, cursor: 'pointer' }}>
              <span style={{ fontSize: 10, color: ev.color }}>{ev.icon}</span>
              <span style={{ fontFamily: M, fontSize: 8, color: ev.color }}>{ev.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 10. OPSDECK WALLBOARD — TV/Wall Display Mode
// ═══════════════════════════════════════════════════════════════
const OWB_AGENTS = [
  { name: 'VULCAN', util: 92, color: '#3b82f6' },
  { name: 'WARDEN', util: 78, color: '#10b981' },
  { name: 'CODEX', util: 65, color: '#6366f1' },
  { name: 'DAEDALUS', util: 41, color: '#a855f7' },
  { name: 'CIPHER', util: 88, color: '#f59e0b' },
]
const OWB_EVENTS = [
  { text: 'VULCAN completed deployment pipeline', color: '#3b82f6', time: '2m ago' },
  { text: 'WARDEN scanning port range 1-65535', color: '#10b981', time: '3m ago' },
  { text: 'CODEX generated 47 test cases', color: '#6366f1', time: '5m ago' },
  { text: 'DAEDALUS indexed 1,200 memory entries', color: '#a855f7', time: '8m ago' },
  { text: 'CIPHER rotated TLS certificates', color: '#f59e0b', time: '12m ago' },
]

export function OpsDeckWallboard() {
  const f = useAnimFrame()
  const pulse = 0.5 + Math.sin(f * 0.04) * 0.5
  const healthPct = 89
  const healthAngle = (healthPct / 100) * 360
  const W = 650, H = 420

  return (
    <div style={{ width: W, fontFamily: F, color: '#fff', background: 'linear-gradient(180deg,rgba(3,1,8,1) 0%,rgba(8,4,18,1) 100%)', borderRadius: 12, overflow: 'hidden', ...gl({ padding: 0, borderRadius: 12 }) }}>
      <Shim/>
      <div style={{ position: 'relative', zIndex: 1 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#30ff90', opacity: pulse, boxShadow: '0 0 8px #30ff9044' }}/>
            <span style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: '#818cf8', letterSpacing: 2 }}>QUOXCORE WALLBOARD</span>
          </div>
          <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Wallboard Mode — Auto-refresh 5s</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gridTemplateRows: '1fr 1fr', gap: 0, height: H - 60 }}>
          {/* TOP LEFT — Active objectives */}
          <div style={{ padding: 14, borderRight: '1px solid rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 10 }}>ACTIVE OBJECTIVES</div>
            {OFP_OBJECTIVES.map((obj, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: F, fontSize: 13, fontWeight: 600, color: '#fff' }}>{obj.name}</span>
                  <span style={{ fontFamily: M, fontSize: 12, color: obj.color, fontWeight: 700 }}>{obj.pct}%</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div style={{ width: `${obj.pct}%`, height: '100%', borderRadius: 3, background: `linear-gradient(90deg,${obj.color}88,${obj.color})`, boxShadow: `0 0 8px ${obj.color}44` }}/>
                </div>
              </div>
            ))}
          </div>

          {/* CENTRE — Large health gauge */}
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gridRow: '1/3', borderLeft: '1px solid rgba(255,255,255,0.04)', borderRight: '1px solid rgba(255,255,255,0.04)' }}>
            <svg viewBox="0 0 180 180" style={{ width: 160, height: 160 }}>
              <defs>
                <filter id="owb-glow"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
              </defs>
              <circle cx="90" cy="90" r="78" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="8"/>
              <circle cx="90" cy="90" r="78" fill="none" stroke="#30ff90" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(healthAngle / 360) * 490} 490`} transform="rotate(-90 90 90)" filter="url(#owb-glow)" opacity="0.8"/>
              <circle cx="90" cy="90" r="65" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1"/>
              <text x="90" y="80" textAnchor="middle" fill="#fff" fontFamily={F} fontSize="36" fontWeight="700">{healthPct}</text>
              <text x="90" y="98" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontFamily={M} fontSize="10">SYSTEM HEALTH</text>
              <circle cx="90" cy="120" r="3" fill="#30ff90" opacity={pulse}/>
            </svg>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>All systems nominal</div>
          </div>

          {/* TOP RIGHT — Agent utilization */}
          <div style={{ padding: 14, borderLeft: '1px solid rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 10 }}>AGENT UTILIZATION</div>
            {OWB_AGENTS.map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontFamily: M, fontSize: 10, color: a.color, width: 65, fontWeight: 600 }}>{a.name}</span>
                <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                  <div style={{ width: `${a.util}%`, height: '100%', borderRadius: 4, background: `linear-gradient(90deg,${a.color}66,${a.color})`, boxShadow: `0 0 6px ${a.color}33` }}/>
                </div>
                <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', width: 30, textAlign: 'right' }}>{a.util}%</span>
              </div>
            ))}
          </div>

          {/* BOTTOM LEFT — Token burn */}
          <div style={{ padding: 14, borderRight: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 10 }}>TOKEN BURN RATE</div>
            <svg viewBox="0 0 200 100" style={{ width: '100%' }}>
              {/* Rate line */}
              <polyline points="0,80 30,70 60,55 90,60 120,40 150,35 180,20 200,25" fill="none" stroke="#22d3ee" strokeWidth="2" opacity="0.8"/>
              {/* Projection dashed */}
              <polyline points="180,20 200,25" fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.4"/>
              <polyline points="200,25 220,30" fill="none" stroke="#22d3ee" strokeWidth="1" strokeDasharray="4 3" opacity="0.25"/>
              {/* Fill area */}
              <polygon points="0,100 0,80 30,70 60,55 90,60 120,40 150,35 180,20 200,25 200,100" fill="url(#owb-burnfill)" opacity="0.15"/>
              <defs><linearGradient id="owb-burnfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee"/><stop offset="100%" stopColor="transparent"/></linearGradient></defs>
              <text x="5" y="15" fill="#22d3ee" fontFamily={M} fontSize="14" fontWeight="700">1,247</text>
              <text x="60" y="15" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize="8">tokens/hr</text>
              <text x="145" y="15" fill="rgba(255,255,255,0.3)" fontFamily={M} fontSize="7">{'\u2191'} 12% vs yesterday</text>
            </svg>
          </div>

          {/* BOTTOM RIGHT — Event stream */}
          <div style={{ padding: 14, borderLeft: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 10 }}>RECENT EVENTS</div>
            {OWB_EVENTS.map((ev, i) => (
              <div key={i} style={{ marginBottom: 10, opacity: lerp(f, i * 3, i * 3 + 8, 0, 1) }}>
                <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.8)', lineHeight: 1.3 }}>{ev.text}</div>
                <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>{ev.time}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 11. OPSDECK NODE DETAIL — Agent Detail Panel
// ═══════════════════════════════════════════════════════════════
const OND_HISTORY = [
  { task: 'Port scan edge-01', status: 'success', dur: '14s', tokens: 120 },
  { task: 'CVE check hyp-01-03', status: 'success', dur: '42s', tokens: 340 },
  { task: 'SSL verify api.quox.ai', status: 'success', dur: '8s', tokens: 85 },
  { task: 'Firewall audit gw-01', status: 'failed', dur: '1m 12s', tokens: 520 },
  { task: 'Network sweep 10.0.0.x', status: 'success', dur: '2m 4s', tokens: 890 },
]
const OND_CAPS = ['fleet_scan', 'port_check', 'vuln_scan', 'ssl_verify', 'log_analysis', 'threat_detect']
const OND_LOGS = [
  { ts: '14:32:04', text: 'Initiated TCP SYN scan on 10.0.0.101-104 ports 1-1024' },
  { ts: '14:32:06', text: 'edge-01: 22/tcp open, 80/tcp open, 443/tcp open, 9848/tcp open' },
  { ts: '14:32:08', text: 'edge-02: 22/tcp open, 80/tcp open, 443/tcp open — no anomalies' },
]
const OND_SPARKLINE = [1,1,1,0,1,1,1,1,0,1,1,1,1,1,0,1,1,1,1,1]

export function OpsDeckNodeDetail() {
  const f = useAnimFrame()
  const scanAngle = (f * 3) % 360
  const pulse = 0.6 + Math.sin(f * 0.06) * 0.4

  return (
    <div style={{ width: 420, fontFamily: F, color: '#fff' }}>
      {/* Agent header */}
      <GP style={{ padding: '16px 20px', marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{ position: 'relative', width: 56, height: 56, flexShrink: 0 }}>
            <svg viewBox="0 0 60 60" style={{ width: '100%', height: '100%' }}>
              <circle cx="30" cy="30" r="24" fill="rgba(16,185,129,0.08)" stroke="#10b981" strokeWidth="1.5"/>
              <circle cx="30" cy="30" r="28" fill="none" stroke="#10b981" strokeWidth="0.8" opacity="0.3" strokeDasharray="8 20" transform={`rotate(${scanAngle} 30 30)`}/>
              <text x="30" y="34" textAnchor="middle" fill="#10b981" fontFamily={M} fontSize="14" fontWeight="700">S</text>
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: F, fontSize: 20, fontWeight: 700, color: '#10b981' }}>WARDEN</div>
            <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>Security Specialist</div>
          </div>
          <div style={{ padding: '4px 12px', borderRadius: 6, background: 'rgba(48,255,144,0.12)', border: '1px solid rgba(48,255,144,0.25)' }}>
            <span style={{ fontFamily: M, fontSize: 9, color: '#30ff90', fontWeight: 600 }}>EXECUTING</span>
          </div>
        </div>
      </GP>

      {/* Stats row — 3 mini gauges */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[
          { label: 'Success', value: 94, color: '#30ff90' },
          { label: 'Latency', value: 12, max: 100, color: '#22d3ee', suffix: 'ms' },
          { label: 'Load', value: 67, color: '#f59e0b' },
        ].map((g, i) => (
          <GP key={i} style={{ flex: 1, padding: '10px 12px', textAlign: 'center' }}>
            <svg viewBox="0 0 50 30" style={{ width: 50, height: 30, margin: '0 auto' }}>
              <path d={`M 5 25 A 20 20 0 0 1 45 25`} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" strokeLinecap="round"/>
              <path d={`M 5 25 A 20 20 0 0 1 45 25`} fill="none" stroke={g.color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${((g.value) / (g.max || 100)) * 63} 63`} opacity="0.8"/>
            </svg>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: g.color }}>{g.value}{g.suffix || '%'}</div>
            <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.5)' }}>{g.label}</div>
          </GP>
        ))}
      </div>

      {/* Current task */}
      <GP style={{ padding: '10px 14px', marginBottom: 8, borderTopColor: 'rgba(48,255,144,0.2)' }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 4 }}>CURRENT TASK</div>
        <div style={{ fontFamily: F, fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 6 }}>Port scan edge-01-04</div>
        <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
          <div style={{ width: '45%', height: '100%', borderRadius: 2, background: '#10b981', opacity: 0.7 }}/>
        </div>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>45% complete — elapsed 1m 12s</div>
      </GP>

      {/* Capabilities */}
      <GP style={{ padding: '10px 14px', marginBottom: 8 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 6 }}>CAPABILITIES</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {OND_CAPS.map((cap, i) => (
            <span key={i} style={{ fontFamily: M, fontSize: 8, padding: '3px 8px', borderRadius: 6, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', color: '#10b981' }}>{cap}</span>
          ))}
        </div>
      </GP>

      {/* Recent history + sparkline */}
      <GP style={{ padding: '10px 14px', marginBottom: 8 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 6 }}>RECENT HISTORY</div>
        {OND_HISTORY.map((h, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 10 }}>
            <span style={{ color: h.status === 'success' ? '#30ff90' : '#ef4444', fontSize: 10 }}>{h.status === 'success' ? '\u2713' : '\u2717'}</span>
            <span style={{ flex: 1, fontFamily: F, color: 'rgba(255,255,255,0.8)' }}>{h.task}</span>
            <span style={{ fontFamily: M, color: 'rgba(255,255,255,0.5)', fontSize: 8 }}>{h.dur}</span>
            <span style={{ fontFamily: M, color: 'rgba(255,255,255,0.4)', fontSize: 8 }}>{h.tokens}t</span>
          </div>
        ))}
        <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)', marginTop: 6, marginBottom: 4 }}>PERFORMANCE (last 20 runs)</div>
        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end' }}>
          {OND_SPARKLINE.map((v, i) => (
            <div key={i} style={{ width: 8, height: v ? 14 : 14, borderRadius: 2, background: v ? '#30ff90' : '#ef4444', opacity: v ? 0.6 : 0.5 }}/>
          ))}
        </div>
      </GP>

      {/* Live feed */}
      <GP style={{ padding: '10px 14px', marginBottom: 8 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 6 }}>LIVE FEED</div>
        {OND_LOGS.map((log, i) => (
          <div key={i} style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 4, lineHeight: 1.3 }}>
            <span style={{ color: 'rgba(255,255,255,0.4)' }}>{log.ts}</span>{' '}{log.text}
          </div>
        ))}
      </GP>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        {[
          { label: '\u23F8 Pause', color: '#f59e0b' },
          { label: '\u21BB Reassign', color: '#818cf8' },
          { label: '\u25B6 View Logs', color: '#22d3ee' },
        ].map((a, i) => (
          <div key={i} style={{ flex: 1, textAlign: 'center', padding: '8px 0', borderRadius: 8, background: `${a.color}10`, border: `1px solid ${a.color}25`, cursor: 'pointer' }}>
            <span style={{ fontFamily: M, fontSize: 10, color: a.color, fontWeight: 600 }}>{a.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 12. OPSDECK OBJECTIVE DETAIL — Expanded Objective View
// ═══════════════════════════════════════════════════════════════
const OOD_TASKS = [
  { name: 'Pull images', agent: 'VULCAN', status: 'done', dur: '14s', indent: 0 },
  { name: 'Run migrations', agent: 'CODEX', status: 'done', dur: '42s', indent: 0 },
  { name: 'Health check', agent: 'WARDEN', status: 'running', dur: '1m 12s', indent: 0 },
  { name: 'Update DNS', agent: null, status: 'pending', dur: null, indent: 1, depends: 'Health check' },
  { name: 'Notify team', agent: null, status: 'pending', dur: null, indent: 0 },
  { name: 'Verify deploy', agent: null, status: 'pending', dur: null, indent: 0 },
]
const OOD_EVIDENCE = [
  { hash: '8f3a2c...d71e', type: 'execution_result', ts: '14:31:48' },
  { hash: 'a2c1b4...9f3a', type: 'approval_decision', ts: '14:31:15' },
  { hash: 'f7d2e8...1a4b', type: 'policy_evaluation', ts: '14:30:02' },
  { hash: '3b1c5a...e72d', type: 'node_output', ts: '14:31:35' },
]
const OOD_TIMELINE = [
  { ts: '14:29:58', text: 'Objective created by admin@example.com' },
  { ts: '14:30:00', text: 'Decomposed into 6 tasks' },
  { ts: '14:30:01', text: 'Team assigned: VULCAN (chief) + 3 workers' },
  { ts: '14:30:02', text: 'Policy: deploy.production approved' },
  { ts: '14:30:05', text: 'VULCAN started Pull images' },
  { ts: '14:30:19', text: 'Pull images completed (14s)' },
  { ts: '14:31:00', text: 'Health check started by WARDEN' },
]

export function OpsDeckObjectiveDetail() {
  const f = useAnimFrame()
  const pulse = 0.6 + Math.sin(f * 0.06) * 0.4
  const elapsed = '4m 23s'
  const tokensUsed = 1247, tokenBudget = 5000, tokenPct = (tokensUsed / tokenBudget) * 100

  return (
    <div style={{ width: 480, fontFamily: F, color: '#fff' }}>
      {/* Header */}
      <GP style={{ padding: '14px 18px', marginBottom: 8, borderTopColor: 'rgba(129,140,248,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: '#fff' }}>Deploy v2.4 to Production</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>obj-7a3f — created by admin@example.com</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontFamily: M, fontSize: 9, padding: '3px 10px', borderRadius: 6, background: 'rgba(48,255,144,0.1)', color: '#30ff90', fontWeight: 600, border: '1px solid rgba(48,255,144,0.2)' }}>RUNNING</span>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>{elapsed}</span>
          </div>
        </div>
      </GP>

      {/* Decomposition tree */}
      <GP style={{ padding: '12px 16px', marginBottom: 8 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>DECOMPOSITION TREE</div>
        {OOD_TASKS.map((t, i) => {
          const icon = t.status === 'done' ? '\u2713' : t.status === 'running' ? '\u25B6' : t.indent > 0 ? '\u2192' : '\u25CB'
          const iconColor = t.status === 'done' ? '#30ff90' : t.status === 'running' ? '#22d3ee' : 'rgba(255,255,255,0.3)'
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, paddingLeft: t.indent * 20 }}>
              <span style={{ color: iconColor, fontSize: 11, width: 14, textAlign: 'center', opacity: t.status === 'running' ? pulse : 1 }}>{icon}</span>
              <span style={{ fontFamily: F, fontSize: 12, color: t.status === 'pending' ? 'rgba(255,255,255,0.4)' : '#fff', flex: 1 }}>{t.name}</span>
              {t.agent && <span style={{ fontFamily: M, fontSize: 8, color: '#818cf8' }}>{t.agent}</span>}
              {t.dur && <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{t.dur}</span>}
              {t.depends && <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>depends on {t.depends}</span>}
            </div>
          )
        })}
      </GP>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {/* Budget panel */}
        <GP style={{ flex: 1, padding: '12px 14px' }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 6 }}>TOKEN BUDGET</div>
          <svg viewBox="0 0 120 70" style={{ width: '100%' }}>
            <path d="M 10 55 A 50 50 0 0 1 110 55" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" strokeLinecap="round"/>
            <path d="M 10 55 A 50 50 0 0 1 110 55" fill="none" stroke="#30ff90" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${tokenPct * 1.57} 157`}/>
            <text x="60" y="45" textAnchor="middle" fill="#fff" fontFamily={M} fontSize="12" fontWeight="700">{tokensUsed.toLocaleString()}</text>
            <text x="60" y="57" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize="8">/ {tokenBudget.toLocaleString()}</text>
          </svg>
          <div style={{ fontFamily: M, fontSize: 8, color: '#30ff90', textAlign: 'center', marginTop: 4 }}>Within budget — projected OK</div>
        </GP>

        {/* Team panel */}
        <GP style={{ flex: 1, padding: '12px 14px' }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 6 }}>TEAM — Star Topology</div>
          <svg viewBox="0 0 120 80" style={{ width: '100%' }}>
            {[0,1,2,3].map(i => {
              const a = (i / 4) * Math.PI * 2 - Math.PI / 2
              const cols = ['#10b981','#6366f1','#a855f7','#f59e0b']
              const names = ['SEN','COD','NOV','CIP']
              const x = 60 + Math.cos(a) * 35, y = 40 + Math.sin(a) * 28
              return <g key={i}>
                <line x1={60} y1={40} x2={x} y2={y} stroke="rgba(255,255,255,0.08)" strokeWidth={0.5}/>
                <circle cx={x} cy={y} r={5} fill={`${cols[i]}20`} stroke={cols[i]} strokeWidth={0.8}/>
                <text x={x} y={y + 12} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontFamily={M} fontSize={6}>{names[i]}</text>
              </g>
            })}
            <circle cx={60} cy={40} r={7} fill="rgba(59,130,246,0.15)" stroke="#3b82f6" strokeWidth={1}/>
            <text x={60} y={43} textAnchor="middle" fill="#3b82f6" fontFamily={M} fontSize={7} fontWeight={700}>F</text>
            <text x={60} y={57} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontFamily={M} fontSize={6}>Chief: VULCAN</text>
          </svg>
        </GP>
      </div>

      {/* Evidence */}
      <GP style={{ padding: '10px 14px', marginBottom: 8 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 6 }}>VOLT EVIDENCE — {OOD_EVIDENCE.length} records</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {OOD_EVIDENCE.map((e, i) => (
            <div key={i} style={{ fontFamily: M, fontSize: 8, padding: '3px 8px', borderRadius: 6, background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.15)', color: '#818cf8' }}>
              {e.hash} <span style={{ color: 'rgba(255,255,255,0.4)' }}>{e.type}</span>
            </div>
          ))}
        </div>
      </GP>

      {/* Timeline */}
      <GP style={{ padding: '10px 14px' }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 6 }}>OBJECTIVE TIMELINE</div>
        <div style={{ position: 'relative', paddingLeft: 16 }}>
          <div style={{ position: 'absolute', left: 4, top: 2, bottom: 2, width: 1, background: 'rgba(255,255,255,0.06)' }}/>
          {OOD_TIMELINE.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, position: 'relative' }}>
              <div style={{ position: 'absolute', left: -14, top: 5, width: 5, height: 5, borderRadius: '50%', background: i === OOD_TIMELINE.length - 1 ? '#22d3ee' : 'rgba(255,255,255,0.2)' }}/>
              <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>{t.ts}</span>
              <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>{t.text}</span>
            </div>
          ))}
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 13. OPSDECK METRIC STRIP — Compact Rich Metrics Bar
// ═══════════════════════════════════════════════════════════════
const OMS_METRICS = [
  { label: 'Objectives', value: '3', color: '#30ff90', viz: 'dot' },
  { label: 'Tasks', value: '12/18', color: '#818cf8', viz: 'ring', pct: 67 },
  { label: 'Agents', value: '8/16', color: '#22d3ee', viz: 'bar', pct: 50 },
  { label: 'Tokens/hr', value: '1.2K', color: '#a78bfa', viz: 'spark', trend: 'up' },
  { label: 'Cost Today', value: '$4.27', color: '#f59e0b', viz: 'compare', prev: '$3.89' },
  { label: 'Success', value: '94%', color: '#10b981', viz: 'ring', pct: 94 },
  { label: 'Latency', value: '14ms', color: '#30ff90', viz: 'badge' },
  { label: 'VOLT', value: '148K', color: '#ec4899', viz: 'counter' },
]

export function OpsDeckMetricStrip() {
  const f = useAnimFrame()
  const pulse = 0.6 + Math.sin(f * 0.06) * 0.4

  return (
    <div style={{ display: 'flex', gap: 4, width: 660, fontFamily: F }}>
      {OMS_METRICS.map((m, i) => (
        <div key={i} style={{ flex: 1, ...gl({ padding: '6px 6px', borderRadius: 8 }), borderTopColor: `${m.color}20`, textAlign: 'center' }}>
          <Shim/>
          <div style={{ position: 'relative', zIndex: 1 }}>
            {/* Mini visualization */}
            <div style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}>
              {m.viz === 'dot' && <div style={{ width: 8, height: 8, borderRadius: '50%', background: m.color, opacity: pulse, boxShadow: `0 0 6px ${m.color}44` }}/>}
              {m.viz === 'ring' && <svg viewBox="0 0 20 20" style={{ width: 18, height: 18 }}>
                <circle cx="10" cy="10" r="7" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2.5"/>
                <circle cx="10" cy="10" r="7" fill="none" stroke={m.color} strokeWidth="2.5" strokeDasharray={`${(m.pct / 100) * 44} 44`} transform="rotate(-90 10 10)" strokeLinecap="round" opacity="0.8"/>
              </svg>}
              {m.viz === 'bar' && <div style={{ width: '80%', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${m.pct}%`, height: '100%', borderRadius: 2, background: m.color, opacity: 0.7 }}/>
              </div>}
              {m.viz === 'spark' && <svg viewBox="0 0 30 14" style={{ width: 30, height: 14 }}>
                <polyline points="0,12 5,10 10,8 15,9 20,5 25,3 30,4" fill="none" stroke={m.color} strokeWidth="1.5" opacity="0.7"/>
              </svg>}
              {m.viz === 'compare' && <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>vs {m.prev}</span>}
              {m.viz === 'badge' && <div style={{ padding: '1px 6px', borderRadius: 4, background: `${m.color}15`, fontSize: 7, fontFamily: M, color: m.color }}>{'\u2713'} OK</div>}
              {m.viz === 'counter' && <span style={{ fontFamily: M, fontSize: 8, color: m.color, opacity: 0.7 }}>records</span>}
            </div>
            <div style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: m.color }}>{m.value}</div>
            <div style={{ fontFamily: M, fontSize: 6, color: 'rgba(255,255,255,0.5)', marginTop: 1 }}>{m.label}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 14. OPSDECK 3D CONTROL ROOM — Perspective Command Centre
// ═══════════════════════════════════════════════════════════════
export function OpsDeck3DControlRoom() {
  const f = useAnimFrame()
  const pulse = 0.5 + Math.sin(f * 0.04) * 0.5
  const W = 660, H = 440

  // 5 floating panels in an arc
  const panels = [
    { label: 'AGENT FLEET', x: -38, y: 6, w: 100, h: 160, rot: 25, scale: 0.85, content: 'agents' },
    { label: 'NODE GRAPH', x: 16, y: -8, w: 120, h: 170, rot: 12, scale: 0.92, content: 'graph' },
    { label: 'OBJECTIVE VIEW', x: 36, y: -14, w: 140, h: 180, rot: 0, scale: 1, content: 'main' },
    { label: 'EVENT STREAM', x: 56, y: -8, w: 120, h: 170, rot: -12, scale: 0.92, content: 'events' },
    { label: 'METRICS', x: 78, y: 6, w: 100, h: 160, rot: -25, scale: 0.85, content: 'metrics' },
  ]

  const agentNames = ['VULCAN','SEN','COD','NOV','CIP','ATL','BEA','COR']
  const agentColors = ['#3b82f6','#10b981','#6366f1','#a855f7','#f59e0b','#8b5cf6','#22d3ee','#ec4899']

  return (
    <div style={{ width: W, height: H, fontFamily: F, color: '#fff', background: 'linear-gradient(180deg,rgba(2,1,8,1) 0%,rgba(6,3,15,1) 40%,rgba(10,5,20,1) 100%)', borderRadius: 12, overflow: 'hidden', position: 'relative', ...gl({ padding: 0, borderRadius: 12 }) }}>
      <Shim/>
      <div style={{ position: 'relative', zIndex: 1, width: '100%', height: '100%' }}>
        {/* Header */}
        <div style={{ position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center', zIndex: 10 }}>
          <span style={{ fontFamily: M, fontSize: 14, fontWeight: 700, letterSpacing: 4, background: 'linear-gradient(90deg,#818cf8,#22d3ee,#a78bfa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>QUOXCORE COMMAND CENTER</span>
        </div>

        {/* Holo-grid floor */}
        <svg viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0 }}>
          <defs>
            <filter id="cr-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>
          {/* Floor grid lines */}
          {Array.from({ length: 20 }, (_, i) => {
            const t = i / 19
            const y = H * 0.55 + t * t * H * 0.4
            const spread = t * W * 0.5
            return <line key={`h-${i}`} x1={W / 2 - spread} y1={y} x2={W / 2 + spread} y2={y} stroke="#818cf8" strokeWidth={0.4} opacity={t * 0.12}/>
          })}
          {Array.from({ length: 14 }, (_, i) => {
            const t = (i / 13 - 0.5) * 2
            return <line key={`v-${i}`} x1={W / 2 + t * 15} y1={H * 0.55} x2={W / 2 + t * W * 0.5} y2={H} stroke="#818cf8" strokeWidth={0.3} opacity={0.06}/>
          })}
          {/* Floor wave effect */}
          {Array.from({ length: 3 }, (_, i) => {
            const waveY = H * 0.7 + i * 30
            const wavePhase = f * 0.02 + i * 0.5
            const pts = Array.from({ length: 20 }, (_, j) => {
              const x = j * (W / 19)
              const y = waveY + Math.sin(j * 0.5 + wavePhase) * 3
              return `${x},${y}`
            }).join(' ')
            return <polyline key={`wave-${i}`} points={pts} fill="none" stroke="#818cf8" strokeWidth={0.3} opacity={0.08}/>
          })}
          {/* Ambient particles */}
          {Array.from({ length: 40 }, (_, i) => (
            <circle key={`p-${i}`} cx={(Math.sin(i * 7.3 + f * 0.003) * 0.5 + 0.5) * W} cy={(Math.cos(i * 4.1 + f * 0.002) * 0.5 + 0.5) * H} r={0.6} fill="rgba(255,255,255,1)" opacity={0.04 + Math.sin(f * 0.02 + i) * 0.02}/>
          ))}
        </svg>

        {/* 5 floating panels with perspective */}
        <div style={{ position: 'absolute', inset: 0, perspective: '800px', perspectiveOrigin: '50% 40%' }}>
          {panels.map((p, i) => {
            const left = `${p.x}%`
            const top = `${30 + p.y}%`
            const floatY = Math.sin(f * 0.03 + i * 1.2) * 3
            return (
              <div key={i} style={{
                position: 'absolute', left, top, width: p.w, transform: `rotateY(${p.rot}deg) scale(${p.scale}) translateY(${floatY}px)`,
                transformStyle: 'preserve-3d', ...gl({ padding: '6px 8px', borderRadius: 6 }),
                borderTopColor: 'rgba(129,140,248,0.25)', boxShadow: `0 8px 32px rgba(0,0,0,0.6),0 0 20px rgba(129,140,248,0.05)`
              }}>
                <Shim/>
                <div style={{ position: 'relative', zIndex: 1 }}>
                  <div style={{ fontFamily: M, fontSize: 6, color: 'rgba(129,140,248,0.6)', letterSpacing: 1, marginBottom: 4 }}>{p.label}</div>

                  {p.content === 'agents' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {agentNames.map((n, ai) => (
                        <div key={ai} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <div style={{ width: 4, height: 4, borderRadius: '50%', background: agentColors[ai], opacity: ai < 5 ? 0.8 : 0.3 }}/>
                          <span style={{ fontFamily: M, fontSize: 6, color: 'rgba(255,255,255,0.6)' }}>{n}</span>
                          <span style={{ fontFamily: M, fontSize: 5, color: ai < 5 ? '#30ff90' : 'rgba(255,255,255,0.3)', marginLeft: 'auto' }}>{ai < 5 ? 'busy' : 'idle'}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {p.content === 'graph' && (
                    <svg viewBox="0 0 100 120" style={{ width: '100%' }}>
                      {/* Simplified node graph */}
                      <circle cx="50" cy="30" r="8" fill="rgba(59,130,246,0.15)" stroke="#3b82f6" strokeWidth="0.8"/>
                      <text x="50" y="33" textAnchor="middle" fill="#3b82f6" fontFamily={M} fontSize="5">VULCAN</text>
                      {[0,1,2,3].map(j => {
                        const a = (j / 4) * Math.PI * 2 - Math.PI / 2
                        const x = 50 + Math.cos(a + 0.8) * 35, y = 75 + Math.sin(a + 0.8) * 25
                        return <g key={j}>
                          <line x1={50} y1={38} x2={x} y2={y - 5} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5"/>
                          <circle cx={x} cy={y} r={5} fill={`${agentColors[j + 1]}15`} stroke={agentColors[j + 1]} strokeWidth="0.5"/>
                        </g>
                      })}
                    </svg>
                  )}

                  {p.content === 'main' && (
                    <div>
                      <div style={{ fontFamily: F, fontSize: 10, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Deploy v2.4</div>
                      <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', marginBottom: 4, overflow: 'hidden' }}>
                        <div style={{ width: '67%', height: '100%', borderRadius: 2, background: '#30ff90', opacity: 0.7 }}/>
                      </div>
                      <div style={{ fontFamily: M, fontSize: 7, color: '#30ff90', marginBottom: 8 }}>67% — 4/6 tasks</div>
                      {['Pull images \u2713','Run migrations \u2713','Health check \u25B6','Update DNS \u25CB','Notify team \u25CB','Verify \u25CB'].map((t, ti) => (
                        <div key={ti} style={{ fontFamily: M, fontSize: 6, color: ti < 2 ? '#30ff90' : ti === 2 ? '#22d3ee' : 'rgba(255,255,255,0.3)', marginBottom: 2 }}>{t}</div>
                      ))}
                    </div>
                  )}

                  {p.content === 'events' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {OFP_EVENTS.slice(0, 6).map((ev, ei) => (
                        <div key={ei} style={{ fontFamily: M, fontSize: 5.5, color: 'rgba(255,255,255,0.6)', lineHeight: 1.3 }}>
                          <span style={{ color: 'rgba(255,255,255,0.3)' }}>{ev.ts}</span>{' '}<span style={{ color: ev.color }}>{ev.agent}</span>{' '}{ev.text.slice(0, 25)}...
                        </div>
                      ))}
                    </div>
                  )}

                  {p.content === 'metrics' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {[
                        { label: 'Success', value: '94%', color: '#30ff90' },
                        { label: 'Latency', value: '14ms', color: '#22d3ee' },
                        { label: 'Tasks', value: '12/18', color: '#818cf8' },
                        { label: 'Tokens', value: '4.2K', color: '#a78bfa' },
                        { label: 'Agents', value: '8/16', color: '#10b981' },
                      ].map((m, mi) => (
                        <div key={mi} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontFamily: M, fontSize: 6, color: 'rgba(255,255,255,0.5)' }}>{m.label}</span>
                          <span style={{ fontFamily: M, fontSize: 8, color: m.color, fontWeight: 700 }}>{m.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Bottom HUD */}
        <div style={{ position: 'absolute', bottom: 10, left: 16, right: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#30ff90', opacity: pulse }}/>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>CONNECTED</span>
          </div>
          <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>3 objectives | 8 agents active | 1.2K tokens/hr</span>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 15. OPSDECK AGENT GRID — Enhanced Fleet Grid
// ═══════════════════════════════════════════════════════════════
const OAG_AGENTS = [
  { name: 'QUOX', role: 'orchestrator', shape: '\u25C6', state: 'active', task: 'Coordinating deploy', color: '#818cf8', beat: '0s' },
  { name: 'VULCAN', role: 'manager', shape: '\u25C7', state: 'executing', task: 'PR review #142', color: '#3b82f6', beat: '1s' },
  { name: 'WARDEN', role: 'specialist', shape: '\u25B3', state: 'executing', task: 'Port scan edge-01', color: '#10b981', beat: '0s' },
  { name: 'DAEDALUS', role: 'specialist', shape: '\u25B3', state: 'executing', task: 'Index memories', color: '#a855f7', beat: '2s' },
  { name: 'CIPHER', role: 'specialist', shape: '\u25B3', state: 'executing', task: 'Decrypt payload', color: '#f59e0b', beat: '1s' },
  { name: 'CODEX', role: 'specialist', shape: '\u25B3', state: 'executing', task: 'Generate tests', color: '#6366f1', beat: '0s' },
  { name: 'HYPERION', role: 'specialist', shape: '\u25B3', state: 'idle', task: null, color: '#8b5cf6', beat: '4s' },
  { name: 'VIGIL', role: 'specialist', shape: '\u25B3', state: 'idle', task: null, color: '#22d3ee', beat: '3s' },
  { name: 'COREY', role: 'specialist', shape: '\u25B3', state: 'executing', task: 'Build docker image', color: '#ec4899', beat: '1s' },
  { name: 'MESHNET', role: 'specialist', shape: '\u25B3', state: 'idle', task: null, color: '#06b6d4', beat: '5s' },
  { name: 'NETWATCH', role: 'specialist', shape: '\u25B3', state: 'executing', task: 'Monitor bandwidth', color: '#ef4444', beat: '0s' },
  { name: 'ORACLE', role: 'specialist', shape: '\u25B3', state: 'idle', task: null, color: '#14b8a6', beat: '8s' },
  { name: 'INSIGHT', role: 'specialist', shape: '\u25B3', state: 'idle', task: null, color: '#f97316', beat: '6s' },
  { name: 'METRICS', role: 'specialist', shape: '\u25B3', state: 'idle', task: null, color: '#84cc16', beat: '4s' },
  { name: 'GEMINI', role: 'plugin', shape: '\u25CB', state: 'blocked', task: 'Waiting for API', color: '#d946ef', beat: '12s' },
  { name: 'ARCHIVIST', role: 'specialist', shape: '\u25B3', state: 'idle', task: null, color: '#38bdf8', beat: '7s' },
]
const OAG_STATE_COLORS = { active: '#818cf8', executing: '#30ff90', idle: 'rgba(255,255,255,0.4)', blocked: '#ef4444' }

export function OpsDeckAgentGrid() {
  const f = useAnimFrame()
  const active = OAG_AGENTS.filter(a => a.state === 'executing' || a.state === 'active').length
  const blocked = OAG_AGENTS.filter(a => a.state === 'blocked').length
  const idle = OAG_AGENTS.filter(a => a.state === 'idle').length

  return (
    <div style={{ width: 520, fontFamily: F, color: '#fff' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8 }}>AGENT FLEET GRID</div>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 10, display: 'flex', gap: 12 }}>
        <span>{OAG_AGENTS.length} agents</span>
        <span style={{ color: '#30ff90' }}>{active} active</span>
        <span style={{ color: '#ef4444' }}>{blocked} blocked</span>
        <span>{idle} idle</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
        {OAG_AGENTS.map((a, i) => {
          const sc = OAG_STATE_COLORS[a.state] || 'rgba(255,255,255,0.3)'
          const scanSpeed = a.state === 'executing' ? 3 : a.state === 'active' ? 2 : 0
          const scanAngle = scanSpeed ? (f * scanSpeed) % 360 : 0
          const isBlocked = a.state === 'blocked'
          return (
            <GP key={i} style={{
              padding: '8px 10px', borderRadius: 8,
              borderTopColor: isBlocked ? 'rgba(239,68,68,0.3)' : `${a.color}20`,
              boxShadow: isBlocked ? `0 0 8px rgba(239,68,68,${0.1 + Math.sin(f * 0.1) * 0.1})` : undefined
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <div style={{ position: 'relative', width: 20, height: 20 }}>
                  <svg viewBox="0 0 24 24" style={{ width: '100%', height: '100%' }}>
                    <circle cx="12" cy="12" r="8" fill={`${a.color}15`} stroke={a.color} strokeWidth="1"/>
                    {scanSpeed > 0 && <circle cx="12" cy="12" r="10" fill="none" stroke={sc} strokeWidth="0.6" opacity="0.4" strokeDasharray="6 20" transform={`rotate(${scanAngle} 12 12)`}/>}
                  </svg>
                </div>
                <div>
                  <div style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: a.color }}>{a.shape} {a.name}</div>
                  <div style={{ fontFamily: M, fontSize: 7, color: sc }}>{a.state}</div>
                </div>
              </div>
              {a.task && <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.task}</div>}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
                <div style={{ width: 4, height: 4, borderRadius: '50%', background: sc, opacity: a.state === 'idle' ? 0.3 : (0.5 + Math.sin(f * 0.08 + i) * 0.5) }}/>
                <span style={{ fontFamily: M, fontSize: 6, color: 'rgba(255,255,255,0.35)' }}>beat {a.beat} ago</span>
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 16. OPSDECK EVENT STREAM — Rich Event Feed
// ═══════════════════════════════════════════════════════════════
const OES_TYPE_MAP = {
  started: { icon: '\u25B6', color: '#22d3ee' },
  completed: { icon: '\u2713', color: '#30ff90' },
  failed: { icon: '\u2717', color: '#ef4444' },
  retried: { icon: '\u21BB', color: '#f59e0b' },
  delegated: { icon: '\u26A1', color: '#818cf8' },
  paused: { icon: '\u23F8', color: '#a78bfa' },
}
const OES_EVENTS = [
  { type: 'started', agent: 'WARDEN', agentColor: '#10b981', desc: 'Port scan edge-01-04', obj: 'obj-7a3f', time: '12s ago', severity: 'info' },
  { type: 'completed', agent: 'VULCAN', agentColor: '#3b82f6', desc: 'PR review #142 merged', obj: 'obj-7a3f', time: '45s ago', severity: 'success' },
  { type: 'delegated', agent: 'QUOX', agentColor: '#818cf8', desc: 'Delegated health check to WARDEN', obj: 'obj-7a3f', time: '1m ago', severity: 'info' },
  { type: 'completed', agent: 'CODEX', agentColor: '#6366f1', desc: 'Generated 47 test cases for auth', obj: 'obj-8b2c', time: '2m ago', severity: 'success' },
  { type: 'failed', agent: 'CIPHER', agentColor: '#f59e0b', desc: 'TLS handshake timeout on hyp-03', obj: 'obj-1d4e', time: '3m ago', severity: 'error' },
  { type: 'retried', agent: 'CIPHER', agentColor: '#f59e0b', desc: 'Retrying TLS handshake (attempt 2/3)', obj: 'obj-1d4e', time: '3m ago', severity: 'warning' },
  { type: 'completed', agent: 'DAEDALUS', agentColor: '#a855f7', desc: 'Memory indexing complete (1,200 entries)', obj: null, time: '5m ago', severity: 'success' },
  { type: 'started', agent: 'COREY', agentColor: '#ec4899', desc: 'Building Docker image quoxai/api:2.4.1', obj: 'obj-7a3f', time: '6m ago', severity: 'info' },
  { type: 'paused', agent: 'HYPERION', agentColor: '#8b5cf6', desc: 'Paused — awaiting approval for subnet scan', obj: 'obj-8b2c', time: '8m ago', severity: 'warning' },
  { type: 'delegated', agent: 'VULCAN', agentColor: '#3b82f6', desc: 'Delegated cert rotation to CIPHER', obj: 'obj-1d4e', time: '10m ago', severity: 'info' },
  { type: 'completed', agent: 'NETWATCH', agentColor: '#ef4444', desc: 'Bandwidth monitoring report generated', obj: null, time: '12m ago', severity: 'success' },
  { type: 'started', agent: 'METRICS', agentColor: '#84cc16', desc: 'Collecting system metrics snapshot', obj: null, time: '15m ago', severity: 'info' },
]
const OES_SEVERITY_DOT = { success: '#30ff90', error: '#ef4444', warning: '#f59e0b', info: 'rgba(255,255,255,0.3)' }

export function OpsDeckEventStream() {
  const f = useAnimFrame()
  const [filter, setFilter] = useState('all')
  const pulse = 0.5 + Math.sin(f * 0.08) * 0.5
  const filtered = filter === 'all' ? OES_EVENTS : OES_EVENTS.filter(e =>
    filter === 'tasks' ? ['started','completed'].includes(e.type) :
    filter === 'delegation' ? e.type === 'delegated' :
    filter === 'errors' ? ['failed','retried'].includes(e.type) : true
  )

  return (
    <div style={{ width: 480, fontFamily: F, color: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1 }}>EVENT STREAM</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#30ff90', opacity: pulse, boxShadow: '0 0 6px #30ff9044' }}/>
          <span style={{ fontFamily: M, fontSize: 8, color: '#30ff90' }}>Live</span>
        </div>
      </div>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {['all', 'tasks', 'delegation', 'errors'].map(fi => (
          <div key={fi} onClick={() => setFilter(fi)} style={{
            fontFamily: M, fontSize: 8, padding: '3px 10px', borderRadius: 8, cursor: 'pointer',
            background: filter === fi ? 'rgba(129,140,248,0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${filter === fi ? 'rgba(129,140,248,0.3)' : 'rgba(255,255,255,0.06)'}`,
            color: filter === fi ? '#818cf8' : 'rgba(255,255,255,0.5)',
          }}>{fi.charAt(0).toUpperCase() + fi.slice(1)}</div>
        ))}
      </div>

      {/* Event list */}
      <div style={{ maxHeight: 400, overflow: 'hidden' }}>
        {filtered.map((ev, i) => {
          const t = OES_TYPE_MAP[ev.type] || { icon: '?', color: '#fff' }
          const slideIn = lerp(f, i * 2, i * 2 + 5, 10, 0)
          const fadeIn = lerp(f, i * 2, i * 2 + 5, 0, 1)
          return (
            <div key={i} style={{ marginBottom: 4, opacity: fadeIn, transform: `translateY(${slideIn}px)` }}>
              <GP style={{ padding: '8px 12px', borderRadius: 8, borderTopColor: `${t.color}15` }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  {/* Type icon */}
                  <div style={{ width: 22, height: 22, borderRadius: 6, background: `${t.color}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: `1px solid ${t.color}20` }}>
                    <span style={{ fontSize: 10, color: t.color }}>{t.icon}</span>
                  </div>
                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.85)', lineHeight: 1.3 }}>
                      <span style={{ color: ev.agentColor, fontWeight: 600 }}>{ev.agent}</span>{' '}{ev.desc}
                    </div>
                    {ev.obj && <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.35)', marginTop: 2, display: 'inline-block' }}>{ev.obj}</span>}
                  </div>
                  {/* Right: time + severity */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                    <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{ev.time}</span>
                    <div style={{ width: 5, height: 5, borderRadius: '50%', background: OES_SEVERITY_DOT[ev.severity] || 'rgba(255,255,255,0.2)' }}/>
                  </div>
                </div>
              </GP>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 17. OPSDECK 3D NUCLEUS — Detailed Cognitive Nucleus
// ═══════════════════════════════════════════════════════════════
export function OpsDeck3DNucleus() {
  const f = useAnimFrame()
  const W = 400, H = 400, cx = W / 2, cy = H / 2
  const pulse = 0.4 + Math.sin(f * 0.03) * 0.6
  const breathe = 1 + Math.sin(f * 0.02) * 0.06

  // Orbital rings at different tilts
  const orbitals = [
    { rx: 120, ry: 40, rot: 15, speed: 0.008, dots: 2 },
    { rx: 100, ry: 55, rot: -30, speed: -0.006, dots: 1 },
    { rx: 130, ry: 30, rot: 50, speed: 0.01, dots: 1 },
  ]

  // Agent dots surrounding
  const agentRing = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2 + f * 0.002
    const r = 155 + Math.sin(i * 2.3) * 15
    return {
      x: cx + Math.cos(a) * r,
      y: cy + Math.sin(a) * r * 0.6,
      color: ['#3b82f6','#10b981','#6366f1','#a855f7','#f59e0b','#22d3ee','#ec4899','#8b5cf6','#06b6d4','#ef4444','#14b8a6','#818cf8'][i],
      op: 0.2 + Math.sin(f * 0.04 + i * 0.5) * 0.15
    }
  })

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>THE COGNITIVE NUCLEUS — SYSTEM HEARTBEAT</div>
      <div style={{ position: 'relative', width: W, height: H, borderRadius: 12, overflow: 'hidden', background: 'linear-gradient(180deg,rgba(3,1,10,1) 0%,rgba(8,4,20,1) 100%)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%', display: 'block' }}>
          <defs>
            <radialGradient id="nuc-core"><stop offset="0%" stopColor="#818cf8" stopOpacity="0.9"/><stop offset="30%" stopColor="#6366f1" stopOpacity="0.5"/><stop offset="60%" stopColor="#4f46e5" stopOpacity="0.15"/><stop offset="100%" stopColor="transparent" stopOpacity="0"/></radialGradient>
            <radialGradient id="nuc-outer"><stop offset="0%" stopColor="#a78bfa" stopOpacity="0.06"/><stop offset="100%" stopColor="transparent" stopOpacity="0"/></radialGradient>
            <filter id="nuc-glow"><feGaussianBlur stdDeviation="6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            <filter id="nuc-glow-sm"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>

          {/* Ambient glow */}
          <circle cx={cx} cy={cy} r={180} fill="url(#nuc-outer)"/>

          {/* Agent dots in outer ring */}
          {agentRing.map((a, i) => (
            <circle key={i} cx={a.x} cy={a.y} r={2.5} fill={a.color} opacity={a.op} filter="url(#nuc-glow-sm)"/>
          ))}

          {/* Orbital rings */}
          {orbitals.map((orb, oi) => {
            const rot = orb.rot + f * orb.speed * 50
            return <g key={oi} transform={`rotate(${rot} ${cx} ${cy})`}>
              <ellipse cx={cx} cy={cy} rx={orb.rx * breathe} ry={orb.ry * breathe} fill="none" stroke="rgba(129,140,248,0.12)" strokeWidth={0.8}/>
              {/* Traveling data dots */}
              {Array.from({ length: orb.dots }, (_, di) => {
                const dotAngle = (f * orb.speed * 3 + di * (Math.PI / orb.dots)) % (Math.PI * 2)
                const dx = cx + Math.cos(dotAngle) * orb.rx * breathe
                const dy = cy + Math.sin(dotAngle) * orb.ry * breathe
                return <circle key={di} cx={dx} cy={dy} r={2} fill="#818cf8" opacity={0.7} filter="url(#nuc-glow-sm)"/>
              })}
            </g>
          })}

          {/* Focus beam */}
          <line x1={cx} y1={cy} x2={cx + 140} y2={cy - 80} stroke="#818cf8" strokeWidth={1.5} opacity={0.15 + pulse * 0.1} filter="url(#nuc-glow)"/>
          <circle cx={cx + 140} cy={cy - 80} r={3} fill="#818cf8" opacity={0.4}/>

          {/* Inner glow — radial gradient */}
          <circle cx={cx} cy={cy} r={60 * breathe} fill="url(#nuc-core)" filter="url(#nuc-glow)"/>

          {/* Central pulsing circle */}
          <circle cx={cx} cy={cy} r={18 * breathe} fill="#6366f1" opacity={pulse * 0.5} filter="url(#nuc-glow)"/>
          <circle cx={cx} cy={cy} r={8} fill="#818cf8" opacity={0.9}/>

          {/* State label */}
          <text x={cx} y={cy + 40} textAnchor="middle" fill="rgba(255,255,255,0.6)" fontFamily={M} fontSize={9} fontWeight={600}>ACTIVE</text>
          <text x={cx} y={cy + 52} textAnchor="middle" fill="rgba(255,255,255,0.35)" fontFamily={M} fontSize={7}>Processing 3 objectives</text>

          {/* Corner label */}
          <text x={15} y={H - 12} fill="rgba(129,140,248,0.3)" fontFamily={M} fontSize={7}>The Cognitive Nucleus — System Heartbeat</text>
        </svg>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 18. OPSDECK 3D FLIGHT PATH — Camera Position Map
// ═══════════════════════════════════════════════════════════════
const ODFP_CAMERAS = [
  { id: 1, label: 'Overview', desc: 'Full core, all shells', x: 120, y: 60, color: '#818cf8' },
  { id: 2, label: 'Agent Mesh', desc: 'Agent constellation', x: 250, y: 100, color: '#10b981', active: true },
  { id: 3, label: 'Execution Layer', desc: 'Objective focus', x: 380, y: 80, color: '#22d3ee' },
  { id: 4, label: 'Memory Lattice', desc: 'Outer ring focus', x: 440, y: 200, color: '#a78bfa' },
  { id: 5, label: 'Nucleus', desc: 'Inside the core', x: 280, y: 260, color: '#ec4899' },
]

export function OpsDeck3DFlightPath() {
  const f = useAnimFrame()
  const W = 540, H = 340
  const pulse = 0.5 + Math.sin(f * 0.06) * 0.5

  // Flight path curve through all camera positions
  const pathPoints = ODFP_CAMERAS.map(c => `${c.x},${c.y}`)

  return (
    <div>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 6 }}>OPSDECK 3D — CAMERA FLIGHT PATH</div>
      <div style={{ position: 'relative', width: W, height: H, borderRadius: 12, overflow: 'hidden', background: 'linear-gradient(180deg,rgba(3,1,10,1) 0%,rgba(8,4,20,1) 100%)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%', display: 'block' }}>
          <defs>
            <filter id="fp-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            <radialGradient id="fp-scene"><stop offset="0%" stopColor="#818cf8" stopOpacity="0.08"/><stop offset="100%" stopColor="transparent" stopOpacity="0"/></radialGradient>
          </defs>

          {/* Scene background — concentric rings representing the core zones */}
          <circle cx={W / 2} cy={H / 2} r={130} fill="url(#fp-scene)"/>
          <circle cx={W / 2} cy={H / 2} r={40} fill="none" stroke="rgba(129,140,248,0.08)" strokeWidth={0.5} strokeDasharray="3 3"/>
          <circle cx={W / 2} cy={H / 2} r={80} fill="none" stroke="rgba(129,140,248,0.06)" strokeWidth={0.5} strokeDasharray="3 3"/>
          <circle cx={W / 2} cy={H / 2} r={120} fill="none" stroke="rgba(129,140,248,0.04)" strokeWidth={0.5} strokeDasharray="3 3"/>
          <text x={W / 2} y={H / 2 + 3} textAnchor="middle" fill="rgba(129,140,248,0.15)" fontFamily={M} fontSize={7}>NUCLEUS</text>
          <text x={W / 2 + 62} y={H / 2 + 3} textAnchor="middle" fill="rgba(129,140,248,0.1)" fontFamily={M} fontSize={6}>AGENTS</text>
          <text x={W / 2 + 102} y={H / 2 + 3} textAnchor="middle" fill="rgba(129,140,248,0.08)" fontFamily={M} fontSize={6}>MEMORY</text>

          {/* Flight path curves between cameras */}
          {ODFP_CAMERAS.slice(0, -1).map((c, i) => {
            const next = ODFP_CAMERAS[i + 1]
            const cx1 = c.x + (next.x - c.x) * 0.5
            const cy1 = c.y - 30
            return <path key={i} d={`M ${c.x} ${c.y} Q ${cx1} ${cy1} ${next.x} ${next.y}`} fill="none" stroke="rgba(129,140,248,0.2)" strokeWidth={1.5} strokeDasharray="6 4"/>
          })}

          {/* Camera markers */}
          {ODFP_CAMERAS.map((c, i) => {
            const isActive = c.active
            return <g key={i}>
              {/* Glow for active */}
              {isActive && <circle cx={c.x} cy={c.y} r={20} fill={`${c.color}08`} stroke={c.color} strokeWidth={1} opacity={pulse} filter="url(#fp-glow)"/>}
              {/* Camera icon — diamond shape */}
              <polygon points={`${c.x},${c.y-8} ${c.x+8},${c.y} ${c.x},${c.y+8} ${c.x-8},${c.y}`} fill={isActive ? `${c.color}30` : `${c.color}10`} stroke={c.color} strokeWidth={isActive ? 1.5 : 0.8}/>
              {/* Number */}
              <text x={c.x} y={c.y + 3} textAnchor="middle" fill={c.color} fontFamily={M} fontSize={8} fontWeight={700}>{c.id}</text>
              {/* Label */}
              <text x={c.x} y={c.y - 14} textAnchor="middle" fill={isActive ? c.color : 'rgba(255,255,255,0.5)'} fontFamily={M} fontSize={8} fontWeight={isActive ? 700 : 400}>{c.label}</text>
              <text x={c.x} y={c.y + 20} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontFamily={M} fontSize={6}>{c.desc}</text>
            </g>
          })}

          {/* Mini viewport preview for active camera */}
          {(() => {
            const ac = ODFP_CAMERAS.find(c => c.active)
            if (!ac) return null
            const vx = 30, vy = H - 90, vw = 100, vh = 60
            return <g>
              <rect x={vx} y={vy} width={vw} height={vh} rx={4} fill="rgba(16,185,129,0.04)" stroke="#10b981" strokeWidth={0.8}/>
              {/* Simplified preview of what camera 2 (Agent Mesh) sees */}
              {Array.from({ length: 8 }, (_, i) => {
                const a = (i / 8) * Math.PI * 2 + f * 0.005
                const r = 18
                return <circle key={i} cx={vx + vw / 2 + Math.cos(a) * r} cy={vy + vh / 2 + Math.sin(a) * r * 0.6} r={1.5} fill={['#3b82f6','#10b981','#6366f1','#a855f7','#f59e0b','#22d3ee','#ec4899','#818cf8'][i]} opacity={0.5}/>
              })}
              <text x={vx + vw / 2} y={vy - 4} textAnchor="middle" fill="#10b981" fontFamily={M} fontSize={6}>CAMERA 2 PREVIEW</text>
            </g>
          })()}

          {/* Keybinding hints */}
          <text x={W - 15} y={H - 30} textAnchor="end" fill="rgba(255,255,255,0.25)" fontFamily={M} fontSize={7}>WASD fly | Scroll zoom</text>
          <text x={W - 15} y={H - 18} textAnchor="end" fill="rgba(255,255,255,0.25)" fontFamily={M} fontSize={7}>1-5 jump to zone</text>
        </svg>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// STREAM M — MATRIX / QUOX MESH COMPONENTS
// ═══════════════════════════════════════════════════════════════

// Mesh color palette
const MESH_CYAN = '#06b6d4'
const MESH_PURPLE = '#a855f7'
const MESH_AMBER = '#f59e0b'

// ═══════════════════════════════════════════════════════════════
// M1. MESH ARCHITECTURE — Architecture Overview Diagram
// ═══════════════════════════════════════════════════════════════
const MA_BOXES = [
  { id: 'dashboard', label: 'Dashboard (React)', sub: 'Room List, Timeline, Cards', x: 300, y: 40, w: 240, h: 50, color: '#38bdf8' },
  { id: 'gateway', label: 'Mesh Gateway (Node.js)', sub: 'Bot Client, Room Mapper, HITL Bridge, Agent Router, Policy Enforcer', x: 300, y: 150, w: 300, h: 50, color: MESH_CYAN },
  { id: 'continuwuity', label: 'Continuwuity', sub: 'Port 6167, RocksDB, Matrix CS API', x: 180, y: 270, w: 180, h: 50, color: '#a855f7', icon: '◈' },
  { id: 'collector', label: 'Collector', sub: 'Port 9848, AEE Store', x: 420, y: 270, w: 180, h: 50, color: '#f59e0b' },
]
const MA_LINKS = [
  { from: 'dashboard', to: 'gateway', label: 'HTTPS + WS', color: '#38bdf8' },
  { from: 'gateway', to: 'continuwuity', label: 'Matrix CS API', color: MESH_CYAN },
  { from: 'gateway', to: 'collector', label: 'AEE envelopes', color: '#f59e0b' },
  { from: 'continuwuity', to: 'collector', label: 'Memory pipeline', color: '#a855f7', dashed: true },
]

export function MeshArchitecture() {
  const f = useAnimFrame()
  const W = 620, H = 400
  const reveal = lerp(f, 0, 20, 0, 1)
  return (
    <div style={{ width: W, position: 'relative' }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Quox Mesh Architecture</div>
      <svg width={W} height={H} style={{ opacity: reveal }}>
        {/* Links */}
        {MA_LINKS.map((link, i) => {
          const from = MA_BOXES.find(b => b.id === link.from)
          const to = MA_BOXES.find(b => b.id === link.to)
          if (!from || !to) return null
          const fx = from.x, fy = from.y + from.h
          const tx = to.x, ty = to.y
          const my = (fy + ty) / 2
          const op = lerp(f, 10 + i * 4, 20 + i * 4, 0, 0.6)
          const pulseT = ((f * 0.02 + i * 0.3) % 1)
          const px = fx + (tx - fx) * pulseT, py = fy + (ty - fy) * pulseT
          return (
            <g key={i}>
              <path d={`M ${fx} ${fy} C ${fx} ${my},${tx} ${my},${tx} ${ty}`} fill="none" stroke={link.color} strokeWidth={1.5} strokeOpacity={op} strokeDasharray={link.dashed ? '6 4' : 'none'} />
              <circle cx={px} cy={py} r={2.5} fill={link.color} opacity={0.7} />
              <text x={(fx + tx) / 2 + 8} y={my} fill={link.color} fontSize={8} fontFamily={M} opacity={0.7}>{link.label}</text>
            </g>
          )
        })}
        {/* Boxes */}
        {MA_BOXES.map((box, i) => {
          const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
          return (
            <g key={box.id} opacity={op}>
              <rect x={box.x - box.w / 2} y={box.y} width={box.w} height={box.h} rx={8} fill={`${box.color}10`} stroke={box.color} strokeWidth={1.2} strokeOpacity={0.5} />
              <text x={box.x} y={box.y + 20} textAnchor="middle" fill="#fff" fontSize={12} fontFamily={M} fontWeight={700}>{box.icon ? `${box.icon} ` : ''}{box.label}</text>
              <text x={box.x} y={box.y + 36} textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize={8} fontFamily={M}>{box.sub}</text>
            </g>
          )
        })}
        {/* Federation arrow at bottom */}
        {(() => {
          const op = lerp(f, 25, 35, 0, 0.8)
          const arrowY = 350
          return (
            <g opacity={op}>
              <line x1={200} y1={arrowY} x2={420} y2={arrowY} stroke={MESH_PURPLE} strokeWidth={1.5} strokeDasharray="8 4" />
              <polygon points={`420,${arrowY} 412,${arrowY - 4} 412,${arrowY + 4}`} fill={MESH_PURPLE} opacity={0.8} />
              <text x={310} y={arrowY - 8} textAnchor="middle" fill={MESH_PURPLE} fontSize={10} fontFamily={M} fontWeight={600}>Federation → Other Quox Instances</text>
              <text x={310} y={arrowY + 16} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize={8} fontFamily={M}>Cross-instance rooms, wisdom sharing, trust policies</text>
            </g>
          )
        })()}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M2. MESH ROOM LIST — Room List Sidebar
// ═══════════════════════════════════════════════════════════════
const MRL_ROOMS = [
  { name: 'CommanderQ', type: 'dm', icon: '◈', color: '#10b981', unread: 2, preview: 'Deployment verified. All clear.', time: '14:34', online: true, members: 1 },
  { name: 'WARDEN', type: 'dm', icon: '◈', color: '#ef4444', unread: 0, preview: 'Health checks nominal.', time: '14:30', online: true, members: 1 },
  { name: 'Adam', type: 'dm', icon: '◉', color: '#38bdf8', unread: 0, preview: 'Thanks, looks good.', time: '14:28', online: true, members: 1 },
  { name: '#security-team', type: 'team', icon: '◆', color: '#a855f7', unread: 0, preview: 'CIPHER: scan complete', time: '14:25', encrypted: true, members: 4 },
  { name: '#devops', type: 'team', icon: '◆', color: '#3b82f6', unread: 0, preview: 'VULCAN: PR merged', time: '14:20', members: 6 },
  { name: '#INC-2847-edge-03', type: 'incident', icon: '⚠', color: '#ef4444', unread: 3, preview: 'VULCAN: Restarting sshd...', time: '14:42', active: true, members: 3 },
  { name: '#deploy-v2.4', type: 'workflow', icon: '▶', color: '#6366f1', unread: 0, preview: 'Progress: 67%', time: '14:33', progress: 67, members: 5 },
  { name: '#approvals', type: 'hitl', icon: '◇', color: MESH_AMBER, unread: 2, preview: '2 pending approvals', time: '14:35', members: 2 },
  { name: '#quox-ops-wisdom', type: 'federation', icon: '☆', color: MESH_PURPLE, unread: 0, preview: 'New pattern: k8s rollback', time: '14:15', federated: true, members: 847 },
  { name: '#webhook-events', type: 'bridge', icon: '↔', color: '#14b8a6', unread: 0, preview: 'POST from GitHub: push event', time: '14:10', members: 1 },
]
const MRL_FILTERS = ['All', 'DMs', 'Teams', 'Incidents', 'Workflows']

export function MeshRoomList() {
  const f = useAnimFrame()
  const [filter, setFilter] = useState('All')
  const [search, setSearch] = useState('')
  const filtered = MRL_ROOMS.filter(r => {
    if (filter === 'DMs' && r.type !== 'dm') return false
    if (filter === 'Teams' && r.type !== 'team') return false
    if (filter === 'Incidents' && r.type !== 'incident') return false
    if (filter === 'Workflows' && r.type !== 'workflow') return false
    if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const typeBadgeColor = { dm: '#10b981', team: '#3b82f6', incident: '#ef4444', workflow: '#6366f1', hitl: MESH_AMBER, federation: MESH_PURPLE, bridge: '#14b8a6' }

  return (
    <div style={{ width: 320, fontFamily: F }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Mesh Room List</div>
      <GP style={{ padding: 0 }}>
        {/* Search */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: '6px 10px' }}>
            <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>⌕</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search rooms..." style={{ background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: 12, fontFamily: F, width: '100%' }} />
          </div>
        </div>
        {/* Filter pills */}
        <div style={{ padding: '8px 12px', display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          {MRL_FILTERS.map(fl => (
            <div key={fl} onClick={() => setFilter(fl)} style={{ padding: '3px 10px', borderRadius: 12, fontSize: 10, fontFamily: M, cursor: 'pointer', background: filter === fl ? `${MESH_CYAN}20` : 'rgba(255,255,255,0.04)', color: filter === fl ? MESH_CYAN : 'rgba(255,255,255,0.6)', border: `1px solid ${filter === fl ? `${MESH_CYAN}40` : 'rgba(255,255,255,0.08)'}` }}>
              {fl}
            </div>
          ))}
        </div>
        {/* Room list */}
        <div style={{ maxHeight: 440, overflowY: 'auto' }}>
          {filtered.map((room, i) => {
            const op = lerp(f, i * 2, i * 2 + 8, 0, 1)
            const bc = typeBadgeColor[room.type] || '#fff'
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)', opacity: op, cursor: 'pointer' }}>
                {/* Avatar */}
                <div style={{ width: 32, height: 32, borderRadius: room.type === 'dm' ? '50%' : 6, background: `${room.color}15`, border: `1px solid ${room.color}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: room.color, flexShrink: 0, position: 'relative' }}>
                  {room.icon}
                  {room.online && room.type === 'dm' && <div style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderRadius: '50%', background: '#10b981', border: '2px solid #0a0e1a' }} />}
                  {room.active && <div style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderRadius: '50%', background: '#ef4444', border: '2px solid #0a0e1a', animation: `pulse ${1 + Math.sin(f * 0.1) * 0.5}s` }} />}
                </div>
                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{room.name}</span>
                    {room.encrypted && <span style={{ fontSize: 8, color: '#10b981', fontFamily: M }}>🔒</span>}
                    {room.federated && <span style={{ fontSize: 7, padding: '1px 4px', borderRadius: 3, background: `${MESH_PURPLE}20`, color: MESH_PURPLE, fontFamily: M }}>FED</span>}
                    {room.progress !== undefined && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: `${room.color}20`, color: room.color, fontFamily: M, fontWeight: 700 }}>{room.progress}%</span>}
                  </div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{room.preview}</div>
                </div>
                {/* Right side */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                  <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.4)' }}>{room.time}</span>
                  {room.unread > 0 && <div style={{ minWidth: 16, height: 16, borderRadius: 8, background: bc, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontFamily: M, fontWeight: 700, color: '#0a0e1a', padding: '0 4px' }}>{room.unread}</div>}
                </div>
              </div>
            )
          })}
        </div>
        {/* Create Room button */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0', borderRadius: 6, background: `${MESH_CYAN}10`, border: `1px solid ${MESH_CYAN}30`, cursor: 'pointer' }}>
            <span style={{ color: MESH_CYAN, fontSize: 14 }}>+</span>
            <span style={{ fontFamily: M, fontSize: 10, color: MESH_CYAN, fontWeight: 600 }}>Create Room</span>
          </div>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M3. MESH TIMELINE — Room Timeline View
// ═══════════════════════════════════════════════════════════════
const MT_MESSAGES = [
  { sender: 'CommanderQ', time: '14:30', type: 'agent', color: '#6366f1', content: 'Starting deployment objective. Decomposing into 6 tasks.' },
  { sender: 'System', time: '14:30', type: 'aee', content: null, aee: { intent: 'quox.objective.start', from: 'human.adam', to: 'agent.commanderq', corr: 'OBJ-7a3f' } },
  { sender: 'VULCAN', time: '14:31', type: 'agent', color: '#3b82f6', content: 'Pulling images for quox-api:2.4.1 on edge-01, edge-02' },
  { sender: 'Adam', time: '14:31', type: 'human', content: 'Make sure to check the migration scripts first' },
  { sender: 'CODEX', time: '14:32', type: 'tool', color: '#6366f1', tool: { cmd: 'ssh edge-01 "docker pull quoxai/quox-api:2.4.1"', output: 'v2.4.1: Pull complete. Digest: sha256:8f3a2c...', status: 'success' } },
  { sender: 'System', time: '14:32', type: 'volt', volt: { hash: '8f3a2c...d71e', evidenceType: 'execution_result', verified: true, id: 'EVD-4891' } },
  { sender: 'System', time: '14:33', type: 'hitl', hitl: { question: 'Deploy to production?', options: ['Approve', 'Deny'], sla: '5m remaining', priority: 'HIGH' } },
  { sender: 'WARDEN', time: '14:34', type: 'agent', color: '#10b981', content: 'Health checks passed on both hosts. Deployment verified.' },
]

export function MeshTimeline() {
  const f = useAnimFrame()
  return (
    <div style={{ width: 520, fontFamily: F }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Mesh Timeline</div>
      <GP style={{ padding: 0 }}>
        {/* Room header */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>#deploy-v2.4</span>
          <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>5 members</span>
          <span style={{ fontSize: 8, color: '#10b981', fontFamily: M }}>🔒 E2E</span>
          <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#6366f120', color: '#6366f1', fontFamily: M }}>obj-7a3f</span>
        </div>
        {/* Messages */}
        <div style={{ padding: '8px 0', maxHeight: 500 }}>
          {MT_MESSAGES.map((msg, i) => {
            const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
            const isHuman = msg.type === 'human'
            return (
              <div key={i} style={{ padding: '6px 14px', opacity: op, display: 'flex', flexDirection: isHuman ? 'row-reverse' : 'row', gap: 8, marginBottom: 4 }}>
                {/* Avatar */}
                {msg.type !== 'aee' && msg.type !== 'volt' && msg.type !== 'hitl' && (
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${msg.color || '#38bdf8'}15`, border: `1px solid ${msg.color || '#38bdf8'}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontFamily: M, fontWeight: 700, color: msg.color || '#38bdf8', flexShrink: 0 }}>
                    {msg.sender[0]}
                  </div>
                )}
                {/* Content */}
                <div style={{ maxWidth: '80%' }}>
                  {/* Name + time */}
                  {msg.type !== 'aee' && msg.type !== 'volt' && msg.type !== 'hitl' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexDirection: isHuman ? 'row-reverse' : 'row' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: msg.color || '#fff' }}>{msg.sender}</span>
                      <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.4)' }}>{msg.time}</span>
                    </div>
                  )}
                  {/* Regular text */}
                  {msg.content && (
                    <div style={{ padding: '8px 12px', borderRadius: isHuman ? '12px 12px 4px 12px' : '12px 12px 12px 4px', background: isHuman ? 'rgba(255,255,255,0.08)' : `${msg.color || '#38bdf8'}10`, border: `1px solid ${isHuman ? 'rgba(255,255,255,0.1)' : `${msg.color}25`}`, fontSize: 12, color: 'rgba(255,255,255,0.85)', lineHeight: 1.5 }}>
                      {msg.content}
                    </div>
                  )}
                  {/* AEE card */}
                  {msg.aee && (
                    <div style={{ padding: '8px 12px', borderRadius: 8, background: `${MESH_CYAN}08`, border: `1px solid ${MESH_CYAN}25` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: `${MESH_CYAN}20`, color: MESH_CYAN, fontFamily: M, fontWeight: 700 }}>AEE ENVELOPE</span>
                        <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.4)' }}>{msg.time}</span>
                      </div>
                      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
                        <span style={{ color: 'rgba(255,255,255,0.5)' }}>intent:</span> <span style={{ color: MESH_CYAN }}>{msg.aee.intent}</span><br />
                        <span style={{ color: 'rgba(255,255,255,0.5)' }}>from:</span> {msg.aee.from} <span style={{ color: 'rgba(255,255,255,0.5)' }}>to:</span> {msg.aee.to}
                      </div>
                    </div>
                  )}
                  {/* Tool card */}
                  {msg.tool && (
                    <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: msg.color }}>{msg.sender}</span>
                        <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#10b98120', color: '#10b981', fontFamily: M, fontWeight: 700 }}>TOOL USE</span>
                        <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.4)' }}>{msg.time}</span>
                      </div>
                      <div style={{ fontFamily: M, fontSize: 10, padding: '6px 8px', borderRadius: 4, background: 'rgba(0,0,0,0.3)', color: '#10b981', marginBottom: 4 }}>{msg.tool.cmd}</div>
                      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{msg.tool.output}</div>
                    </div>
                  )}
                  {/* VOLT card */}
                  {msg.volt && (
                    <div style={{ padding: '8px 12px', borderRadius: 8, background: '#10b98108', border: '1px solid #10b98125' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#10b98120', color: '#10b981', fontFamily: M, fontWeight: 700 }}>VOLT EVIDENCE</span>
                        <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#10b98115', color: '#10b981', fontFamily: M }}>✓ Verified</span>
                      </div>
                      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
                        <span style={{ color: 'rgba(255,255,255,0.5)' }}>hash:</span> {msg.volt.hash} <span style={{ color: 'rgba(255,255,255,0.5)' }}>type:</span> {msg.volt.evidenceType}
                      </div>
                    </div>
                  )}
                  {/* HITL card */}
                  {msg.hitl && (
                    <div style={{ padding: '10px 14px', borderRadius: 8, background: `${MESH_AMBER}08`, border: `1px solid ${MESH_AMBER}30` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: `${MESH_AMBER}20`, color: MESH_AMBER, fontFamily: M, fontWeight: 700 }}>HITL APPROVAL</span>
                        <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#ef444420', color: '#ef4444', fontFamily: M, fontWeight: 700 }}>{msg.hitl.priority}</span>
                        <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.4)' }}>{msg.time}</span>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 8 }}>{msg.hitl.question}</div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ flex: 1, padding: '6px 0', textAlign: 'center', borderRadius: 6, background: '#10b98115', border: '1px solid #10b98130', fontSize: 11, fontFamily: M, fontWeight: 700, color: '#10b981', cursor: 'pointer' }}>✓ Approve</div>
                        <div style={{ flex: 1, padding: '6px 0', textAlign: 'center', borderRadius: 6, background: '#ef444415', border: '1px solid #ef444430', fontSize: 11, fontFamily: M, fontWeight: 700, color: '#ef4444', cursor: 'pointer' }}>✕ Deny</div>
                      </div>
                      <div style={{ fontSize: 9, fontFamily: M, color: MESH_AMBER, marginTop: 6, textAlign: 'right' }}>SLA: {msg.hitl.sla}</div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {/* Compose bar */}
        <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 16, cursor: 'pointer' }}>📎</span>
          <div style={{ flex: 1, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: F }}>Message #deploy-v2.4...</div>
          <div style={{ padding: '6px 14px', borderRadius: 6, background: `${MESH_CYAN}20`, border: `1px solid ${MESH_CYAN}40`, fontSize: 11, fontFamily: M, fontWeight: 700, color: MESH_CYAN, cursor: 'pointer' }}>Send</div>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M4. MESH ROOM TYPES — Room Type Gallery
// ═══════════════════════════════════════════════════════════════
const MRT_TYPES = [
  { name: 'Direct Message', icon: '◉', color: '#10b981', desc: '1-to-1, agent or human, memory-scoped', features: ['End-to-end encrypted', 'Scoped memory', 'Typing indicators'], example: '2 members' },
  { name: 'Team Room', icon: '◆', color: '#3b82f6', desc: 'Mapped to org team, auto-membership, persistent', features: ['Auto-join on team add', 'Persistent history', 'Pinned messages'], example: '4-12 members' },
  { name: 'Agent Room', icon: '◈', color: '#a855f7', desc: 'Multi-agent workspace, tools enabled, AEE-wrapped', features: ['AEE envelope wrapping', 'Tool execution', 'VOLT evidence'], example: '3-8 agents' },
  { name: 'Incident Room', icon: '⚠', color: '#ef4444', desc: 'Auto-created on alert, war room, SLA timer, auto-archive', features: ['SLA countdown', 'Runbook checklist', 'Auto-archive on resolve'], example: '2-6 responders' },
  { name: 'Workflow Room', icon: '▶', color: '#6366f1', desc: 'Linked to QuoxFlow execution, progress events, auto-close', features: ['Objective linked', 'Progress tracking', 'Auto-close on complete'], example: '3-5 participants' },
  { name: 'HITL Room', icon: '◇', color: MESH_AMBER, desc: 'Approval queue, structured response cards, SLA countdown', features: ['Structured cards', 'SLA enforcement', 'Audit trail'], example: '1-3 approvers' },
  { name: 'Bridge Room', icon: '↔', color: '#14b8a6', desc: 'Telegram/Discord/Slack bridge, 2-way sync', features: ['2-way message sync', 'Attachment forwarding', 'User mapping'], example: 'External channel' },
  { name: 'Federation Room', icon: '☆', color: MESH_PURPLE, desc: 'Cross-Quox, trust policies, sanitization, wisdom sharing', features: ['PII sanitization', 'Trust verification', 'VOLT-verified wisdom'], example: '100-1000+ members' },
]

export function MeshRoomTypes() {
  const f = useAnimFrame()
  return (
    <div style={{ maxWidth: 700 }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Room Types — 8 Types</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {MRT_TYPES.map((rt, i) => {
          const op = lerp(f, i * 2, i * 2 + 8, 0, 1)
          return (
            <GP key={i} style={{ padding: '12px 14px', borderTopColor: `${rt.color}30`, opacity: op }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ width: 28, height: 28, borderRadius: 6, background: `${rt.color}15`, border: `1px solid ${rt.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: rt.color }}>{rt.icon}</div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{rt.name}</div>
                  <div style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>{rt.example}</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 8, lineHeight: 1.4 }}>{rt.desc}</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {rt.features.map((feat, fi) => (
                  <span key={fi} style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: `${rt.color}10`, color: rt.color, fontFamily: M }}>{feat}</span>
                ))}
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M5. MESH FEDERATION MAP — Federation Network Visualization
// ═══════════════════════════════════════════════════════════════
const MFM_INSTANCES = [
  { id: 'primary', name: 'quox.internal', location: 'London', x: 200, y: 180, r: 35, color: MESH_CYAN, primary: true, rooms: 247 },
  { id: 'staging', name: 'quox-staging.internal', location: 'London', x: 120, y: 100, r: 22, color: '#38bdf8', rooms: 54 },
  { id: 'partner', name: 'partner.quox.cloud', location: 'Frankfurt', x: 380, y: 120, r: 26, color: MESH_PURPLE, rooms: 89 },
  { id: 'client', name: 'client-corp.quox.io', location: 'New York', x: 420, y: 260, r: 22, color: MESH_PURPLE, rooms: 31 },
]
const MFM_LINKS = [
  { from: 'primary', to: 'staging', trust: 'Trusted', shared: 5, solid: true },
  { from: 'primary', to: 'partner', trust: 'Verified', shared: 3, solid: true },
  { from: 'primary', to: 'client', trust: 'Pending', shared: 4, solid: false },
]
const TRUST_COLORS = { Trusted: '#10b981', Verified: '#3b82f6', Pending: MESH_AMBER }

export function MeshFederationMap() {
  const f = useAnimFrame()
  const W = 560, H = 360
  const reveal = lerp(f, 0, 15, 0, 1)
  const instMap = {}
  MFM_INSTANCES.forEach(inst => { instMap[inst.id] = inst })

  return (
    <div style={{ width: W }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Federation Network</div>
      <GP style={{ padding: 14 }}>
        {/* Header stats */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
            <span style={{ fontFamily: M, fontSize: 10, color: '#10b981', fontWeight: 700 }}>Federation: ON</span>
          </div>
          <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>4 instances | 3 federations | 12 shared rooms | 847 wisdom entries</span>
        </div>
        <svg width={W - 28} height={H - 80} style={{ opacity: reveal }}>
          {/* Links */}
          {MFM_LINKS.map((link, i) => {
            const from = instMap[link.from], to = instMap[link.to]
            if (!from || !to) return null
            const tc = TRUST_COLORS[link.trust]
            const pulseT = ((f * 0.015 + i * 0.4) % 1)
            const px = from.x + (to.x - from.x) * pulseT, py = from.y + (to.y - from.y) * pulseT
            return (
              <g key={i}>
                <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={tc} strokeWidth={1.5} strokeOpacity={0.3} strokeDasharray={link.solid ? 'none' : '6 4'} />
                <circle cx={px} cy={py} r={2.5} fill={tc} opacity={0.8} />
                <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 8} textAnchor="middle" fill={tc} fontSize={8} fontFamily={M} fontWeight={600}>{link.shared} rooms</text>
                <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 + 6} textAnchor="middle" fontSize={7} fontFamily={M}>
                  <tspan fill={tc}>{link.trust}</tspan>
                </text>
              </g>
            )
          })}
          {/* Instance nodes */}
          {MFM_INSTANCES.map((inst, i) => {
            const op = lerp(f, i * 3, i * 3 + 10, 0, 1)
            const pulse = inst.primary ? 0.7 + Math.sin(f * 0.06) * 0.3 : 0.8
            return (
              <g key={inst.id} opacity={op}>
                {inst.primary && <circle cx={inst.x} cy={inst.y} r={inst.r + 8} fill={inst.color} opacity={0.05 * pulse} />}
                <circle cx={inst.x} cy={inst.y} r={inst.r} fill={`${inst.color}12`} stroke={inst.color} strokeWidth={inst.primary ? 2 : 1.2} strokeOpacity={0.5 * pulse} />
                <text x={inst.x} y={inst.y - 4} textAnchor="middle" fill="#fff" fontSize={inst.primary ? 10 : 8} fontFamily={M} fontWeight={700}>{inst.name.split('.')[0]}</text>
                <text x={inst.x} y={inst.y + 8} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize={7} fontFamily={M}>{inst.location}</text>
                <text x={inst.x} y={inst.y + inst.r + 14} textAnchor="middle" fill={inst.color} fontSize={8} fontFamily={M}>{inst.rooms} rooms</text>
              </g>
            )
          })}
        </svg>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M6. MESH EVENT TYPES — Custom Event Types
// ═══════════════════════════════════════════════════════════════
const MET_EVENTS = [
  { type: 'com.quox.aee.envelope', desc: 'Agent message wrapper', color: MESH_CYAN, example: '{ intent: "quox.chat.query",\n  from: "human.adam" }' },
  { type: 'com.quox.volt.evidence', desc: 'Evidence record', color: '#10b981', example: '{ hash: "8f3a2c...d71e",\n  type: "execution_result" }' },
  { type: 'com.quox.ward.witness', desc: 'Witness receipt', color: '#14b8a6', example: '{ receipt_id: "WR-0094",\n  chain_verified: true }' },
  { type: 'com.quox.hitl.request', desc: 'Approval request', color: MESH_AMBER, example: '{ action: "deploy_production",\n  sla_seconds: 300 }' },
  { type: 'com.quox.hitl.response', desc: 'Approval response', color: '#3b82f6', example: '{ decision: "approved",\n  actor: "admin@example.com" }' },
  { type: 'com.quox.task.update', desc: 'Task status change', color: '#a855f7', example: '{ task_id: "t-4a2f",\n  status: "complete" }' },
  { type: 'com.quox.memory.entity', desc: 'Entity mention/update', color: '#ec4899', example: '{ entity: "edge-03",\n  type: "host", action: "update" }' },
  { type: 'com.quox.workflow.event', desc: 'Workflow lifecycle event', color: '#6366f1', example: '{ workflow: "deploy-v2.4",\n  phase: "executing" }' },
]

export function MeshEventTypes() {
  const f = useAnimFrame()
  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>Custom Event Types — com.quox.*</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {MET_EVENTS.map((ev, i) => {
          const op = lerp(f, i * 2, i * 2 + 8, 0, 1)
          return (
            <GP key={i} style={{ padding: '10px 12px', borderTopColor: `${ev.color}30`, opacity: op }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: ev.color, opacity: 0.8 }} />
                <span style={{ fontSize: 10, fontFamily: M, fontWeight: 700, color: ev.color }}>{ev.type}</span>
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 6 }}>{ev.desc}</div>
              <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', padding: '6px 8px', borderRadius: 4, background: 'rgba(0,0,0,0.25)', whiteSpace: 'pre', lineHeight: 1.5 }}>{ev.example}</div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M7. MESH INCIDENT ROOM — Incident War Room
// ═══════════════════════════════════════════════════════════════
const MIR_RUNBOOK = [
  { label: 'Detected', done: true },
  { label: 'Escalated', done: true },
  { label: 'Investigating', active: true },
  { label: 'Resolved', done: false },
]
const MIR_TIMELINE = [
  { time: '14:30', sender: 'WARDEN', color: '#ef4444', content: 'SSH health check failed on edge-03 — port 22 not responding' },
  { time: '14:30', sender: 'System', color: MESH_AMBER, content: 'Incident auto-created. SLA: 60 min.' },
  { time: '14:31', sender: 'Adam', color: '#38bdf8', content: 'Acknowledged. VULCAN, check if OOM killed sshd.', human: true },
  { time: '14:35', sender: 'VULCAN', color: '#a855f7', content: null, tool: { cmd: 'ssh gw-01 "ssh edge-03 systemctl status sshd"', output: 'ssh: connect to host edge-03 port 22: Connection refused' } },
  { time: '14:42', sender: 'VULCAN', color: '#a855f7', content: 'Confirmed: OOM kill on sshd. Restarting service.' },
]

export function MeshIncidentRoom() {
  const f = useAnimFrame()
  const slaTotal = 60, slaElapsed = 47
  const slaPct = slaElapsed / slaTotal
  const slaRemain = slaTotal - slaElapsed
  const slaColor = slaPct > 0.8 ? '#ef4444' : slaPct > 0.5 ? MESH_AMBER : '#10b981'

  return (
    <div style={{ width: 540, fontFamily: F }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Incident War Room</div>
      <GP style={{ padding: 0 }}>
        {/* Header */}
        <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>#INC-2847</span>
            <span style={{ fontSize: 9, padding: '2px 8px', borderRadius: 4, background: '#ef444420', color: '#ef4444', fontFamily: M, fontWeight: 700 }}>ACTIVE</span>
            <span style={{ fontSize: 9, padding: '2px 8px', borderRadius: 4, background: '#ef444415', color: '#ef4444', fontFamily: M, fontWeight: 700 }}>P1</span>
            <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)', marginLeft: 'auto' }}>Started 47m ago</span>
          </div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>edge-03 SSH unreachable</div>
        </div>
        {/* SLA bar */}
        <div style={{ padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>SLA</span>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ width: `${slaPct * 100}%`, height: '100%', borderRadius: 3, background: slaColor, opacity: 0.8 + Math.sin(f * 0.08) * 0.2 }} />
          </div>
          <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: slaColor, flexShrink: 0 }}>{slaRemain}m remaining</span>
        </div>
        {/* Participants + Runbook */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 20 }}>
          {/* Participants */}
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>PARTICIPANTS</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[{ name: 'Adam', role: 'Commander', color: '#38bdf8' }, { name: 'WARDEN', role: 'Investigator', color: '#ef4444' }, { name: 'VULCAN', role: 'Responder', color: '#a855f7' }].map((p, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${p.color}15`, border: `1px solid ${p.color}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontFamily: M, fontWeight: 700, color: p.color }}>{p.name[0]}</div>
                  <span style={{ fontSize: 8, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>{p.role}</span>
                </div>
              ))}
            </div>
          </div>
          {/* Runbook */}
          <div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>RUNBOOK</div>
            {MIR_RUNBOOK.map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 10, color: step.done ? '#10b981' : step.active ? '#3b82f6' : 'rgba(255,255,255,0.3)', fontWeight: 700 }}>{step.done ? '✓' : step.active ? '►' : '○'}</span>
                <span style={{ fontSize: 10, fontFamily: M, color: step.done ? '#10b981' : step.active ? '#3b82f6' : 'rgba(255,255,255,0.5)' }}>{step.label}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Timeline */}
        <div style={{ padding: '8px 0' }}>
          {MIR_TIMELINE.map((msg, i) => {
            const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
            return (
              <div key={i} style={{ padding: '6px 14px', opacity: op, display: 'flex', gap: 8 }}>
                <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', width: 36, flexShrink: 0 }}>{msg.time}</span>
                <div style={{ width: 22, height: 22, borderRadius: '50%', background: `${msg.color}15`, border: `1px solid ${msg.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontFamily: M, fontWeight: 700, color: msg.color, flexShrink: 0 }}>{msg.sender[0]}</div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: msg.color }}>{msg.sender}</span>
                  {msg.content && <div style={{ fontSize: 11, color: msg.human ? '#fff' : 'rgba(255,255,255,0.8)', marginTop: 2, lineHeight: 1.4 }}>{msg.content}</div>}
                  {msg.tool && (
                    <div style={{ marginTop: 4, padding: '6px 8px', borderRadius: 4, background: 'rgba(0,0,0,0.25)' }}>
                      <div style={{ fontFamily: M, fontSize: 9, color: '#10b981', marginBottom: 2 }}>{msg.tool.cmd}</div>
                      <div style={{ fontFamily: M, fontSize: 9, color: '#ef4444' }}>{msg.tool.output}</div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {/* Actions */}
        <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, padding: '6px 0', textAlign: 'center', borderRadius: 6, background: '#ef444415', border: '1px solid #ef444430', fontSize: 10, fontFamily: M, fontWeight: 700, color: '#ef4444', cursor: 'pointer' }}>Escalate</div>
          <div style={{ flex: 1, padding: '6px 0', textAlign: 'center', borderRadius: 6, background: '#10b98115', border: '1px solid #10b98130', fontSize: 10, fontFamily: M, fontWeight: 700, color: '#10b981', cursor: 'pointer' }}>Resolve</div>
          <div style={{ flex: 1, padding: '6px 0', textAlign: 'center', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', fontSize: 10, fontFamily: M, fontWeight: 700, color: 'rgba(255,255,255,0.7)', cursor: 'pointer' }}>Post-Mortem</div>
        </div>
        {/* VOLT evidence count */}
        <div style={{ padding: '6px 14px', borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#10b98115', color: '#10b981', fontFamily: M, fontWeight: 700 }}>VOLT</span>
          <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>3 evidence records logged for this incident</span>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M8. MESH BRIDGE STATUS — Bridge Status Panel
// ═══════════════════════════════════════════════════════════════
const MBS_BRIDGES = [
  { platform: 'Telegram', icon: '✈', color: '#229ed9', status: 'connected', mapping: '#ops-alerts → @quox_ops_bot', count: 1247, lastSync: '12s ago', failed: 0 },
  { platform: 'Discord', icon: '◈', color: '#5865f2', status: 'connected', mapping: '#dev-team → Quox DevOps server', count: 892, lastSync: '8s ago', failed: 0 },
  { platform: 'Slack', icon: '#', color: '#e01e5a', status: 'degraded', mapping: '#general → workspace.slack.com', count: 234, lastSync: '2m ago', failed: 12 },
  { platform: 'Email', icon: '✉', color: '#f59e0b', status: 'connected', mapping: 'alerts@example.com → #email-inbound', count: 56, lastSync: '45s ago', failed: 0 },
  { platform: 'Webhook', icon: '↗', color: '#14b8a6', status: 'connected', mapping: 'POST /webhook/inbound → #webhook-events', count: 189, lastSync: '3s ago', failed: 0 },
]
const STATUS_DOTS = { connected: '#10b981', degraded: MESH_AMBER, disconnected: '#ef4444' }

export function MeshBridgeStatus() {
  const f = useAnimFrame()
  const totalMessages = MBS_BRIDGES.reduce((s, b) => s + b.count, 0)
  const totalFailed = MBS_BRIDGES.reduce((s, b) => s + b.failed, 0)
  const deliveryRate = ((totalMessages - totalFailed) / totalMessages * 100).toFixed(1)

  return (
    <div style={{ width: 500, fontFamily: F }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Bridge Status</div>
      <GP style={{ padding: 0 }}>
        {/* Bridges list */}
        {MBS_BRIDGES.map((bridge, i) => {
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          const sc = STATUS_DOTS[bridge.status]
          return (
            <div key={i} style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', gap: 10, opacity: op }}>
              {/* Platform icon */}
              <div style={{ width: 32, height: 32, borderRadius: 6, background: `${bridge.color}15`, border: `1px solid ${bridge.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: bridge.color, flexShrink: 0 }}>{bridge.icon}</div>
              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{bridge.platform}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: sc, opacity: bridge.status === 'degraded' ? 0.6 + Math.sin(f * 0.1) * 0.4 : 0.8 }} />
                    <span style={{ fontSize: 9, fontFamily: M, color: sc, textTransform: 'capitalize' }}>{bridge.status}</span>
                  </div>
                </div>
                <div style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bridge.mapping}</div>
              </div>
              {/* Stats */}
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 11, fontFamily: M, fontWeight: 700, color: '#fff' }}>{bridge.count.toLocaleString()}</div>
                <div style={{ fontSize: 8, fontFamily: M, color: 'rgba(255,255,255,0.4)' }}>{bridge.lastSync}</div>
                {bridge.failed > 0 && <div style={{ fontSize: 8, fontFamily: M, color: '#ef4444' }}>{bridge.failed} failed</div>}
              </div>
            </div>
          )
        })}
        {/* Footer */}
        <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>{totalMessages.toLocaleString()} total messages bridged | {deliveryRate}% delivery rate</span>
          <div style={{ padding: '5px 12px', borderRadius: 6, background: `${MESH_CYAN}10`, border: `1px solid ${MESH_CYAN}30`, fontSize: 10, fontFamily: M, fontWeight: 700, color: MESH_CYAN, cursor: 'pointer' }}>+ Add Bridge</div>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M9. MESH HIVE WISDOM — Hive Community Wisdom
// ═══════════════════════════════════════════════════════════════
const MHW_COMMUNITIES = [
  { name: 'ops-patterns', items: 1247, orgs: 23, trust: 94, icon: '◈', desc: 'Operational patterns and runbooks' },
  { name: 'security-playbooks', items: 312, orgs: 8, trust: 97, icon: '🛡', desc: 'Security response procedures' },
  { name: 'deployment-recipes', items: 156, orgs: 15, trust: 91, icon: '▶', desc: 'Deployment strategies and rollback plans' },
  { name: 'cost-optimization', items: 89, orgs: 11, trust: 88, icon: '◇', desc: 'Infrastructure cost reduction tactics' },
]

export function MeshHiveWisdom() {
  const f = useAnimFrame()
  return (
    <div style={{ width: 540, fontFamily: F }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Hive Community Wisdom</div>
      <GP style={{ padding: 0 }}>
        {/* Header */}
        <div style={{ padding: '14px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: `${MESH_AMBER}04` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <div style={{ width: 24, height: 24, borderRadius: 6, background: `${MESH_AMBER}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>🐝</div>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Quox Hive</span>
            <span style={{ fontSize: 11, color: MESH_AMBER }}>Community Intelligence Network</span>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
            <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>Your contributions: <span style={{ color: '#10b981' }}>23 shared</span> | <span style={{ color: '#38bdf8' }}>156 consumed</span></span>
            <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: `${MESH_AMBER}15`, color: MESH_AMBER, fontFamily: M, fontWeight: 700 }}>Trust: Gold</span>
          </div>
        </div>
        {/* Communities */}
        {MHW_COMMUNITIES.map((comm, i) => {
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          const trustColor = comm.trust >= 95 ? '#10b981' : comm.trust >= 90 ? '#3b82f6' : MESH_AMBER
          return (
            <div key={i} style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', gap: 12, opacity: op }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: `${MESH_AMBER}10`, border: `1px solid ${MESH_AMBER}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>{comm.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{comm.name}</span>
                  <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#10b98115', color: '#10b981', fontFamily: M }}>VOLT-verified</span>
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>{comm.desc}</div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>{comm.items.toLocaleString()} patterns</span>
                  <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>{comm.orgs} orgs</span>
                </div>
              </div>
              {/* Trust ring */}
              <div style={{ position: 'relative', width: 40, height: 40, flexShrink: 0 }}>
                <svg width={40} height={40} viewBox="0 0 40 40">
                  <circle cx={20} cy={20} r={16} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={3} />
                  <circle cx={20} cy={20} r={16} fill="none" stroke={trustColor} strokeWidth={3} strokeDasharray={`${comm.trust * 1.005} ${100.5 - comm.trust * 1.005}`} strokeLinecap="round" transform="rotate(-90 20 20)" opacity={0.8} />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontFamily: M, fontWeight: 700, color: trustColor }}>{comm.trust}%</div>
              </div>
              {/* Subscribe toggle */}
              <div style={{ padding: '5px 10px', borderRadius: 6, background: i < 2 ? `${MESH_AMBER}15` : 'rgba(255,255,255,0.04)', border: `1px solid ${i < 2 ? `${MESH_AMBER}30` : 'rgba(255,255,255,0.08)'}`, fontSize: 9, fontFamily: M, fontWeight: 700, color: i < 2 ? MESH_AMBER : 'rgba(255,255,255,0.5)', cursor: 'pointer', flexShrink: 0 }}>{i < 2 ? 'Subscribed' : 'Subscribe'}</div>
            </div>
          )
        })}
        {/* Sanitization policy */}
        <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#10b98115', color: '#10b981', fontFamily: M }}>SANITIZATION</span>
          <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.4)' }}>PII stripped | IPs anonymized | org names redacted</span>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M10. MESH GATEWAY FLOW — Gateway Processing Pipeline
// ═══════════════════════════════════════════════════════════════
const MGF_STAGES = [
  { label: 'Message In', desc: 'Matrix event received', color: '#38bdf8', time: '0ms' },
  { label: 'Policy Check', desc: 'RBAC, classification, redaction', color: '#ef4444', time: '12ms' },
  { label: 'Route', desc: 'human→agent? broadcast?', color: MESH_CYAN, time: '3ms' },
  { label: 'Enrich', desc: 'AEE + Memory + WSM', color: '#a855f7', time: '45ms', branch: true },
  { label: 'Process', desc: 'Collector pipeline, tools', color: '#6366f1', time: '2,100ms' },
  { label: 'Respond', desc: 'Matrix event + VOLT + memory', color: '#10b981', time: '240ms' },
]

export function MeshGatewayFlow() {
  const f = useAnimFrame()
  const W = 660, H = 200
  const reveal = lerp(f, 0, 15, 0, 1)
  const stageW = 90, gapW = 18
  const startX = (W - (MGF_STAGES.length * stageW + (MGF_STAGES.length - 1) * gapW)) / 2
  const cy = 80

  return (
    <div style={{ width: W }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Gateway Processing Pipeline</div>
      <GP style={{ padding: 14 }}>
        <svg width={W - 28} height={H} style={{ opacity: reveal }}>
          {MGF_STAGES.map((stage, i) => {
            const x = startX + i * (stageW + gapW)
            const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
            const pulseActive = Math.floor(f * 0.03) % MGF_STAGES.length === i
            return (
              <g key={i} opacity={op}>
                {/* Stage pill */}
                <rect x={x} y={cy - 22} width={stageW} height={44} rx={8} fill={`${stage.color}10`} stroke={stage.color} strokeWidth={pulseActive ? 2 : 1} strokeOpacity={pulseActive ? 0.8 : 0.4} />
                <text x={x + stageW / 2} y={cy - 4} textAnchor="middle" fill="#fff" fontSize={10} fontFamily={M} fontWeight={700}>{stage.label}</text>
                <text x={x + stageW / 2} y={cy + 10} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize={8} fontFamily={M}>{stage.desc}</text>
                {/* Time */}
                <text x={x + stageW / 2} y={cy + 36} textAnchor="middle" fill={stage.color} fontSize={9} fontFamily={M} fontWeight={700}>{stage.time}</text>
                {/* Arrow to next */}
                {i < MGF_STAGES.length - 1 && (
                  <g>
                    <line x1={x + stageW + 2} y1={cy} x2={x + stageW + gapW - 4} y2={cy} stroke="rgba(255,255,255,0.2)" strokeWidth={1.5} />
                    <polygon points={`${x + stageW + gapW - 4},${cy} ${x + stageW + gapW - 10},${cy - 3} ${x + stageW + gapW - 10},${cy + 3}`} fill="rgba(255,255,255,0.3)" />
                    {/* Animated pulse dot */}
                    {(() => {
                      const t = ((f * 0.03 + i * 0.2) % 1)
                      const px = x + stageW + 2 + t * (gapW - 6)
                      return <circle cx={px} cy={cy} r={2} fill={stage.color} opacity={0.7} />
                    })()}
                  </g>
                )}
                {/* Branch indicator for Enrich */}
                {stage.branch && (
                  <g>
                    {['Memory', 'AEE', 'Collector'].map((b, bi) => (
                      <g key={bi}>
                        <line x1={x + stageW / 2} y1={cy + 22} x2={x + (bi - 1) * 30 + stageW / 2} y2={cy + 55} stroke={stage.color} strokeWidth={0.8} strokeOpacity={0.3} strokeDasharray="3 3" />
                        <text x={x + (bi - 1) * 30 + stageW / 2} y={cy + 65} textAnchor="middle" fill={stage.color} fontSize={7} fontFamily={M} opacity={0.6}>{b}</text>
                      </g>
                    ))}
                  </g>
                )}
              </g>
            )
          })}
        </svg>
        {/* Current message + total time */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>Current: <span style={{ color: '#38bdf8' }}>Adam → CommanderQ:</span> <span style={{ color: 'rgba(255,255,255,0.7)' }}>"scan edge-03 for vulnerabilities"</span></div>
          <div style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: MESH_CYAN }}>Gate→Response: 2.4s</div>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M11. MESH MIGRATION STATUS — Chat Migration Progress
// ═══════════════════════════════════════════════════════════════
const MMS_STEPS = [
  { label: 'Conversations scanned', detail: '247 found', done: true },
  { label: 'Rooms created', detail: '247/247', done: true },
  { label: 'Messages migrating', detail: '12,891/16,543 (78%)', active: true, progress: 78 },
  { label: 'Memory links updating', detail: 'Waiting...', done: false },
  { label: 'localStorage cleanup', detail: 'Waiting...', done: false },
]

export function MeshMigrationStatus() {
  const f = useAnimFrame()
  const totalProgress = 78
  const reveal = lerp(f, 0, 12, 0, 1)

  return (
    <div style={{ width: 480, fontFamily: F, opacity: reveal }}>
      <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Chat Migration Status</div>
      <GP style={{ padding: 0 }}>
        {/* Header */}
        <div style={{ padding: '14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 6 }}>Chat Migration — localStorage → Matrix Rooms</div>
          {/* Progress bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{ width: `${lerp(f, 5, 30, 0, totalProgress)}%`, height: '100%', borderRadius: 4, background: `linear-gradient(90deg, ${MESH_CYAN}, #3b82f6)`, transition: 'width 0.3s' }} />
            </div>
            <span style={{ fontFamily: M, fontSize: 14, fontWeight: 700, color: MESH_CYAN }}>{Math.round(lerp(f, 5, 30, 0, totalProgress))}%</span>
          </div>
        </div>
        {/* Steps */}
        <div style={{ padding: '10px 14px' }}>
          {MMS_STEPS.map((step, i) => {
            const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
            const stepColor = step.done ? '#10b981' : step.active ? '#3b82f6' : 'rgba(255,255,255,0.3)'
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12, opacity: op }}>
                <div style={{ width: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, marginTop: 2 }}>
                  <div style={{ width: step.active ? 14 : 12, height: step.active ? 14 : 12, borderRadius: '50%', background: step.done ? stepColor : 'transparent', border: `2px solid ${stepColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {step.done && <span style={{ fontSize: 8, color: '#0a0e1a', fontWeight: 700 }}>✓</span>}
                    {step.active && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', opacity: 0.5 + Math.sin(f * 0.1) * 0.5 }} />}
                  </div>
                  {i < MMS_STEPS.length - 1 && <div style={{ width: 2, height: 16, background: step.done ? '#10b98140' : 'rgba(255,255,255,0.06)', marginTop: 4 }} />}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: step.done ? '#10b981' : step.active ? '#3b82f6' : 'rgba(255,255,255,0.5)' }}>{step.label}</div>
                  <div style={{ fontSize: 10, fontFamily: M, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{step.detail}</div>
                  {step.active && step.progress && (
                    <div style={{ marginTop: 4, width: 200, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{ width: `${step.progress}%`, height: '100%', borderRadius: 2, background: '#3b82f6', opacity: 0.8 }} />
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {/* Footer */}
        <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>247 conversations → 247 rooms | 16,543 messages | 3 users</div>
            <div style={{ fontSize: 9, fontFamily: M, color: MESH_CYAN, marginTop: 2 }}>Estimated: ~12 minutes remaining</div>
          </div>
          <div style={{ padding: '6px 14px', borderRadius: 6, background: `${MESH_AMBER}15`, border: `1px solid ${MESH_AMBER}30`, fontSize: 10, fontFamily: M, fontWeight: 700, color: MESH_AMBER, cursor: 'pointer' }}>Pause</div>
        </div>
        {/* Warning */}
        <div style={{ padding: '8px 14px', background: `${MESH_AMBER}05`, borderTop: `1px solid ${MESH_AMBER}15`, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: MESH_AMBER, fontSize: 12 }}>⚠</span>
          <span style={{ fontSize: 9, fontFamily: M, color: MESH_AMBER }}>Original data preserved until verification complete</span>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// M12. MESH FULL PAGE — Complete Mesh Dashboard Concept
// ═══════════════════════════════════════════════════════════════
const MFP_ROOMS = [
  { name: 'CommanderQ', type: 'dm', icon: '◈', color: '#10b981', unread: 2 },
  { name: '#security-team', type: 'team', icon: '◆', color: '#a855f7', unread: 0 },
  { name: '#INC-2847', type: 'incident', icon: '⚠', color: '#ef4444', unread: 3 },
  { name: '#deploy-v2.4', type: 'workflow', icon: '▶', color: '#6366f1', unread: 0 },
  { name: '#approvals', type: 'hitl', icon: '◇', color: MESH_AMBER, unread: 2 },
  { name: 'WARDEN', type: 'dm', icon: '◈', color: '#ef4444', unread: 0 },
  { name: '#devops', type: 'team', icon: '◆', color: '#3b82f6', unread: 0 },
  { name: '#ops-wisdom', type: 'federation', icon: '☆', color: MESH_PURPLE, unread: 0 },
]
const MFP_MESSAGES = [
  { sender: 'CommanderQ', time: '14:30', type: 'agent', color: '#6366f1', content: 'Objective decomposed into 4 tasks. Starting execution.' },
  { sender: 'System', time: '14:30', type: 'system', content: 'AEE: quox.objective.start | corr: OBJ-7a3f' },
  { sender: 'VULCAN', time: '14:31', type: 'agent', color: '#3b82f6', content: 'Pulling images on edge-01, edge-02...' },
  { sender: 'Adam', time: '14:31', type: 'human', content: 'Check migration scripts first.' },
  { sender: 'System', time: '14:32', type: 'hitl', content: 'HITL: Deploy to production? [Approve] [Deny]' },
  { sender: 'WARDEN', time: '14:34', type: 'agent', color: '#10b981', content: 'Health checks passed. Verified.' },
]
const MFP_FILTERS = ['All', 'DMs', 'Teams', 'Work']

export function MeshFullPage() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 15, 0, 1)
  const [selectedRoom, setSelectedRoom] = useState(0)

  return (
    <div style={{ width: 660, fontFamily: F, opacity: reveal }}>
      <GP style={{ padding: 0, overflow: 'hidden' }}>
        {/* Top bar */}
        <div style={{ padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,255,255,0.02)' }}>
          <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: MESH_CYAN }}>◈ Quox Mesh</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
            <span style={{ fontFamily: M, fontSize: 9, color: '#10b981' }}>Connected</span>
          </div>
          <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, background: `${MESH_PURPLE}15`, color: MESH_PURPLE, fontFamily: M }}>Federation: 3</span>
          <span style={{ fontSize: 8, color: '#10b981', fontFamily: M, marginLeft: 'auto' }}>🔒 E2E Encrypted</span>
        </div>
        {/* Main content */}
        <div style={{ display: 'flex', height: 440 }}>
          {/* Left sidebar — Room list */}
          <div style={{ width: 160, borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column' }}>
            {/* Filter pills */}
            <div style={{ padding: '6px 8px', display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              {MFP_FILTERS.map(fl => (
                <span key={fl} style={{ padding: '2px 6px', borderRadius: 8, fontSize: 8, fontFamily: M, background: fl === 'All' ? `${MESH_CYAN}15` : 'rgba(255,255,255,0.04)', color: fl === 'All' ? MESH_CYAN : 'rgba(255,255,255,0.5)' }}>{fl}</span>
              ))}
            </div>
            {/* Rooms */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {MFP_ROOMS.map((room, i) => {
                const op = lerp(f, i * 2, i * 2 + 6, 0, 1)
                const isSelected = i === selectedRoom
                return (
                  <div key={i} onClick={() => setSelectedRoom(i)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px', cursor: 'pointer', opacity: op, background: isSelected ? 'rgba(255,255,255,0.04)' : 'transparent', borderLeft: isSelected ? `2px solid ${MESH_CYAN}` : '2px solid transparent' }}>
                    <div style={{ width: 24, height: 24, borderRadius: room.type === 'dm' ? '50%' : 4, background: `${room.color}15`, border: `1px solid ${room.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: room.color, flexShrink: 0 }}>{room.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{room.name}</div>
                    </div>
                    {room.unread > 0 && <div style={{ minWidth: 14, height: 14, borderRadius: 7, background: room.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontFamily: M, fontWeight: 700, color: '#0a0e1a', flexShrink: 0 }}>{room.unread}</div>}
                  </div>
                )
              })}
            </div>
          </div>
          {/* Centre — Timeline */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            {/* Room header */}
            <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{MFP_ROOMS[selectedRoom].name}</span>
              <span style={{ fontSize: 8, fontFamily: M, color: 'rgba(255,255,255,0.4)' }}>5 members</span>
            </div>
            {/* Messages */}
            <div style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>
              {MFP_MESSAGES.map((msg, i) => {
                const op = lerp(f, i * 2 + 5, i * 2 + 12, 0, 1)
                const isHuman = msg.type === 'human'
                const isSystem = msg.type === 'system' || msg.type === 'hitl'
                return (
                  <div key={i} style={{ padding: '4px 12px', opacity: op, display: 'flex', flexDirection: isHuman ? 'row-reverse' : 'row', gap: 6 }}>
                    {!isSystem && (
                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: `${msg.color || '#38bdf8'}15`, border: `1px solid ${msg.color || '#38bdf8'}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontFamily: M, fontWeight: 700, color: msg.color || '#38bdf8', flexShrink: 0, marginTop: 2 }}>{msg.sender[0]}</div>
                    )}
                    <div style={{ maxWidth: '75%' }}>
                      {!isSystem && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, flexDirection: isHuman ? 'row-reverse' : 'row' }}>
                          <span style={{ fontSize: 10, fontWeight: 600, color: msg.color || '#fff' }}>{msg.sender}</span>
                          <span style={{ fontSize: 8, fontFamily: M, color: 'rgba(255,255,255,0.3)' }}>{msg.time}</span>
                        </div>
                      )}
                      <div style={{ padding: '6px 10px', borderRadius: isSystem ? 6 : isHuman ? '10px 10px 4px 10px' : '10px 10px 10px 4px', background: isSystem ? (msg.type === 'hitl' ? `${MESH_AMBER}08` : `${MESH_CYAN}06`) : isHuman ? 'rgba(255,255,255,0.06)' : `${msg.color || '#38bdf8'}08`, border: `1px solid ${isSystem ? (msg.type === 'hitl' ? `${MESH_AMBER}20` : `${MESH_CYAN}15`) : isHuman ? 'rgba(255,255,255,0.08)' : `${msg.color || '#38bdf8'}15`}`, fontSize: 11, color: isSystem ? (msg.type === 'hitl' ? MESH_AMBER : MESH_CYAN) : 'rgba(255,255,255,0.8)', fontFamily: isSystem ? M : F, lineHeight: 1.4 }}>
                        {msg.content}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            {/* Compose */}
            <div style={{ padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14, cursor: 'pointer' }}>📎</span>
              <div style={{ flex: 1, padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>Message...</div>
              <div style={{ padding: '5px 12px', borderRadius: 4, background: `${MESH_CYAN}15`, border: `1px solid ${MESH_CYAN}30`, fontSize: 10, fontFamily: M, fontWeight: 700, color: MESH_CYAN, cursor: 'pointer' }}>Send</div>
            </div>
          </div>
          {/* Right panel — Room details */}
          <div style={{ width: 180, borderLeft: '1px solid rgba(255,255,255,0.06)', padding: '10px' }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 10 }}>ROOM DETAILS</div>
            {/* Members */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>MEMBERS (5)</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {[{ n: 'A', c: '#38bdf8' }, { n: 'C', c: '#6366f1' }, { n: 'F', c: '#3b82f6' }, { n: 'S', c: '#10b981' }, { n: 'X', c: '#a855f7' }].map((m, i) => (
                  <div key={i} style={{ width: 24, height: 24, borderRadius: '50%', background: `${m.c}15`, border: `1px solid ${m.c}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontFamily: M, fontWeight: 700, color: m.c }}>{m.n}</div>
                ))}
              </div>
            </div>
            {/* Linked objective */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>LINKED OBJECTIVE</div>
              <div style={{ padding: '6px 8px', borderRadius: 4, background: '#6366f110', border: '1px solid #6366f120' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#6366f1' }}>obj-7a3f</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>Deploy v2.4.1</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                  <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{ width: '67%', height: '100%', borderRadius: 2, background: '#6366f1' }} />
                  </div>
                  <span style={{ fontSize: 8, fontFamily: M, color: '#6366f1' }}>67%</span>
                </div>
              </div>
            </div>
            {/* VOLT evidence */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>VOLT EVIDENCE</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 18, fontFamily: M, fontWeight: 700, color: '#10b981' }}>7</span>
                <span style={{ fontSize: 9, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>records logged</span>
              </div>
              <div style={{ fontSize: 8, fontFamily: M, color: '#10b981', marginTop: 2 }}>All verified ✓</div>
            </div>
            {/* Room settings */}
            <div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>SETTINGS</div>
              {['Notifications', 'Encryption', 'Auto-archive'].map((s, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{s}</span>
                  <div style={{ width: 24, height: 12, borderRadius: 6, background: i < 2 ? '#10b98140' : 'rgba(255,255,255,0.1)', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: 1, left: i < 2 ? 13 : 1, width: 10, height: 10, borderRadius: '50%', background: i < 2 ? '#10b981' : 'rgba(255,255,255,0.3)' }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ASSISTANTQ — Personal AI Executive Assistant (7 components)
// ═══════════════════════════════════════════════════════════════

// ─── AQ1. AssistantQDashboard — Main Plugin Dashboard ───
const AQ_AGENTS = [
  { id: 'inbox', name: 'Inbox-Q', icon: '\u2709', color: '#3b82f6', stat: '3 urgent, 12 unread', status: 'IMAP connected' },
  { id: 'calendar', name: 'Calendar-Q', icon: '\uD83D\uDCC5', color: '#a855f7', stat: '2 meetings today, 1 conflict', status: 'CalDAV synced' },
  { id: 'action', name: 'Action-Q', icon: '\u2713', color: '#10b981', stat: '7 tasks, 3 due today', status: '89% completion rate' },
  { id: 'browser', name: 'Browser-Q', icon: '\uD83C\uDF10', color: '#06b6d4', stat: '2 active sessions', status: 'Playwright running' },
  { id: 'research', name: 'Research-Q', icon: '\uD83D\uDD0D', color: '#f59e0b', stat: 'Idle \u2014 last used 2h ago', status: 'Standby' },
]
const AQ_FEED = [
  { agent: 'Inbox-Q', action: 'Triaged 12 emails \u2014 3 flagged urgent', time: '2m ago', color: '#3b82f6' },
  { agent: 'Calendar-Q', action: 'Detected scheduling conflict at 11:00', time: '5m ago', color: '#a855f7' },
  { agent: 'Action-Q', action: 'Completed "Prepare Q2 report"', time: '12m ago', color: '#10b981' },
  { agent: 'Research-Q', action: 'Compiled competitor analysis (3 sources)', time: '1h ago', color: '#f59e0b' },
  { agent: 'Browser-Q', action: 'Downloaded invoice PDF from Hetzner', time: '2h ago', color: '#06b6d4' },
]
const AQ_QUICK = [
  { label: 'Check Email', icon: '\u2709', color: '#3b82f6' },
  { label: "Today's Schedule", icon: '\uD83D\uDCC5', color: '#a855f7' },
  { label: 'Create Task', icon: '\u2795', color: '#10b981' },
  { label: 'Research Topic', icon: '\uD83D\uDD0D', color: '#f59e0b' },
]

export function AssistantQDashboard() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.06) * 0.3
  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #3b82f6 0%, #a855f7 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 800, color: '#fff', fontFamily: F }}>Q</div>
          <div>
            <div style={{ fontFamily: F, fontSize: 15, fontWeight: 700, color: '#fff' }}>Assistant-Q</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>Personal AI Executive Assistant</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#30ff90', boxShadow: `0 0 ${6 + pulse * 4}px #30ff9060`, opacity: pulse }} />
          <span style={{ fontFamily: M, fontSize: 9, color: '#30ff90', fontWeight: 600 }}>ONLINE</span>
        </div>
      </div>

      {/* 5 Agent Cards */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {AQ_AGENTS.map((a, i) => {
          const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
          return (
            <GP key={a.id} style={{ flex: 1, padding: '10px 8px', borderTopColor: `${a.color}30`, opacity: op }}>
              <div style={{ textAlign: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 20 }}>{a.icon}</span>
              </div>
              <div style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: a.color, textAlign: 'center', marginBottom: 4 }}>{a.name}</div>
              <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.8)', textAlign: 'center', marginBottom: 4, lineHeight: 1.3 }}>{a.stat}</div>
              <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>{a.status}</div>
            </GP>
          )
        })}
      </div>

      {/* Recent Activity */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: 1, marginBottom: 6 }}>RECENT ACTIVITY</div>
        {AQ_FEED.map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
            <span style={{ fontFamily: M, fontSize: 9, color: item.color, fontWeight: 600, minWidth: 65 }}>{item.agent}</span>
            <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{item.action}</span>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{item.time}</span>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {AQ_QUICK.map((q, i) => (
          <div key={i} style={{ flex: 1, padding: '8px 6px', borderRadius: 8, background: `${q.color}10`, border: `1px solid ${q.color}25`, textAlign: 'center', cursor: 'pointer' }}>
            <span style={{ fontSize: 14 }}>{q.icon}</span>
            <div style={{ fontFamily: M, fontSize: 8, color: q.color, marginTop: 3, fontWeight: 600 }}>{q.label}</div>
          </div>
        ))}
      </div>

      {/* Stats Bar */}
      <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', textAlign: 'center' }}>
          47 tasks completed this week &nbsp;\u2502&nbsp; 1,247 emails processed &nbsp;\u2502&nbsp; 12 meetings managed
        </div>
      </div>
    </div>
  )
}

// ─── AQ2. AssistantQInbox — Email Triage View ───
const AQ_TRIAGE = {
  urgent: { label: 'Urgent', color: '#ef4444', icon: '\uD83D\uDD34', items: [
    { from: 'Sarah Chen', subject: 'Q2 Partnership Proposal \u2014 Response Needed by Friday', preview: '$50K deal. Needs review + response.' },
    { from: 'Board Secretary', subject: 'Emergency Board Vote Required', preview: 'Acquisition approval. Deadline: 5pm today.' },
    { from: 'Security Team', subject: 'CVE-2026-1847 \u2014 Patch Required', preview: 'Critical vuln in auth service. Patch ready.' },
  ]},
  action: { label: 'Action Required', color: '#f59e0b', icon: '\uD83D\uDFE1', items: [
    { from: 'HR Director', subject: 'Approve Q2 Headcount Plan', preview: '3 new positions, budget attached.' },
    { from: 'Adam (CEO)', subject: 'Review investor deck by Thursday', preview: 'Final version, needs sign-off.' },
    { from: 'Legal', subject: 'NDA for Acme Corp partnership', preview: 'Standard terms, review clause 7.' },
    { from: 'DevOps', subject: 'Production migration sign-off', preview: 'Docker01-04 migration plan attached.' },
    { from: 'Finance', subject: 'Q1 actuals vs forecast variance', preview: 'Revenue 12% above forecast.' },
  ]},
  fyi: { label: 'FYI', color: '#3b82f6', icon: '\uD83D\uDD35', items: [
    { from: 'Newsletter', subject: 'AI Governance Weekly #47', preview: 'EU AI Act updates...' },
    { from: 'GitHub', subject: 'PR #289 merged to main', preview: 'Auth refactor complete.' },
  ]},
  archive: { label: 'Archive', color: 'rgba(255,255,255,0.3)', icon: '\u26AA', items: [
    { from: 'Marketing', subject: 'Social metrics dashboard', preview: 'Weekly report attached.' },
  ]},
}

export function AssistantQInbox() {
  const f = useAnimFrame()
  const [selected] = useState(0)
  const sel = AQ_TRIAGE.urgent.items[selected]
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>{'\u2709'}</span>
          <div>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Inbox-Q \u2014 Email Intelligence</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>3 inboxes connected</div>
          </div>
        </div>
        <div style={{ fontFamily: M, fontSize: 9, color: '#3b82f6' }}>IMAP \u2713</div>
      </div>

      {/* Triage Columns */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {Object.entries(AQ_TRIAGE).map(([key, cat]) => (
          <div key={key} style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
              <span style={{ fontSize: 10 }}>{cat.icon}</span>
              <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: cat.color }}>{cat.label}</span>
              <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>({cat.items.length})</span>
            </div>
            {cat.items.slice(0, 3).map((item, i) => {
              const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
              return (
                <GP key={i} style={{ padding: '6px 8px', marginBottom: 4, borderTopColor: `${cat.color}20`, opacity: op }}>
                  <div style={{ fontFamily: M, fontSize: 8, color: cat.color, fontWeight: 600, marginBottom: 2 }}>{item.from}</div>
                  <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.8)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.subject}</div>
                </GP>
              )
            })}
          </div>
        ))}
      </div>

      {/* Selected Email Preview */}
      <GP style={{ padding: 12, marginBottom: 10, borderTopColor: '#ef444430' }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>SELECTED EMAIL</div>
        <div style={{ fontFamily: M, fontSize: 9, color: '#ef4444', marginBottom: 2 }}>From: Sarah Chen &lt;sarah@partner.com&gt;</div>
        <div style={{ fontFamily: F, fontSize: 11, color: '#fff', fontWeight: 600, marginBottom: 6 }}>{sel.subject}</div>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>AI SUMMARY</div>
        <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', marginBottom: 8, lineHeight: 1.4 }}>Partnership proposal for joint AI governance toolkit. $50K deal. Needs review + response.</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['Draft Reply', 'Forward to Team', 'Create Task', 'Schedule Meeting'].map((a, i) => (
            <div key={i} style={{ padding: '5px 10px', borderRadius: 6, background: i === 0 ? '#3b82f620' : 'rgba(255,255,255,0.04)', border: `1px solid ${i === 0 ? '#3b82f630' : 'rgba(255,255,255,0.08)'}`, fontFamily: M, fontSize: 8, color: i === 0 ? '#3b82f6' : 'rgba(255,255,255,0.6)', cursor: 'pointer', fontWeight: 600 }}>{a}</div>
          ))}
        </div>
      </GP>

      {/* Stats */}
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
        28 emails today &nbsp;\u2502&nbsp; 3 auto-archived &nbsp;\u2502&nbsp; 5 drafts prepared &nbsp;\u2502&nbsp; avg triage time: 1.2s
      </div>
    </div>
  )
}

// ─── AQ3. AssistantQCalendar — Calendar Intelligence ───
const AQ_SCHEDULE = [
  { time: '09:00', end: '10:00', title: 'Team Standup', color: '#3b82f6', attendees: 5, note: 'Recurring', conflict: false },
  { time: '11:00', end: '11:30', title: 'Investor Call', color: '#a855f7', attendees: 2, note: '\u26A0 CONFLICT', conflict: true },
  { time: '11:15', end: '12:00', title: 'Product Review', color: '#ef4444', attendees: 4, note: 'OVERLAPS Investor Call', conflict: true },
  { time: '14:00', end: '15:00', title: 'Security Audit Review', color: '#10b981', attendees: 3, note: 'WARDEN prepared brief', conflict: false },
  { time: '16:00', end: '16:30', title: '1:1 with CTO', color: '#3b82f6', attendees: 2, note: '', conflict: false },
]

export function AssistantQCalendar() {
  const f = useAnimFrame()
  const hours = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']
  const pulse = 0.7 + Math.sin(f * 0.08) * 0.3
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>{'\uD83D\uDCC5'}</span>
          <div>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Calendar-Q \u2014 Schedule Intelligence</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Today \u2014 25 March 2026</div>
          </div>
        </div>
        <div style={{ fontFamily: M, fontSize: 9, color: '#a855f7' }}>CalDAV \u2713</div>
      </div>

      {/* Timeline */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 40, flexShrink: 0 }}>
          {hours.map((h, i) => (
            <div key={i} style={{ height: 28, fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', display: 'flex', alignItems: 'flex-start' }}>{h}</div>
          ))}
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          {hours.map((_, i) => (
            <div key={i} style={{ height: 28, borderTop: '1px solid rgba(255,255,255,0.04)' }} />
          ))}
          {AQ_SCHEDULE.map((ev, i) => {
            const startH = parseInt(ev.time.split(':')[0]) - 8
            const startM = parseInt(ev.time.split(':')[1])
            const endH = parseInt(ev.end.split(':')[0]) - 8
            const endM = parseInt(ev.end.split(':')[1])
            const top = (startH + startM / 60) * 28
            const height = Math.max(20, ((endH + endM / 60) - (startH + startM / 60)) * 28)
            const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
            return (
              <div key={i} style={{
                position: 'absolute', top, left: ev.conflict && i === 2 ? '52%' : 0, right: 0, height,
                background: ev.conflict ? `${ev.color}12` : `${ev.color}15`,
                border: `1px solid ${ev.color}${ev.conflict ? '40' : '30'}`,
                borderLeft: `3px solid ${ev.color}`,
                borderRadius: 6, padding: '4px 8px', opacity: op,
                borderStyle: ev.conflict && i === 2 ? 'dashed' : 'solid',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff' }}>{ev.title}</span>
                  <span style={{ fontFamily: M, fontSize: 7, color: ev.color }}>{ev.attendees} {'\uD83D\uDC64'}</span>
                </div>
                {ev.note && <div style={{ fontFamily: M, fontSize: 7, color: ev.conflict ? '#ef4444' : 'rgba(255,255,255,0.4)', marginTop: 1, opacity: ev.conflict ? pulse : 1 }}>{ev.note}</div>}
              </div>
            )
          })}
        </div>
      </div>

      {/* Conflict Alert */}
      <GP style={{ padding: 10, marginBottom: 10, borderTopColor: '#f59e0b30' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 12 }}>{'\u26A0\uFE0F'}</span>
          <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: '#f59e0b' }}>CONFLICT DETECTED</span>
        </div>
        <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4 }}>
          11:00-12:00: Investor Call overlaps Product Review \u2014 Calendar-Q suggests rescheduling Product Review to 13:00
        </div>
      </GP>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Tomorrow: 3 meetings, no conflicts</div>
        <div style={{ fontFamily: M, fontSize: 9, color: '#f59e0b' }}>Brief for Investor Call prepared by Research-Q (2 pages)</div>
      </div>
    </div>
  )
}

// ─── AQ4. AssistantQActions — Task Management ───
const AQ_TASKS = {
  today: [
    { title: 'Respond to partnership proposal', priority: 'critical', due: 'Today 5pm', agent: 'Inbox-Q', progress: 0, done: false },
    { title: 'Review PR #47', priority: 'high', due: 'Today 3pm', agent: null, progress: 60, done: false },
    { title: 'Approve deployment to production', priority: 'high', due: 'Today EOD', agent: 'Action-Q', progress: 80, done: false },
  ],
  week: [
    { title: 'Q2 report draft', priority: 'medium', due: 'Wed', agent: 'Research-Q', progress: 45, done: false },
    { title: 'Security audit follow-up', priority: 'medium', due: 'Thu', agent: 'Action-Q', progress: 20, done: false },
    { title: 'Budget review', priority: 'medium', due: 'Fri', agent: null, progress: 0, done: false },
    { title: 'Team 1:1s', priority: 'low', due: 'Fri', agent: null, progress: 50, done: false },
  ],
  backlog: [
    { title: 'Evaluate new CI pipeline', priority: 'low', due: '\u2014', agent: null, progress: 0, done: false },
    { title: 'Draft hiring plan for H2', priority: 'low', due: '\u2014', agent: null, progress: 10, done: false },
    { title: 'Vendor comparison for monitoring', priority: 'low', due: '\u2014', agent: null, progress: 0, done: false },
    { title: 'Update onboarding docs', priority: 'low', due: '\u2014', agent: null, progress: 0, done: false },
    { title: 'Archive old project repos', priority: 'low', due: '\u2014', agent: null, progress: 0, done: false },
  ],
}
const AQ_PRI_COLORS = { critical: '#ef4444', high: '#f59e0b', medium: '#3b82f6', low: 'rgba(255,255,255,0.3)' }

export function AssistantQActions() {
  const f = useAnimFrame()
  const renderSection = (label, tasks, urgColor) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: urgColor }} />
        <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: urgColor, letterSpacing: 1 }}>{label}</span>
        <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>({tasks.length})</span>
      </div>
      {tasks.map((t, i) => {
        const pc = AQ_PRI_COLORS[t.priority]
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', marginBottom: 3, borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ width: 14, height: 14, borderRadius: 4, border: `1.5px solid ${pc}`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {t.done && <span style={{ color: pc, fontSize: 9 }}>{'\u2713'}</span>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
              {t.progress > 0 && <div style={{ marginTop: 3, height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${t.progress}%`, height: '100%', background: pc, borderRadius: 1 }} />
              </div>}
            </div>
            <span style={{ fontFamily: M, fontSize: 7, padding: '2px 5px', borderRadius: 3, background: `${pc}15`, color: pc, fontWeight: 600 }}>{t.priority}</span>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', minWidth: 50, textAlign: 'right' }}>{t.due}</span>
            {t.agent && <span style={{ fontFamily: M, fontSize: 7, color: '#06b6d4' }}>{t.agent}</span>}
          </div>
        )
      })}
    </div>
  )
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 18 }}>{'\u2713'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Action-Q \u2014 Task Management</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Personal to-do system</div>
        </div>
      </div>
      {renderSection('DUE TODAY', AQ_TASKS.today, '#ef4444')}
      {renderSection('THIS WEEK', AQ_TASKS.week, '#f59e0b')}
      {renderSection('BACKLOG', AQ_TASKS.backlog, 'rgba(255,255,255,0.3)')}
      <GP style={{ padding: 10, marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>AI INSIGHTS</div>
        <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4 }}>You complete 89% of tasks on time. Tuesdays are your most productive day.</div>
        <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>Your team: 23 tasks open, 7 overdue</div>
      </GP>
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1, padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Add a new task...</div>
        <div style={{ padding: '6px 14px', borderRadius: 6, background: '#10b98120', border: '1px solid #10b98130', fontFamily: M, fontSize: 9, color: '#10b981', fontWeight: 600, cursor: 'pointer' }}>Add Task</div>
      </div>
    </div>
  )
}

// ─── AQ5. AssistantQDemo — The Demo Scenario ───
const AQ_DEMO_STEPS = [
  { icon: '\uD83D\uDCF1', label: 'Adam sends Telegram message', protocols: ['AEE'], status: 'done' },
  { icon: '\uD83D\uDCE1', label: 'Telegram webhook receives', protocols: ['AEE'], status: 'done' },
  { icon: '\uD83E\uDDE0', label: 'Routes to CommanderQ \u2192 delegates to Assistant-Q', protocols: ['AEE', 'AOCL'], status: 'done' },
  { icon: '\uD83D\uDCCB', label: 'Assistant-Q decomposes into 3 tasks', protocols: ['AEE', 'VOLT'], status: 'active' },
  { icon: '\u2709\uFE0F', label: 'Inbox-Q reads email via IMAP connector', protocols: ['VOLT'], status: 'pending' },
  { icon: '\uD83D\uDCC5', label: 'Calendar-Q checks schedule via CalDAV', protocols: ['VOLT'], status: 'pending' },
  { icon: '\u2705', label: 'Action-Q creates prep task', protocols: ['VOLT'], status: 'pending' },
  { icon: '\uD83D\uDD0F', label: 'Every step: AEE + WARD witness', protocols: ['AEE', 'WARD'], status: 'pending' },
  { icon: '\uD83D\uDCE6', label: 'VOLT evidence bundle finalised', protocols: ['VOLT', 'WARD'], status: 'pending' },
  { icon: '\uD83D\uDCAC', label: 'Reply sent back on Telegram', protocols: ['AEE'], status: 'pending' },
]
const AQ_PROTO_COLORS = { AEE: '#3b82f6', VOLT: '#10b981', WARD: '#a855f7', AOCL: '#f59e0b' }

export function AssistantQDemo() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 14 }}>
        <div style={{ fontFamily: F, fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 2 }}>The Demo \u2014 End-to-End Integration Proof</div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Telegram \u2192 CommanderQ \u2192 Assistant-Q \u2192 5 Agents \u2192 Evidence \u2192 Reply</div>
      </div>

      <div style={{ position: 'relative', paddingLeft: 32 }}>
        <div style={{ position: 'absolute', left: 14, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.06)' }} />
        {AQ_DEMO_STEPS.map((step, i) => {
          const isDone = step.status === 'done'
          const isActive = step.status === 'active'
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          const pulse = isActive ? 0.7 + Math.sin(f * 0.1) * 0.3 : 1
          const dotColor = isDone ? '#30ff90' : isActive ? '#38bdf8' : 'rgba(255,255,255,0.15)'
          return (
            <div key={i} style={{ position: 'relative', marginBottom: 8, opacity: op }}>
              {/* Step number on the line */}
              <div style={{ position: 'absolute', left: -26, top: 6, width: 20, height: 20, borderRadius: '50%', background: isDone ? '#30ff9015' : isActive ? '#38bdf815' : 'rgba(255,255,255,0.03)', border: `1.5px solid ${dotColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 8, fontWeight: 700, color: dotColor, boxShadow: isActive ? `0 0 8px #38bdf840` : 'none' }}>
                {isDone ? '\u2713' : i + 1}
              </div>
              <GP style={{ padding: '8px 12px', borderTopColor: isDone ? '#30ff9020' : isActive ? '#38bdf820' : 'rgba(255,255,255,0.03)', opacity: step.status === 'pending' ? 0.45 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, opacity: pulse }}>{step.icon}</span>
                  <span style={{ fontFamily: F, fontSize: 11, color: '#fff', flex: 1, fontWeight: isActive ? 600 : 400 }}>{step.label}</span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {step.protocols.map((p, pi) => (
                      <span key={pi} style={{ fontFamily: M, fontSize: 7, padding: '1px 5px', borderRadius: 3, background: `${AQ_PROTO_COLORS[p]}15`, color: AQ_PROTO_COLORS[p], fontWeight: 600 }}>{p}</span>
                    ))}
                  </div>
                </div>
              </GP>
            </div>
          )
        })}
      </div>

      <div style={{ textAlign: 'center', marginTop: 10 }}>
        <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.6)', fontStyle: 'italic' }}>This is not a slide deck \u2014 it's a live demo.</div>
      </div>
    </div>
  )
}

// ─── AQ6. AssistantQBrowser — Browser Automation ───
const AQ_SESSIONS = [
  { title: 'GitHub \u2014 PR Review #47', url: 'github.com/quoxai/quox/pull/47', status: 'Reading diff, preparing summary', color: '#38bdf8', gradient: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' },
  { title: 'Hetzner Console \u2014 Server check', url: 'console.hetzner.cloud/projects/...', status: 'Checking edge-03 health', color: '#ef4444', gradient: 'linear-gradient(135deg, #1a1a2e 0%, #2d1b2e 50%, #1a1a2e 100%)' },
]
const AQ_BROWSER_LOG = [
  { action: 'Submitted PR comment on #47', time: '3m ago', color: '#38bdf8' },
  { action: 'Downloaded invoice PDF from Hetzner', time: '15m ago', color: '#10b981' },
  { action: 'Captured screenshot of monitoring page', time: '1h ago', color: '#a855f7' },
]

export function AssistantQBrowser() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.08) * 0.3
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>{'\uD83C\uDF10'}</span>
          <div>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Browser-Q \u2014 Intelligent Web Automation</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Playwright headless engine</div>
          </div>
        </div>
        <div style={{ fontFamily: M, fontSize: 9, color: '#06b6d4' }}>2 sessions active</div>
      </div>

      {/* Active Sessions */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {AQ_SESSIONS.map((s, i) => (
          <GP key={i} style={{ flex: 1, padding: 10, borderTopColor: `${s.color}30` }}>
            <div style={{ width: '100%', height: 70, borderRadius: 6, background: s.gradient, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.2)' }}>LIVE SCREENSHOT</div>
            </div>
            <div style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff', marginBottom: 2 }}>{s.title}</div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.url}</div>
            <div style={{ fontFamily: M, fontSize: 8, color: s.color }}>{s.status}</div>
          </GP>
        ))}
      </div>

      {/* HITL Gate */}
      <GP style={{ padding: 10, marginBottom: 12, borderTopColor: '#f59e0b30' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, opacity: pulse }}>{'\u26A1'}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: '#f59e0b' }}>HITL GATE \u2014 Login Required</div>
            <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>GitHub OAuth \u2014 Browser-Q needs approval to authenticate</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ padding: '4px 12px', borderRadius: 6, background: '#10b98120', border: '1px solid #10b98130', fontFamily: M, fontSize: 9, color: '#10b981', fontWeight: 600, cursor: 'pointer' }}>Approve</div>
            <div style={{ padding: '4px 12px', borderRadius: 6, background: '#ef444420', border: '1px solid #ef444430', fontFamily: M, fontSize: 9, color: '#ef4444', fontWeight: 600, cursor: 'pointer' }}>Deny</div>
          </div>
        </div>
      </GP>

      {/* Recent Actions */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>RECENT ACTIONS</div>
        {AQ_BROWSER_LOG.map((a, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ width: 4, height: 4, borderRadius: '50%', background: a.color }} />
            <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{a.action}</span>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{a.time}</span>
          </div>
        ))}
      </div>

      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', padding: '6px 8px', borderRadius: 4, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
        {'\uD83D\uDD12'} All browser actions require HITL approval for: logins, payments, form submissions
      </div>
    </div>
  )
}

// ─── AQ7. AssistantQEvidence — VOLT Evidence Bundle ───
const AQ_EV_ENTRIES = [
  { type: 'AEE', label: 'Telegram inbound', actor: 'telegram-webhook', hash: '8f3a2c...d71e', time: '14:30:01', verified: true },
  { type: 'AOCL', label: 'Semantic routing decision (L2)', actor: 'commanderq-router', hash: 'a12b7e...9f03', time: '14:30:02', verified: true },
  { type: 'AEE', label: 'Delegation to Assistant-Q', actor: 'commanderq', hash: 'c4d891...b2a7', time: '14:30:03', verified: true },
  { type: 'VOLT', label: 'Inbox-Q IMAP read', actor: 'inbox-q', hash: 'e7f234...1c8b', time: '14:30:15', verified: true },
  { type: 'VOLT', label: 'Calendar-Q CalDAV query', actor: 'calendar-q', hash: 'f9a1c3...4d2e', time: '14:30:18', verified: true },
  { type: 'VOLT', label: 'Action-Q task creation', actor: 'action-q', hash: '3b7e91...a8c4', time: '14:30:22', verified: true },
  { type: 'WARD', label: 'WARD witness receipt', actor: 'ward-witness', hash: 'd2c4f7...6e91', time: '14:30:25', verified: true },
  { type: 'AEE', label: 'Telegram reply sent', actor: 'telegram-webhook', hash: '1a9b3c...f274', time: '14:30:28', verified: true },
]

export function AssistantQEvidence() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, color: '#10b981' }}>{'\uD83D\uDD0F'}</span>
          <div>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Evidence Bundle \u2014 obj-7a3f</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>AssistantQ Telegram flow</div>
          </div>
        </div>
        <div style={{ padding: '3px 10px', borderRadius: 6, background: '#10b98115', border: '1px solid #10b98130' }}>
          <span style={{ fontFamily: M, fontSize: 9, color: '#10b981', fontWeight: 700 }}>VOLT VERIFIED</span>
        </div>
      </div>

      <div style={{ position: 'relative', paddingLeft: 28 }}>
        <div style={{ position: 'absolute', left: 12, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.06)' }} />
        {AQ_EV_ENTRIES.map((ev, i) => {
          const pColor = AQ_PROTO_COLORS[ev.type] || '#fff'
          const op = lerp(f, i * 2, i * 2 + 6, 0, 1)
          return (
            <div key={i} style={{ position: 'relative', marginBottom: 6, opacity: op }}>
              <div style={{ position: 'absolute', left: -22, top: 8, width: 8, height: 8, borderRadius: '50%', background: pColor, opacity: 0.8, boxShadow: `0 0 6px ${pColor}44` }} />
              <GP style={{ padding: '7px 10px', borderTopColor: `${pColor}20` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: M, fontSize: 8, padding: '1px 5px', borderRadius: 3, background: `${pColor}15`, color: pColor, fontWeight: 700 }}>{ev.type}</span>
                    <span style={{ fontFamily: F, fontSize: 10, color: '#fff' }}>{ev.label}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{ev.time}</span>
                    {ev.verified && <span style={{ fontFamily: M, fontSize: 8, color: '#10b981' }}>{'\u2713'}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                  <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Actor: {ev.actor}</span>
                  <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>Hash: {ev.hash}</span>
                </div>
              </GP>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <div style={{ fontFamily: M, fontSize: 9, color: '#10b981' }}>Complete chain \u2014 8/8 events verified, WARD-witnessed</div>
        <div style={{ padding: '5px 12px', borderRadius: 6, background: '#10b98115', border: '1px solid #10b98125', fontFamily: M, fontSize: 9, color: '#10b981', cursor: 'pointer', fontWeight: 600 }}>Download Evidence Bundle (JSON)</div>
      </div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// CONTENTOPS STUDIO — Branded Content Pipeline (7 components)
// ═══════════════════════════════════════════════════════════════

// ─── CO1. ContentOpsDashboard — Main Plugin Dashboard ───
const CO_PIPELINES = [
  { title: 'Q2 Product Update Blog Post', stage: 'Review', stageNum: '4/5', writer: 'WRITER', reviewer: 'REVIEW', status: 'active', color: '#38bdf8' },
  { title: 'LinkedIn Thought Leadership Series', stage: 'Planning', stageNum: '2/5', writer: 'PLANNING', reviewer: null, status: 'draft', color: '#f59e0b' },
  { title: 'Security Best Practices Guide', stage: 'Published', stageNum: '5/5', writer: null, reviewer: null, status: 'published', color: '#10b981', views: '1,247', published: '2 days ago' },
]
const CO_TEAM = [
  { name: 'IDEAS', color: '#f59e0b', initial: 'I' },
  { name: 'RESEARCH', color: '#06b6d4', initial: 'R' },
  { name: 'PLANNING', color: '#3b82f6', initial: 'P' },
  { name: 'WRITER', color: '#a855f7', initial: 'W' },
  { name: 'REVIEW', color: '#10b981', initial: 'V' },
  { name: 'REFINEMENT', color: '#ec4899', initial: 'F' },
]

export function ContentOpsDashboard() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #ec4899 0%, #f59e0b 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: '#fff', fontFamily: M }}>CO</div>
          <div>
            <div style={{ fontFamily: F, fontSize: 15, fontWeight: 700, color: '#fff' }}>ContentOps Studio</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>Branded Content at Scale</div>
          </div>
        </div>
        <div style={{ padding: '3px 10px', borderRadius: 6, background: '#ec489915', border: '1px solid #ec489930' }}>
          <span style={{ fontFamily: M, fontSize: 10, color: '#ec4899', fontWeight: 700 }}>$79/mo</span>
        </div>
      </div>

      {/* Pipeline Cards */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {CO_PIPELINES.map((p, i) => {
          const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
          return (
            <GP key={i} style={{ flex: 1, padding: 10, borderTopColor: `${p.color}30`, opacity: op }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontFamily: M, fontSize: 8, padding: '2px 6px', borderRadius: 3, background: `${p.color}15`, color: p.color, fontWeight: 700, textTransform: 'uppercase' }}>{p.status}</span>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{p.stageNum}</span>
              </div>
              <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 6, lineHeight: 1.3 }}>{p.title}</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Stage: {p.stage}</div>
              {p.writer && <div style={{ fontFamily: M, fontSize: 8, color: p.color, marginTop: 2 }}>{p.writer} agent active</div>}
              {p.views && <div style={{ fontFamily: M, fontSize: 8, color: '#10b981', marginTop: 4 }}>{p.views} views \u2022 Published {p.published}</div>}
              {/* Progress bar */}
              <div style={{ marginTop: 6, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${(parseInt(p.stageNum) / 5) * 100}%`, height: '100%', borderRadius: 2, background: p.color }} />
              </div>
            </GP>
          )
        })}
      </div>

      {/* Agent Team Strip */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>CONTENT TEAM</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {CO_TEAM.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: `${a.color}15`, border: `1px solid ${a.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontFamily: M, fontWeight: 700, color: a.color }}>{a.initial}</div>
              <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{a.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', textAlign: 'center' }}>
          23 pieces published &nbsp;\u2502&nbsp; 4.2K words this week &nbsp;\u2502&nbsp; Brand compliance: 98%
        </div>
      </div>
    </div>
  )
}

// ─── CO2. ContentOpsVoice — VoiceOps Brand Voice Editor ───
export function ContentOpsVoice() {
  const f = useAnimFrame()
  const formalPos = 70
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>VoiceOps \u2014 Define How You Sound</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Brand voice configuration</div>
        </div>
        <div style={{ padding: '3px 10px', borderRadius: 6, background: '#a855f715', border: '1px solid #a855f730' }}>
          <span style={{ fontFamily: M, fontSize: 10, color: '#a855f7', fontWeight: 700 }}>$49/mo</span>
        </div>
      </div>

      {/* Brand Profile */}
      <GP style={{ padding: 12, marginBottom: 10, borderTopColor: '#a855f720' }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: 1 }}>BRAND PROFILE</div>
        <div style={{ display: 'flex', gap: 20, marginBottom: 10 }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginBottom: 2 }}>COMPANY</div>
            <div style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: '#fff' }}>Quox LTD</div>
          </div>
          <div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginBottom: 2 }}>TONE</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {['Professional', 'Technical', 'Direct'].map((t, i) => (
                <span key={i} style={{ fontFamily: M, fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#a855f715', color: '#a855f7', fontWeight: 600 }}>{t}</span>
              ))}
            </div>
          </div>
        </div>
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginBottom: 4 }}>AVOID</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {['Marketing hype', 'Exclamation marks', 'Em dashes', 'Filler words', 'Buzzwords'].map((t, i) => (
              <span key={i} style={{ fontFamily: M, fontSize: 8, padding: '2px 6px', borderRadius: 3, background: '#ef444410', color: '#ef4444', border: '1px solid #ef444420' }}>{t}</span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>UK English</span>
          <div style={{ width: 28, height: 14, borderRadius: 7, background: '#10b98140', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 2, left: 15, width: 10, height: 10, borderRadius: '50%', background: '#10b981' }} />
          </div>
          <span style={{ fontFamily: M, fontSize: 8, color: '#10b981' }}>ON</span>
        </div>
        <div>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginBottom: 4 }}>FORMALITY</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Casual</span>
            <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', position: 'relative' }}>
              <div style={{ width: `${formalPos}%`, height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, #38bdf8, #a855f7)' }} />
              <div style={{ position: 'absolute', top: -4, left: `${formalPos}%`, transform: 'translateX(-50%)', width: 12, height: 12, borderRadius: '50%', background: '#a855f7', border: '2px solid rgba(0,0,0,0.5)' }} />
            </div>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Formal</span>
          </div>
        </div>
      </GP>

      {/* Writing Rules */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4, letterSpacing: 1 }}>WRITING RULES</div>
        {['No filler words', 'Lead with the point', 'UK English spelling', 'No buzzwords', 'Technical accuracy over simplicity'].map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
            <span style={{ fontFamily: M, fontSize: 8, color: '#10b981' }}>{'\u2713'}</span>
            <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>{r}</span>
          </div>
        ))}
      </div>

      {/* Before/After */}
      <GP style={{ padding: 10, marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>SAMPLE OUTPUT</div>
        <div style={{ fontFamily: F, fontSize: 10, color: '#ef4444', marginBottom: 4, lineHeight: 1.4, textDecoration: 'line-through', opacity: 0.6 }}>Before: "Our revolutionary AI solution seamlessly empowers..."</div>
        <div style={{ fontFamily: F, fontSize: 10, color: '#10b981', lineHeight: 1.4 }}>After: "QuoxCORE runs 16 agents that execute tasks with auditable evidence."</div>
      </GP>

      <div style={{ padding: '8px 14px', borderRadius: 8, background: '#a855f715', border: '1px solid #a855f725', textAlign: 'center', cursor: 'pointer' }}>
        <span style={{ fontFamily: M, fontSize: 10, color: '#a855f7', fontWeight: 700 }}>Apply to all agents</span>
      </div>
    </div>
  )
}

// ─── CO3. ContentOpsImage — ImageOps Visual Identity ───
const CO_PALETTE = [
  { name: 'Cyan', hex: '#06b6d4' }, { name: 'Purple', hex: '#a855f7' }, { name: 'Green', hex: '#10b981' },
  { name: 'Indigo', hex: '#6366f1' }, { name: 'Amber', hex: '#f59e0b' }, { name: 'Red', hex: '#ef4444' },
]
const CO_IMAGES = [
  { title: 'Blog hero', gradient: 'linear-gradient(135deg, #06b6d4 0%, #a855f7 100%)' },
  { title: 'Social banner', gradient: 'linear-gradient(135deg, #6366f1 0%, #ec4899 100%)' },
  { title: 'Product screenshot', gradient: 'linear-gradient(135deg, #10b981 0%, #06b6d4 100%)' },
  { title: 'Team photo', gradient: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)' },
]

export function ContentOpsImage() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>ImageOps \u2014 Define How You Look</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Visual identity management</div>
        </div>
      </div>

      {/* Palette */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>BRAND PALETTE</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {CO_PALETTE.map((c, i) => (
            <div key={i} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ width: '100%', height: 32, borderRadius: 6, background: c.hex, marginBottom: 4, border: '1px solid rgba(255,255,255,0.1)' }} />
              <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.5)' }}>{c.name}</div>
              <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{c.hex}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Typography */}
      <GP style={{ padding: 10, marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>TYPOGRAPHY</div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
          <div>
            <div style={{ fontFamily: F, fontSize: 18, fontWeight: 700, color: '#fff' }}>Inter</div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>UI + Body text</div>
          </div>
          <div>
            <div style={{ fontFamily: M, fontSize: 16, fontWeight: 700, color: '#38bdf8' }}>JetBrains Mono</div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Data + Code</div>
          </div>
        </div>
      </GP>

      {/* Logo */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <GP style={{ flex: 1, padding: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'linear-gradient(135deg, #06b6d4 0%, #a855f7 50%, #6366f1 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 900, color: '#fff', fontFamily: F }}>Q</div>
          <div>
            <div style={{ fontFamily: F, fontSize: 12, fontWeight: 700, color: '#fff' }}>Quox Logo</div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Gradient icon mark</div>
          </div>
        </GP>
        <GP style={{ flex: 1, padding: 10 }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>IMAGE STYLE</div>
          <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.6)', lineHeight: 1.4 }}>Dark backgrounds, glass morphism, no stock photos, generated assets preferred</div>
        </GP>
      </div>

      {/* Recent Images */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>RECENT IMAGES</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {CO_IMAGES.map((img, i) => (
            <div key={i} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ width: '100%', height: 50, borderRadius: 6, background: img.gradient, marginBottom: 4, border: '1px solid rgba(255,255,255,0.06)' }} />
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{img.title}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: '6px 10px', borderRadius: 6, background: '#f59e0b10', border: '1px solid #f59e0b20', fontFamily: M, fontSize: 9, color: '#f59e0b', textAlign: 'center' }}>
        Powered by Nano Banana + Gemini
      </div>
    </div>
  )
}

// ─── CO4. ContentOpsPipeline — Content Pipeline Detail ───
const CO_STAGES = [
  { name: 'Ideation', agent: 'IDEAS', result: '5 angles generated, 1 selected', time: '2m', status: 'done', color: '#f59e0b' },
  { name: 'Research', agent: 'RESEARCH', result: '8 sources found, 3 competitor analyses', time: '5m', status: 'done', color: '#06b6d4' },
  { name: 'Writing', agent: 'WRITER', result: '1,847 words, 3 sections', time: '12m', status: 'done', color: '#a855f7' },
  { name: 'Review', agent: 'REVIEW', result: 'Brand compliance: 96%, 3 suggestions', time: '', status: 'active', color: '#10b981' },
  { name: 'Publish', agent: 'REFINEMENT', result: 'Pending', time: '', status: 'pending', color: '#ec4899' },
]
const CO_FINDINGS = [
  { line: 23, issue: "'leverage' is a banned word", fix: "suggest 'use'" },
  { line: 45, issue: "Missing UK spelling", fix: "'organisation' not 'organization'" },
  { line: 78, issue: "Tone drift detected", fix: "Paragraph 3 is too informal" },
]

export function ContentOpsPipeline() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.08) * 0.3
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Q2 Product Update Blog Post</div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Content pipeline \u2014 5 stages</div>
      </div>

      {/* 5 Stage Pipeline (horizontal) */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {CO_STAGES.map((s, i) => {
          const isDone = s.status === 'done'
          const isActive = s.status === 'active'
          return (
            <div key={i} style={{ flex: 1, position: 'relative' }}>
              <GP style={{ padding: '8px 6px', borderTopColor: `${s.color}${isDone ? '30' : isActive ? '50' : '10'}`, opacity: s.status === 'pending' ? 0.4 : 1 }}>
                <div style={{ textAlign: 'center', marginBottom: 4 }}>
                  <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: isDone ? '#30ff90' : isActive ? s.color : 'rgba(255,255,255,0.3)' }}>
                    {isDone ? '\u2713' : isActive ? '\u25B6' : '\u25CB'}
                  </span>
                </div>
                <div style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff', textAlign: 'center', marginBottom: 2 }}>{s.name}</div>
                <div style={{ fontFamily: M, fontSize: 7, color: s.color, textAlign: 'center', marginBottom: 2 }}>{s.agent}</div>
                <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>{s.result}</div>
                {s.time && <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 2 }}>{s.time}</div>}
              </GP>
              {i < CO_STAGES.length - 1 && <div style={{ position: 'absolute', right: -4, top: '50%', transform: 'translateY(-50%)', fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.15)', zIndex: 2 }}>{'\u203A'}</div>}
            </div>
          )
        })}
      </div>

      {/* Review Findings */}
      <GP style={{ padding: 10, marginBottom: 10, borderTopColor: '#10b98120' }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>REVIEW FINDINGS</div>
        {CO_FINDINGS.map((finding, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
            <span style={{ fontFamily: M, fontSize: 8, color: '#f59e0b', minWidth: 35 }}>Line {finding.line}</span>
            <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{finding.issue}</span>
            <span style={{ fontFamily: M, fontSize: 8, color: '#10b981' }}>{'\u2192'} {finding.fix}</span>
          </div>
        ))}
        <div style={{ marginTop: 6, fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>Tone score: 94% (target: 90%)</div>
      </GP>

      {/* Approval + Cost */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ padding: '5px 14px', borderRadius: 6, background: '#10b98120', border: '1px solid #10b98130', fontFamily: M, fontSize: 9, color: '#10b981', fontWeight: 700, cursor: 'pointer' }}>Approve for Publication</div>
          <div style={{ padding: '5px 14px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>Request Changes</div>
        </div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>Cost: $0.23 (1,247 tokens)</div>
      </div>
    </div>
  )
}

// ─── CO5. ContentOpsVideo — VideoOps / MediaOps Suite ───
const CO_TEMPLATES = [
  { title: 'Product Demo', duration: '60s', scenes: 5, type: 'Remotion template', color: '#3b82f6' },
  { title: 'Social Clip', duration: '15s', scenes: 3, type: 'Motion graphics', color: '#ec4899' },
  { title: 'Release Notes', duration: '30s', scenes: 'auto', type: 'Auto from changelog', color: '#10b981' },
]

export function ContentOpsVideo() {
  const f = useAnimFrame()
  const renderProgress = lerp(f, 0, 40, 0, 60)
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>MediaOps \u2014 Define How You Move</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Video generation interface</div>
        </div>
        <div style={{ padding: '3px 10px', borderRadius: 6, background: '#ec489915', border: '1px solid #ec489930' }}>
          <span style={{ fontFamily: M, fontSize: 10, color: '#ec4899', fontWeight: 700 }}>$99-119/mo</span>
        </div>
      </div>

      {/* Template Gallery */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>TEMPLATE GALLERY</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {CO_TEMPLATES.map((t, i) => (
            <GP key={i} style={{ flex: 1, padding: 10, borderTopColor: `${t.color}30` }}>
              <div style={{ width: '100%', height: 50, borderRadius: 6, background: `linear-gradient(135deg, ${t.color}30 0%, ${t.color}10 100%)`, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${t.color}20` }}>
                <span style={{ fontSize: 18, opacity: 0.5 }}>{'\u25B6'}</span>
              </div>
              <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 2 }}>{t.title}</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{t.duration} \u2022 {typeof t.scenes === 'number' ? `${t.scenes} scenes` : t.scenes}</div>
              <div style={{ fontFamily: M, fontSize: 7, color: t.color, marginTop: 2 }}>{t.type}</div>
            </GP>
          ))}
        </div>
      </div>

      {/* Active Render */}
      <GP style={{ padding: 10, marginBottom: 10, borderTopColor: '#f59e0b30' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div>
            <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff' }}>Q2 Product Update</div>
            <div style={{ fontFamily: M, fontSize: 8, color: '#f59e0b' }}>Rendering Scene 3/5</div>
          </div>
          <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: '#f59e0b' }}>{Math.round(renderProgress)}%</span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
          <div style={{ width: `${renderProgress}%`, height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, #f59e0b, #ec4899)', transition: 'width 0.3s' }} />
        </div>
        <div style={{ marginTop: 6, fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>APOLLO agent: Compositing + rendering via Remotion</div>
      </GP>

      {/* Preview */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, height: 80, borderRadius: 8, background: 'linear-gradient(135deg, #1a1a2e 0%, #2d1b2e 50%, #0f3460 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>{'\u25B6'}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>OUTPUT PREVIEW</div>
          <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>1920x1080 \u2022 MP4</div>
          <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>60s estimated</div>
        </div>
      </div>

      <div style={{ padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
        Remotion (React video) \u2014 local rendering, no GPU required
      </div>
    </div>
  )
}

// ─── CO6. ContentOpsTeam — Content Team Topology ───
const CO_ALL_AGENTS = [
  { name: 'IDEAS', color: '#f59e0b', ring: 'inner', task: 'Brainstorming Q3 topics', state: 'active' },
  { name: 'RESEARCH', color: '#06b6d4', ring: 'inner', task: 'Competitor analysis', state: 'active' },
  { name: 'PLANNING', color: '#3b82f6', ring: 'inner', task: null, state: 'idle' },
  { name: 'WRITER', color: '#a855f7', ring: 'middle', task: 'Writing blog post', state: 'active' },
  { name: 'REVIEW', color: '#10b981', ring: 'middle', task: 'Reviewing draft', state: 'active' },
  { name: 'REFINEMENT', color: '#ec4899', ring: 'middle', task: null, state: 'idle' },
  { name: 'REPURPOSING', color: '#8b5cf6', ring: 'outer', task: null, state: 'idle' },
  { name: 'NANO BANANA', color: '#f59e0b', ring: 'outer', task: 'Generating hero image', state: 'active' },
  { name: 'APOLLO', color: '#ef4444', ring: 'outer', task: null, state: 'idle' },
]
const CO_FLOW = ['IDEAS', 'RESEARCH', 'PLANNING', 'WRITER', 'REVIEW', 'REFINEMENT', 'PUBLISH']

export function ContentOpsTeam() {
  const f = useAnimFrame()
  const cx = 180, cy = 130
  const rings = { inner: 55, middle: 90, outer: 120 }

  const agentPositions = CO_ALL_AGENTS.map((a, i) => {
    const ringAgents = CO_ALL_AGENTS.filter(x => x.ring === a.ring)
    const idx = ringAgents.indexOf(a)
    const r = rings[a.ring]
    const offset = a.ring === 'inner' ? -Math.PI / 3 : a.ring === 'middle' ? 0 : Math.PI / 6
    const angle = offset + (idx / ringAgents.length) * Math.PI * 2
    return { ...a, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
  })

  return (
    <div>
      <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 2 }}>Content Team Topology</div>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', marginBottom: 10 }}>11 agents \u2022 Star topology \u2022 VoiceOps Manager at centre</div>

      <div style={{ position: 'relative', width: 360, height: 260, margin: '0 auto' }}>
        <svg viewBox="0 0 360 260" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {/* Ring outlines */}
          {Object.values(rings).map((r, i) => (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
          ))}
          {/* Connection lines to centre */}
          {agentPositions.map((a, i) => (
            <line key={i} x1={cx} y1={cy} x2={a.x} y2={a.y} stroke={`${a.color}20`} strokeWidth="1" />
          ))}
          {/* Flow arrows along pipeline */}
          {CO_FLOW.slice(0, -1).map((name, i) => {
            const from = agentPositions.find(a => a.name === name)
            const toName = CO_FLOW[i + 1]
            const to = agentPositions.find(a => a.name === toName)
            if (!from || !to) return null
            return <line key={`flow-${i}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="4,4" />
          })}
        </svg>

        {/* Centre: VoiceOps Manager */}
        <div style={{ position: 'absolute', left: cx - 24, top: cy - 24, width: 48, height: 48, borderRadius: '50%', background: 'linear-gradient(135deg, #ec4899 0%, #f59e0b 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid rgba(255,255,255,0.2)', boxShadow: '0 0 20px rgba(236,72,153,0.3)' }}>
          <span style={{ fontFamily: M, fontSize: 8, fontWeight: 800, color: '#fff', textAlign: 'center', lineHeight: 1.1 }}>VOICE<br/>OPS</span>
        </div>

        {/* Agent nodes */}
        {agentPositions.map((a, i) => {
          const isActive = a.state === 'active'
          const pulse = isActive ? 0.8 + Math.sin(f * 0.06 + i) * 0.2 : 0.5
          return (
            <div key={i} style={{ position: 'absolute', left: a.x - 20, top: a.y - 12, width: 40, textAlign: 'center' }}>
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: `${a.color}${isActive ? '25' : '10'}`, border: `1.5px solid ${a.color}${isActive ? '60' : '20'}`, margin: '0 auto 2px', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: pulse }}>
                <span style={{ fontFamily: M, fontSize: 7, fontWeight: 700, color: a.color }}>{a.name.charAt(0)}</span>
              </div>
              <div style={{ fontFamily: M, fontSize: 6, color: isActive ? a.color : 'rgba(255,255,255,0.3)', fontWeight: 600 }}>{a.name}</div>
            </div>
          )
        })}
      </div>

      {/* Pipeline flow text */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 8 }}>
        {CO_FLOW.map((name, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.5)' }}>{name}</span>
            {i < CO_FLOW.length - 1 && <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.15)' }}>{'\u2192'}</span>}
          </span>
        ))}
      </div>

      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
        11 agents &nbsp;\u2502&nbsp; Star topology &nbsp;\u2502&nbsp; Avg pipeline: 25m &nbsp;\u2502&nbsp; Cost: $0.45/piece
      </div>
    </div>
  )
}

// ─── CO7. ContentOpsBundles — Bundle Pricing ───
const CO_BUNDLES = [
  {
    name: 'VoiceOps Studio', price: '$49', period: '/mo', color: '#a855f7', popular: false,
    features: ['Define your brand voice', '6 content agents', 'Writing pipeline', 'Review + compliance', 'UK/US English', 'Tone analysis'],
    agents: 6, tools: 12,
  },
  {
    name: 'ContentOps Studio', price: '$79', period: '/mo', color: '#ec4899', popular: true,
    features: ['Everything in VoiceOps', '8 content agents', 'Image generation', 'Brand asset library', 'Visual identity management', 'Multi-channel output'],
    agents: 8, tools: 18,
  },
  {
    name: 'MediaOps Studio', price: '$99-119', period: '/mo', color: '#f59e0b', popular: false,
    features: ['Everything in ContentOps', '11 content agents', 'Video generation (Remotion)', 'Full content factory', 'Automated repurposing', 'APOLLO video agent'],
    agents: 11, tools: 24,
  },
]

export function ContentOpsBundles() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 14 }}>
        <div style={{ fontFamily: F, fontSize: 16, fontWeight: 800, color: '#fff' }}>ContentOps Bundles</div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Branded content at every scale</div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {CO_BUNDLES.map((b, i) => {
          const op = lerp(f, i * 5, i * 5 + 12, 0, 1)
          return (
            <GP key={i} style={{ flex: 1, padding: 12, borderTopColor: `${b.color}40`, opacity: op, position: 'relative' }}>
              {b.popular && (
                <div style={{ position: 'absolute', top: -1, right: 12, padding: '2px 8px', borderRadius: '0 0 4px 4px', background: b.color, fontFamily: M, fontSize: 7, fontWeight: 700, color: '#fff' }}>POPULAR</div>
              )}
              <div style={{ textAlign: 'center', marginBottom: 10 }}>
                <div style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 2 }}>{b.name}</div>
                <div style={{ fontFamily: M, fontSize: 22, fontWeight: 800, color: b.color }}>{b.price}<span style={{ fontSize: 10, fontWeight: 400, color: 'rgba(255,255,255,0.4)' }}>{b.period}</span></div>
              </div>
              <div style={{ marginBottom: 10 }}>
                {b.features.map((feat, fi) => (
                  <div key={fi} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
                    <span style={{ fontFamily: M, fontSize: 8, color: '#10b981' }}>{'\u2713'}</span>
                    <span style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{feat}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{b.agents} agents</span>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{b.tools} tools</span>
              </div>
              <div style={{ padding: '6px 0', borderRadius: 6, background: b.popular ? `${b.color}20` : 'rgba(255,255,255,0.04)', border: `1px solid ${b.popular ? `${b.color}40` : 'rgba(255,255,255,0.08)'}`, textAlign: 'center', cursor: 'pointer' }}>
                <span style={{ fontFamily: M, fontSize: 10, color: b.popular ? b.color : 'rgba(255,255,255,0.6)', fontWeight: 700 }}>Start Free Trial</span>
              </div>
            </GP>
          )
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: '#10b981' }}>Save 40% vs individual plugins</div>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>All bundles include VOLT evidence trails for every generated asset</div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ACTION-Q — AI-Powered Personal Productivity System
// ═══════════════════════════════════════════════════════════════

// ─── AQ1. ActionQFullPage — Complete Reimagined Layout ───
const AQ_METRICS = [
  { label: 'Total', value: 23, color: '#38bdf8' },
  { label: 'Due Today', value: 3, color: '#f59e0b' },
  { label: 'Overdue', value: 2, color: '#ef4444' },
  { label: 'Streak', value: '7', color: '#f97316', icon: '\uD83D\uDD25' },
  { label: 'Delegated', value: 4, color: '#a855f7' },
  { label: 'AI Suggested', value: 3, color: '#06b6d4' },
]

const AQ_TODO = [
  { title: 'Respond to Q2 partnership proposal', priority: 'urgent', cat: 'business', due: 'Fri Mar 28', source: 'email', aiScore: 97, agent: null },
  { title: 'Review PR #47 — API auth refactor', priority: 'high', cat: 'technical', due: 'Today', source: 'ai', aiScore: 91, agent: 'VULCAN' },
  { title: 'Approve deployment to production', priority: 'high', cat: 'technical', due: 'Today', source: 'workflow', aiScore: 88, agent: null, blocked: true },
  { title: 'Q2 budget review and sign-off', priority: 'medium', cat: 'business', due: 'Thu Mar 27', source: 'calendar', aiScore: 72, agent: null },
  { title: 'Security audit — quarterly scan', priority: 'medium', cat: 'security', due: 'Mon Mar 31', source: 'ai', aiScore: 65, agent: 'WARDEN' },
  { title: 'Update DNS records for staging', priority: 'low', cat: 'technical', due: 'Apr 2', source: 'manual', aiScore: 41, agent: null },
  { title: 'Draft Q2 investor update', priority: 'medium', cat: 'business', due: 'Apr 4', source: 'ai', aiScore: 58, agent: null },
  { title: 'Clean up old feature branches', priority: 'low', cat: 'technical', due: 'Apr 7', source: 'manual', aiScore: 22, agent: null },
]

const AQ_PROGRESS = [
  { title: 'Pre-review PR #47', priority: 'high', cat: 'technical', due: 'Today', source: 'ai', agent: 'VULCAN', progress: 100 },
  { title: 'Research competitor pricing', priority: 'medium', cat: 'business', due: 'Tomorrow', source: 'ai', agent: 'Research-Q', progress: 23 },
  { title: 'Draft partnership reply', priority: 'urgent', cat: 'business', due: 'Fri', source: 'email', agent: 'Inbox-Q', progress: 67 },
  { title: 'Server health check — all hosts', priority: 'medium', cat: 'infra', due: 'Today', source: 'workflow', agent: 'WARDEN', progress: 45 },
]

const AQ_DONE = [
  { title: 'Morning standup notes', priority: 'low', cat: 'admin', completed: '9:15 AM' },
  { title: 'Merge feature/auth-revamp', priority: 'high', cat: 'technical', completed: 'Yesterday' },
  { title: 'Reply to board email', priority: 'high', cat: 'business', completed: 'Yesterday' },
  { title: 'Update monitoring dashboards', priority: 'medium', cat: 'technical', completed: 'Mon' },
  { title: 'Schedule team retro', priority: 'low', cat: 'admin', completed: 'Mon' },
  { title: 'Provision new staging server', priority: 'medium', cat: 'infra', completed: 'Sun' },
]

const AQX_PRI_COLORS = { urgent: '#ef4444', high: '#f59e0b', medium: '#3b82f6', low: 'rgba(255,255,255,0.25)' }
const AQX_SRC_ICONS = { email: '\u2709', ai: '\u2728', calendar: '\uD83D\uDCC5', workflow: '\u2699', manual: '\u270B', chat: '\uD83D\uDCAC' }
const AQX_CAT_COLORS = { business: '#f59e0b', technical: '#3b82f6', security: '#ef4444', infra: '#06b6d4', admin: '#8b5cf6' }

const AQMiniCard = ({ task, showAgent, showProgress }) => (
  <GP style={{ padding: '7px 10px', marginBottom: 4, borderLeftWidth: 3, borderLeftStyle: 'solid', borderLeftColor: AQX_PRI_COLORS[task.priority] || 'rgba(255,255,255,0.1)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff', marginBottom: 3, lineHeight: 1.3 }}>{task.title}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: M, fontSize: 7, padding: '1px 5px', borderRadius: 3, background: `${AQX_PRI_COLORS[task.priority]}18`, color: AQX_PRI_COLORS[task.priority], fontWeight: 700, textTransform: 'uppercase' }}>{task.priority}</span>
          {task.cat && <span style={{ fontFamily: M, fontSize: 7, color: AQX_CAT_COLORS[task.cat] || 'rgba(255,255,255,0.5)' }}>{task.cat}</span>}
          {task.due && <span style={{ fontFamily: M, fontSize: 7, color: task.due === 'Today' || task.due === 'Overdue' ? '#ef4444' : 'rgba(255,255,255,0.5)' }}>{task.due}</span>}
          {task.source && <span style={{ fontSize: 8, opacity: 0.6 }}>{AQX_SRC_ICONS[task.source] || '\u2022'}</span>}
          {task.blocked && <span style={{ fontFamily: M, fontSize: 7, color: '#ef4444', fontWeight: 700 }}>BLOCKED</span>}
        </div>
      </div>
      {showAgent && task.agent && (
        <div style={{ fontFamily: M, fontSize: 7, padding: '2px 6px', borderRadius: 4, background: 'rgba(168,85,247,0.12)', color: '#a855f7', fontWeight: 600, flexShrink: 0 }}>{task.agent}</div>
      )}
      {task.aiScore != null && (
        <div style={{ fontFamily: M, fontSize: 8, color: task.aiScore > 80 ? '#ef4444' : task.aiScore > 50 ? '#f59e0b' : '#3b82f6', fontWeight: 700, flexShrink: 0 }}>{task.aiScore}</div>
      )}
      {task.completed && (
        <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>{task.completed}</span>
      )}
    </div>
    {showProgress && task.progress != null && (
      <div style={{ marginTop: 4, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ width: `${task.progress}%`, height: '100%', borderRadius: 2, background: task.progress >= 100 ? '#10b981' : '#a855f7' }} />
      </div>
    )}
  </GP>
)

const AQ_CHAT = [
  { from: 'ai', text: "What's urgent today?" },
  { from: 'ai', text: '3 urgent items: partnership response (due Fri), PR review (overdue), deployment approval. Want me to draft the partnership reply?' },
  { from: 'user', text: 'Yes, draft it' },
  { from: 'ai', text: "Done \u2014 draft saved in Inbox-Q. I've also scheduled the PR review for after your 2pm meeting." },
]

export function ActionQFullPage() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 15, 0, 1)
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontFamily: F, fontSize: 16, fontWeight: 800, color: '#fff' }}>Action-Q</span>
        <span style={{ fontFamily: M, fontSize: 8, padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.15)', color: '#10b981', fontWeight: 600 }}>AI-POWERED</span>
        <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Personal productivity, reimagined</span>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {/* Left sidebar — Chat assistant */}
        <div style={{ width: 180, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <GP style={{ padding: 8, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px rgba(16,185,129,0.5)' }} />
              <span style={{ fontFamily: M, fontSize: 8, fontWeight: 700, color: '#10b981' }}>Action-Q Assistant</span>
            </div>
            {AQ_CHAT.map((m, i) => (
              <div key={i} style={{ marginBottom: 6, opacity: lerp(f, 5 + i * 4, 10 + i * 4, 0, 1) }}>
                <div style={{ fontFamily: M, fontSize: 7, color: m.from === 'ai' ? '#10b981' : '#38bdf8', marginBottom: 2, fontWeight: 600 }}>
                  {m.from === 'ai' ? 'Action-Q' : 'You'}
                </div>
                <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.8)', lineHeight: 1.4, padding: '4px 6px', borderRadius: 6, background: m.from === 'ai' ? 'rgba(16,185,129,0.06)' : 'rgba(56,189,248,0.06)', border: `1px solid ${m.from === 'ai' ? 'rgba(16,185,129,0.1)' : 'rgba(56,189,248,0.1)'}` }}>
                  {m.text}
                </div>
              </div>
            ))}
            <div style={{ marginTop: 'auto', padding: '5px 6px', borderRadius: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>Ask Action-Q...</div>
          </GP>
        </div>

        {/* Main area */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Metric pills */}
          <div style={{ display: 'flex', gap: 5, marginBottom: 8, flexWrap: 'wrap' }}>
            {AQ_METRICS.map((m, i) => (
              <GP key={i} style={{ padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4, borderTopColor: `${m.color}30` }}>
                {m.icon && <span style={{ fontSize: 10 }}>{m.icon}</span>}
                <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{m.label}:</span>
                <span style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: m.color }}>{m.value}</span>
              </GP>
            ))}
          </div>

          {/* Smart Kanban */}
          <div style={{ display: 'flex', gap: 6 }}>
            {/* TODO column */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: '#f59e0b', letterSpacing: 1 }}>TODO</span>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{AQ_TODO.length}</span>
                <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', marginLeft: 'auto' }}>AI sorted</span>
              </div>
              {AQ_TODO.map((t, i) => <AQMiniCard key={i} task={t} showAgent />)}
            </div>

            {/* IN PROGRESS column */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: '#a855f7', letterSpacing: 1 }}>IN PROGRESS</span>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{AQ_PROGRESS.length}</span>
              </div>
              {AQ_PROGRESS.map((t, i) => <AQMiniCard key={i} task={t} showAgent showProgress />)}
            </div>

            {/* DONE column */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: '#10b981', letterSpacing: 1 }}>DONE</span>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{AQ_DONE.length}</span>
                <span style={{ fontSize: 10, marginLeft: 2 }}>{'\u2728'}</span>
              </div>
              {AQ_DONE.map((t, i) => <AQMiniCard key={i} task={t} />)}
            </div>
          </div>
        </div>

        {/* Right sidebar — Context panel */}
        <div style={{ width: 160, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <GP style={{ padding: 8, borderTopColor: 'rgba(56,189,248,0.3)' }}>
            <div style={{ fontFamily: M, fontSize: 8, fontWeight: 700, color: '#38bdf8', marginBottom: 6, letterSpacing: 0.5 }}>TODAY'S FOCUS</div>
            <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5 }}>3 items flagged by Action-Q as high-impact for today</div>
          </GP>
          <GP style={{ padding: 8, borderTopColor: 'rgba(239,68,68,0.3)' }}>
            <div style={{ fontFamily: M, fontSize: 8, fontWeight: 700, color: '#ef4444', marginBottom: 6, letterSpacing: 0.5 }}>DEPENDENCIES</div>
            <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5 }}>PR review blocks deployment approval</div>
          </GP>
          <GP style={{ padding: 8, borderTopColor: 'rgba(245,158,11,0.3)' }}>
            <div style={{ fontFamily: M, fontSize: 8, fontWeight: 700, color: '#f59e0b', marginBottom: 6, letterSpacing: 0.5 }}>CALENDAR</div>
            <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5 }}>2pm meeting overlaps with review window</div>
          </GP>
          <GP style={{ padding: 8, borderTopColor: 'rgba(6,182,212,0.3)' }}>
            <div style={{ fontFamily: M, fontSize: 8, fontWeight: 700, color: '#06b6d4', marginBottom: 6, letterSpacing: 0.5 }}>AI SUGGESTION</div>
            <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5 }}>Move "Budget review" to Thursday \u2014 no meetings that day</div>
          </GP>
        </div>
      </div>
    </div>
  )
}

// ─── AQ2. ActionQSmartCard — Enhanced Task Card ───
export function ActionQSmartCard() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const subtasks = [
    { text: 'Review proposal', done: true },
    { text: 'Check financials', done: true },
    { text: 'Draft response', done: false },
  ]
  return (
    <div style={{ opacity: reveal, maxWidth: 420 }}>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>ENHANCED TASK CARD</div>
      <GP style={{ padding: 14, borderLeftWidth: 4, borderLeftStyle: 'solid', borderLeftColor: '#ef4444' }}>
        {/* Title */}
        <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 8, lineHeight: 1.3 }}>Respond to Q2 Partnership Proposal</div>

        {/* Row 1: Priority + Category + Due */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: M, fontSize: 8, padding: '2px 8px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: '#ef4444', fontWeight: 700 }}>URGENT</span>
          <span style={{ fontFamily: M, fontSize: 8, padding: '2px 8px', borderRadius: 4, background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>business</span>
          <span style={{ fontFamily: M, fontSize: 8, color: '#f59e0b', fontWeight: 600 }}>Due Fri Mar 28</span>
          <span style={{ fontFamily: M, fontSize: 8, padding: '2px 6px', borderRadius: 3, background: 'rgba(6,182,212,0.1)', color: '#06b6d4' }}>AI Score: 97</span>
        </div>

        {/* Row 2: Source */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 12 }}>{'\u2709'}</span>
          <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>Created by Inbox-Q from sarah@partner.com</span>
        </div>

        {/* Row 3: AI Insight */}
        <GP style={{ padding: '6px 10px', marginBottom: 8, borderTopColor: 'rgba(6,182,212,0.2)' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 11, flexShrink: 0 }}>{'\uD83D\uDCA1'}</span>
            <span style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4 }}>
              Similar to Q1 proposal \u2014 that one took 3 days. Suggested deadline: Mar 28. Template auto-loaded.
            </span>
          </div>
        </GP>

        {/* Row 4: Dependencies */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>Blocks:</span>
          <span style={{ fontFamily: M, fontSize: 8, color: '#38bdf8', textDecoration: 'underline', cursor: 'pointer' }}>"Schedule partner meeting"</span>
        </div>

        {/* Subtasks */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Subtasks: 2/3</div>
          {subtasks.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
              <span style={{ fontFamily: M, fontSize: 10, color: s.done ? '#10b981' : 'rgba(255,255,255,0.25)' }}>{s.done ? '\u2713' : '\u25CB'}</span>
              <span style={{ fontFamily: F, fontSize: 9, color: s.done ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.8)', textDecoration: s.done ? 'line-through' : 'none' }}>{s.text}</span>
            </div>
          ))}
        </div>

        {/* Time estimate + VOLT */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>Est. 45 min (AI analysis)</span>
          <span style={{ fontFamily: M, fontSize: 7, padding: '2px 6px', borderRadius: 3, background: 'rgba(99,102,241,0.12)', color: '#6366f1', fontWeight: 600 }}>VOLT tracked</span>
        </div>

        {/* Actions row */}
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { label: '\u25B6 Start', color: '#10b981' },
            { label: '\uD83D\uDCCB Delegate to VULCAN', color: '#a855f7' },
            { label: '\uD83D\uDCC5 Reschedule', color: '#f59e0b' },
            { label: '\u2713 Complete', color: '#38bdf8' },
          ].map((a, i) => (
            <div key={i} style={{ flex: 1, padding: '5px 0', borderRadius: 6, background: `${a.color}08`, border: `1px solid ${a.color}20`, textAlign: 'center', cursor: 'pointer', fontFamily: M, fontSize: 8, color: a.color, fontWeight: 600 }}>
              {a.label}
            </div>
          ))}
        </div>
      </GP>
    </div>
  )
}

// ─── AQ3. ActionQAssistant — The Sidebar Chat ───
const AQ_ASSISTANT_MSGS = [
  { from: 'ai', text: 'Good morning. You have 3 urgent items today and 2 overdue. Your first meeting is at 9am.' },
  { from: 'user', text: 'What should I tackle first?' },
  { from: 'ai', text: "I recommend the partnership response \u2014 it's been waiting 2 days and Sarah followed up yesterday. I've prepared a draft based on the Q1 template. Second priority: the PR review (blocking deployment). The deployment can wait until after your review." },
  { from: 'user', text: 'Draft looks good, send it' },
  { from: 'ai', text: "Sent via Inbox-Q. I've also:\n\u2713 Created follow-up task for Monday\n\u2713 Added meeting invite for next week\n\u2713 Updated the pipeline in ContentOps" },
  { from: 'ai', text: 'Next: PR #47 review. VULCAN has already pre-reviewed and flagged 2 concerns. Want me to open it?' },
]

export function ActionQAssistant() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 10, 0, 1)
  return (
    <div style={{ opacity: reveal, maxWidth: 340 }}>
      <GP style={{ padding: 12 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, #10b981 0%, #06b6d4 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: M, fontSize: 9, fontWeight: 800, color: '#fff' }}>AQ</span>
          </div>
          <div>
            <div style={{ fontFamily: F, fontSize: 12, fontWeight: 700, color: '#fff' }}>Action-Q Assistant</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px rgba(16,185,129,0.6)' }} />
              <span style={{ fontFamily: M, fontSize: 7, color: '#10b981' }}>Online</span>
            </div>
          </div>
        </div>

        {/* Messages */}
        {AQ_ASSISTANT_MSGS.map((m, i) => {
          const isAI = m.from === 'ai'
          const op = lerp(f, 4 + i * 5, 10 + i * 5, 0, 1)
          return (
            <div key={i} style={{ marginBottom: 10, opacity: op, display: 'flex', flexDirection: 'column', alignItems: isAI ? 'flex-start' : 'flex-end' }}>
              <div style={{ fontFamily: M, fontSize: 7, color: isAI ? '#10b981' : '#38bdf8', marginBottom: 2, fontWeight: 600, paddingLeft: isAI ? 0 : 0 }}>
                {isAI ? 'Action-Q' : 'Adam'}
              </div>
              <div style={{
                maxWidth: '90%', padding: '8px 10px', borderRadius: isAI ? '2px 10px 10px 10px' : '10px 2px 10px 10px',
                background: isAI ? 'rgba(16,185,129,0.06)' : 'rgba(56,189,248,0.06)',
                border: `1px solid ${isAI ? 'rgba(16,185,129,0.12)' : 'rgba(56,189,248,0.12)'}`,
                fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.85)', lineHeight: 1.5, whiteSpace: 'pre-line'
              }}>
                {m.text}
              </div>
            </div>
          )
        })}

        {/* Input */}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <div style={{ flex: 1, padding: '6px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>Ask Action-Q...</div>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <span style={{ fontFamily: M, fontSize: 12, color: '#10b981' }}>{'\u2191'}</span>
          </div>
        </div>

        {/* Capabilities */}
        <div style={{ marginTop: 10, padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>I can:</div>
          <div style={{ fontFamily: F, fontSize: 8, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
            Add tasks \u2022 Prioritise \u2022 Delegate \u2022 Check email \u2022 Schedule meetings \u2022 Draft replies \u2022 Track dependencies
          </div>
        </div>
      </GP>
    </div>
  )
}

// ─── AQ4. ActionQPriorityMatrix — Eisenhower Matrix ───
const AQ_MATRIX = {
  do_first: { label: 'DO FIRST', subtitle: 'Urgent + Important', color: '#ef4444', items: ['Partnership response', 'PR #47 review'] },
  schedule: { label: 'SCHEDULE', subtitle: 'Important + Not Urgent', color: '#3b82f6', items: ['Q2 report', 'Security audit', 'Budget review'] },
  delegate: { label: 'DELEGATE', subtitle: 'Urgent + Not Important', color: '#f59e0b', items: ['Server monitoring setup', 'Update DNS records'] },
  eliminate: { label: 'ELIMINATE', subtitle: 'Not Urgent + Not Important', color: 'rgba(255,255,255,0.3)', items: ['Clean up old branches', 'Update documentation'] },
}

export function ActionQPriorityMatrix() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const entries = Object.entries(AQ_MATRIX)
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Priority Matrix</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>AI-powered Eisenhower classification</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ fontFamily: M, fontSize: 8, padding: '3px 8px', borderRadius: 4, background: 'rgba(6,182,212,0.12)', color: '#06b6d4', fontWeight: 600 }}>Confidence: 89%</span>
          <span style={{ fontFamily: M, fontSize: 8, padding: '3px 8px', borderRadius: 4, background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}>3 reclassified</span>
        </div>
      </div>

      {/* Axis labels */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
        <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', letterSpacing: 2 }}>URGENT {'\u2190'} {'\u2192'} NOT URGENT</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {entries.map(([key, q], i) => {
          const op = lerp(f, 4 + i * 3, 12 + i * 3, 0, 1)
          return (
            <GP key={key} style={{ padding: 10, borderTopColor: `${q.color}30`, opacity: op }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div>
                  <div style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: q.color, letterSpacing: 1 }}>{q.label}</div>
                  <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>{q.subtitle}</div>
                </div>
                <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: q.color }}>{q.items.length}</span>
              </div>
              {q.items.map((item, j) => (
                <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
                  <div style={{ width: 4, height: 4, borderRadius: '50%', background: q.color, opacity: 0.7 }} />
                  <span style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.75)' }}>{item}</span>
                </div>
              ))}
              <div style={{ marginTop: 6, padding: '3px 0', borderRadius: 4, border: `1px dashed ${typeof q.color === 'string' && q.color.startsWith('#') ? q.color + '20' : 'rgba(255,255,255,0.06)'}`, textAlign: 'center', fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.25)' }}>
                Drop tasks here
              </div>
            </GP>
          )
        })}
      </div>

      {/* Axis label left */}
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 4 }}>
        <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', letterSpacing: 2 }}>IMPORTANT {'\u2191'} / NOT IMPORTANT {'\u2193'}</span>
      </div>
    </div>
  )
}

// ─── AQ5. ActionQDependencyGraph — Task Dependencies ───
const AQ_DEP_NODES = [
  { id: 'pr', label: 'Review PR #47', x: 60, y: 40, status: 'progress', agent: 'VULCAN', color: '#f59e0b' },
  { id: 'deploy', label: 'Approve deployment', x: 220, y: 40, status: 'blocked', agent: null, color: '#ef4444' },
  { id: 'monitor', label: 'Monitor rollout', x: 380, y: 40, status: 'waiting', agent: 'WARDEN', color: '#3b82f6' },
  { id: 'draft', label: 'Draft partnership reply', x: 60, y: 130, status: 'progress', agent: 'Inbox-Q', color: '#a855f7' },
  { id: 'send', label: 'Send reply', x: 220, y: 130, status: 'waiting', agent: null, color: '#3b82f6' },
  { id: 'schedule', label: 'Schedule follow-up', x: 380, y: 130, status: 'waiting', agent: null, color: '#3b82f6' },
  { id: 'audit', label: 'Security audit', x: 60, y: 220, status: 'todo', agent: 'WARDEN', color: '#06b6d4' },
  { id: 'budget', label: 'Budget review', x: 260, y: 220, status: 'todo', agent: null, color: '#06b6d4' },
]
const AQ_DEP_EDGES = [
  { from: 'pr', to: 'deploy', critical: true },
  { from: 'deploy', to: 'monitor', critical: true },
  { from: 'draft', to: 'send', critical: false },
  { from: 'send', to: 'schedule', critical: false },
]
const AQ_DEP_STATUS = { progress: '#f59e0b', blocked: '#ef4444', waiting: 'rgba(255,255,255,0.3)', todo: '#3b82f6' }

export function ActionQDependencyGraph() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const pulse = 0.6 + Math.sin(f * 0.06) * 0.3
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Dependency Graph</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>8 tasks \u2022 4 dependency links \u2022 1 blocked</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ fontFamily: M, fontSize: 8, padding: '3px 8px', borderRadius: 4, background: 'rgba(6,182,212,0.12)', color: '#06b6d4' }}>Critical path: 3 tasks, est. 2h 15m</span>
        </div>
      </div>

      <GP style={{ padding: 12 }}>
        <svg viewBox="0 0 480 260" style={{ width: '100%', height: 260 }}>
          {/* Edges */}
          {AQ_DEP_EDGES.map((e, i) => {
            const from = AQ_DEP_NODES.find(n => n.id === e.from)
            const to = AQ_DEP_NODES.find(n => n.id === e.to)
            if (!from || !to) return null
            return (
              <line key={i} x1={from.x + 65} y1={from.y + 18} x2={to.x - 5} y2={to.y + 18}
                stroke={e.critical ? '#06b6d4' : 'rgba(255,255,255,0.1)'}
                strokeWidth={e.critical ? 2 : 1}
                opacity={e.critical ? pulse : 0.5}
                markerEnd="url(#aqarrow)" />
            )
          })}
          <defs>
            <marker id="aqarrow" viewBox="0 0 10 7" refX="9" refY="3.5" markerWidth="8" markerHeight="6" orient="auto">
              <polygon points="0 0, 10 3.5, 0 7" fill="rgba(255,255,255,0.4)" />
            </marker>
          </defs>

          {/* Nodes */}
          {AQ_DEP_NODES.map((n, i) => {
            const op = lerp(f, 3 + i * 2, 10 + i * 2, 0, 1)
            const statusColor = AQ_DEP_STATUS[n.status] || '#fff'
            const isBlocked = n.status === 'blocked'
            return (
              <g key={n.id} opacity={op}>
                <rect x={n.x} y={n.y} width={130} height={36} rx={6}
                  fill="rgba(255,255,255,0.03)"
                  stroke={isBlocked ? '#ef4444' : 'rgba(255,255,255,0.08)'}
                  strokeWidth={isBlocked ? 1.5 : 0.5}
                  strokeDasharray={isBlocked ? '4,2' : 'none'} />
                <circle cx={n.x + 10} cy={n.y + 14} r={4} fill={statusColor} opacity={n.status === 'progress' ? pulse : 0.7} />
                <text x={n.x + 20} y={n.y + 17} fontFamily={F} fontSize={8} fontWeight={600} fill="#fff">{n.label}</text>
                {n.agent && <text x={n.x + 10} y={n.y + 30} fontFamily={M} fontSize={7} fill="#a855f7">{n.agent}</text>}
                {!n.agent && n.status !== 'blocked' && <text x={n.x + 10} y={n.y + 30} fontFamily={M} fontSize={7} fill="rgba(255,255,255,0.3)">unassigned</text>}
                {isBlocked && <text x={n.x + 90} y={n.y + 30} fontFamily={M} fontSize={7} fill="#ef4444" fontWeight={700}>BLOCKED</text>}
              </g>
            )
          })}
        </svg>
      </GP>

      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        {Object.entries(AQ_DEP_STATUS).map(([k, c]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: c, opacity: 0.7 }} />
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', textTransform: 'capitalize' }}>{k}</span>
          </div>
        ))}
        <span style={{ fontFamily: M, fontSize: 8, color: '#ef4444', marginLeft: 'auto' }}>1 task blocked \u2014 waiting on "Review PR #47"</span>
      </div>
    </div>
  )
}

// ─── AQ6. ActionQAnalytics — Productivity Analytics ───
const AQ_ANALYTICS_METRICS = [
  { label: 'Tasks/week', value: '23', trend: '\u2191 12%', color: '#38bdf8' },
  { label: 'Completion rate', value: '89%', trend: '\u2191 3%', color: '#10b981' },
  { label: 'Avg time to done', value: '1.8d', trend: '\u2193 0.4d', color: '#a855f7' },
  { label: 'Streak', value: '7 days', trend: '\uD83D\uDD25', color: '#f97316' },
]

const AQ_HEATMAP_DATA = (() => {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const data = []
  for (let d = 0; d < 7; d++) {
    for (let h = 6; h < 22; h++) {
      let v = 0
      if (h >= 9 && h <= 17 && d < 5) v = Math.random() * 0.6 + 0.2
      if (h >= 14 && h <= 16 && d < 5) v = Math.random() * 0.3 + 0.7
      if (d === 1 && h >= 10 && h <= 16) v = Math.random() * 0.2 + 0.8
      if (d >= 5) v = Math.random() * 0.15
      data.push({ day: days[d], hour: h, value: v })
    }
  }
  return data
})()

const AQ_CATEGORIES = [
  { label: 'Business', pct: 35, color: '#f59e0b' },
  { label: 'Technical', pct: 28, color: '#3b82f6' },
  { label: 'Legal', pct: 15, color: '#ef4444' },
  { label: 'Admin', pct: 12, color: '#8b5cf6' },
  { label: 'Personal', pct: 10, color: '#06b6d4' },
]

const AQ_WEEKS = [
  { label: 'W1', value: 18 },
  { label: 'W2', value: 21 },
  { label: 'W3', value: 19 },
  { label: 'W4', value: 23 },
]

export function ActionQAnalytics() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const maxWeek = Math.max(...AQ_WEEKS.map(w => w.value))

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 2 }}>Productivity Analytics</div>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', marginBottom: 10 }}>Personal insights powered by Action-Q</div>

      {/* Top metrics */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {AQ_ANALYTICS_METRICS.map((m, i) => (
          <GP key={i} style={{ flex: 1, padding: '8px 10px', borderTopColor: `${m.color}30` }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginBottom: 2 }}>{m.label}</div>
            <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: m.color }}>{m.value}</div>
            <div style={{ fontFamily: M, fontSize: 8, color: '#10b981' }}>{m.trend}</div>
          </GP>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {/* Heatmap */}
        <GP style={{ flex: 2, padding: 10 }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginBottom: 6, letterSpacing: 0.5 }}>PRODUCTIVITY HEATMAP</div>
          <div style={{ display: 'flex', gap: 1 }}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, di) => (
              <div key={day} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <div style={{ fontFamily: M, fontSize: 6, color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginBottom: 2 }}>{day}</div>
                {Array.from({ length: 16 }, (_, hi) => {
                  const d = AQ_HEATMAP_DATA.find(x => x.day === day && x.hour === hi + 6)
                  const v = d ? d.value : 0
                  return (
                    <div key={hi} style={{ height: 7, borderRadius: 1, background: v > 0.6 ? `rgba(16,185,129,${0.3 + v * 0.7})` : v > 0.2 ? `rgba(56,189,248,${0.1 + v * 0.5})` : 'rgba(255,255,255,0.02)' }} />
                  )
                })}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ fontFamily: M, fontSize: 6, color: 'rgba(255,255,255,0.3)' }}>6am</span>
            <span style={{ fontFamily: M, fontSize: 6, color: 'rgba(255,255,255,0.3)' }}>10pm</span>
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 10 }}>
            <span style={{ fontFamily: M, fontSize: 8, color: '#10b981' }}>Best day: Tuesday \u2014 avg 5.2 tasks</span>
            <span style={{ fontFamily: M, fontSize: 8, color: '#38bdf8' }}>Best time: 2pm\u20134pm (34%)</span>
          </div>
        </GP>

        {/* Right column: Donut + Bars */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Category donut */}
          <GP style={{ padding: 10 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginBottom: 6, letterSpacing: 0.5 }}>CATEGORY BREAKDOWN</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg viewBox="0 0 80 80" style={{ width: 70, height: 70, flexShrink: 0 }}>
                {(() => {
                  let offset = 0
                  return AQ_CATEGORIES.map((cat, i) => {
                    const pct = cat.pct / 100
                    const circumference = Math.PI * 60
                    const dash = pct * circumference
                    const gap = circumference - dash
                    const rotation = offset * 360 - 90
                    offset += pct
                    const barReveal = lerp(f, 8 + i * 3, 18 + i * 3, 0, 1)
                    return <circle key={i} cx={40} cy={40} r={30} fill="none" stroke={cat.color} strokeWidth={8}
                      strokeDasharray={`${dash * barReveal} ${gap + dash * (1 - barReveal)}`}
                      transform={`rotate(${rotation} 40 40)`} opacity={0.8} />
                  })
                })()}
                <circle cx={40} cy={40} r={22} fill="rgba(0,0,0,0.3)" />
                <text x={40} y={43} textAnchor="middle" fontFamily={M} fontSize={10} fontWeight={700} fill="#fff">89%</text>
              </svg>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {AQ_CATEGORIES.map((cat, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ width: 6, height: 6, borderRadius: 1, background: cat.color, opacity: 0.8 }} />
                    <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.6)' }}>{cat.label} {cat.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          </GP>

          {/* Week comparison */}
          <GP style={{ padding: 10 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginBottom: 6, letterSpacing: 0.5 }}>WEEK OVER WEEK</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 50 }}>
              {AQ_WEEKS.map((w, i) => {
                const h = lerp(f, 6 + i * 3, 16 + i * 3, 0, (w.value / maxWeek) * 50)
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <span style={{ fontFamily: M, fontSize: 7, color: '#38bdf8' }}>{w.value}</span>
                    <div style={{ width: '100%', height: h, borderRadius: 3, background: i === AQ_WEEKS.length - 1 ? 'linear-gradient(180deg, #38bdf8, #a855f7)' : 'rgba(56,189,248,0.25)' }} />
                    <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>{w.label}</span>
                  </div>
                )
              })}
            </div>
          </GP>
        </div>
      </div>

      {/* AI insight */}
      <GP style={{ padding: '8px 12px', marginTop: 8, borderTopColor: 'rgba(6,182,212,0.2)' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12 }}>{'\uD83D\uDCA1'}</span>
          <span style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>
            You're 23% more productive after your morning standup. Consider scheduling deep work 10am\u201312pm.
          </span>
        </div>
      </GP>
    </div>
  )
}

// ─── AQ7. ActionQDelegation — Agent Delegation Panel ───
const AQ_DELEGATED = [
  { title: 'Draft partnership reply', agent: 'Inbox-Q', agentColor: '#10b981', state: 'writing', progress: 67, activity: 'Composing response using Q1 template' },
  { title: 'Pre-review PR #47', agent: 'VULCAN', agentColor: '#a855f7', state: 'reading', progress: 100, activity: 'Complete \u2014 2 concerns flagged' },
  { title: 'Check server health', agent: 'WARDEN', agentColor: '#ef4444', state: 'executing', progress: 45, activity: 'Scanning edge-01-04' },
  { title: 'Research competitor pricing', agent: 'Research-Q', agentColor: '#06b6d4', state: 'researching', progress: 23, activity: 'Analysing 5 competitors' },
]

const AQ_STATE_COLORS = { writing: '#10b981', reading: '#a855f7', executing: '#f59e0b', researching: '#06b6d4' }

export function ActionQDelegation() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Delegated Tasks</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>4 active \u2022 847 tokens used \u2022 2 auto-delegated</div>
        </div>
        <span style={{ fontFamily: M, fontSize: 8, padding: '3px 8px', borderRadius: 4, background: 'rgba(168,85,247,0.12)', color: '#a855f7' }}>Action-Q auto-delegated 2 tasks</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {AQ_DELEGATED.map((d, i) => {
          const op = lerp(f, 4 + i * 3, 12 + i * 3, 0, 1)
          const barW = lerp(f, 8 + i * 3, 20 + i * 3, 0, d.progress)
          const stateColor = AQ_STATE_COLORS[d.state] || '#fff'
          const isComplete = d.progress >= 100
          const pulse = isComplete ? 1 : 0.6 + Math.sin(f * 0.08 + i) * 0.3
          return (
            <GP key={i} style={{ padding: '10px 12px', opacity: op, borderTopColor: `${d.agentColor}20` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 3 }}>{d.title}</div>
                  <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{d.activity}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {/* Agent badge */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ width: 20, height: 20, borderRadius: '50%', background: `${d.agentColor}15`, border: `1.5px solid ${d.agentColor}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: pulse }}>
                      <span style={{ fontFamily: M, fontSize: 6, fontWeight: 800, color: d.agentColor }}>{d.agent.charAt(0)}</span>
                    </div>
                    <span style={{ fontFamily: M, fontSize: 8, fontWeight: 600, color: d.agentColor }}>{d.agent}</span>
                  </div>
                  {/* State */}
                  <span style={{ fontFamily: M, fontSize: 7, padding: '2px 6px', borderRadius: 3, background: `${stateColor}12`, color: stateColor }}>{d.state}</span>
                </div>
              </div>
              {/* Progress bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div style={{ width: `${barW}%`, height: '100%', borderRadius: 2, background: isComplete ? '#10b981' : `linear-gradient(90deg, ${d.agentColor}, ${stateColor})`, transition: 'width 0.3s' }} />
                </div>
                <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: isComplete ? '#10b981' : d.agentColor, minWidth: 30, textAlign: 'right' }}>{Math.round(barW)}%</span>
              </div>
              {/* Quick actions */}
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                {(isComplete ? ['View Output', 'Approve'] : ['Recall', 'Pause', 'View Output']).map((action, ai) => (
                  <span key={ai} style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>{action}</span>
                ))}
              </div>
            </GP>
          )
        })}
      </div>

      {/* Token usage */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Total: 847 tokens across 4 delegations</span>
        <span style={{ fontFamily: M, fontSize: 8, color: '#10b981' }}>2 of 4 complete</span>
      </div>
    </div>
  )
}

// ─── AQ8. ActionQIntegrations — Connected Sources ───
const AQ_SOURCES = [
  { icon: '\u2709', name: 'Email (Inbox-Q)', count: 12, desc: 'tasks from emails this week', auto: 'auto-triage ON', sync: '2m ago', color: '#38bdf8' },
  { icon: '\uD83D\uDCC5', name: 'Calendar (Calendar-Q)', count: 3, desc: 'tasks from meeting action items', auto: 'auto-extract ON', sync: '5m ago', color: '#10b981' },
  { icon: '\uD83D\uDCAC', name: 'Chat (CommanderQ)', count: 8, desc: 'tasks from conversation', auto: 'auto-capture ON', sync: 'live', color: '#a855f7' },
  { icon: '\u2699', name: 'Workflows (QuoxFlow)', count: 2, desc: 'tasks from workflow checkpoints', auto: 'auto-create ON', sync: '10m ago', color: '#f59e0b' },
  { icon: '\u2728', name: 'AI Suggestions', count: 5, desc: 'tasks suggested by Action-Q', auto: '3 accepted', sync: 'continuous', color: '#06b6d4' },
  { icon: '\u270B', name: 'Manual', count: 4, desc: 'tasks added manually', auto: '\u2014', sync: '\u2014', color: 'rgba(255,255,255,0.5)' },
]

export function ActionQIntegrations() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const totalTasks = AQ_SOURCES.reduce((s, x) => s + x.count, 0)
  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Task Sources</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Where tasks come from \u2022 {totalTasks} tasks this week from {AQ_SOURCES.length} sources</div>
        </div>
        <span style={{ fontFamily: M, fontSize: 8, padding: '3px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.12)', color: '#10b981', fontWeight: 600 }}>All connected {'\u2713'}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {AQ_SOURCES.map((s, i) => {
          const op = lerp(f, 3 + i * 2, 10 + i * 2, 0, 1)
          const barW = lerp(f, 6 + i * 2, 16 + i * 2, 0, (s.count / 12) * 100)
          return (
            <GP key={i} style={{ padding: '8px 12px', opacity: op, borderTopColor: `${s.color}20` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* Source icon */}
                <div style={{ width: 28, height: 28, borderRadius: 6, background: `${s.color}10`, border: `1px solid ${s.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: 14 }}>{s.icon}</span>
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff' }}>{s.name}</span>
                    <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: s.color }}>{s.count}</span>
                  </div>
                  <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginBottom: 3 }}>{s.desc}</div>
                  {/* Progress bar */}
                  <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.04)', overflow: 'hidden', marginBottom: 3 }}>
                    <div style={{ width: `${barW}%`, height: '100%', borderRadius: 2, background: s.color, opacity: 0.6 }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: M, fontSize: 7, color: s.color }}>{s.auto}</span>
                    <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.35)' }}>Sync: {s.sync}</span>
                  </div>
                </div>
              </div>
            </GP>
          )
        })}
      </div>

      {/* Footer */}
      <GP style={{ padding: '6px 10px', marginTop: 8, borderTopColor: 'rgba(6,182,212,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{totalTasks} tasks total this week from {AQ_SOURCES.length} sources</span>
          <span style={{ fontFamily: M, fontSize: 8, color: '#06b6d4' }}>AI suggestion acceptance: 78%</span>
        </div>
      </GP>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ORGANISATION, DIVISION & DEPARTMENT — REIMAGINED GLASS PAGES
// ═══════════════════════════════════════════════════════════════

// ─── Shared org data ───
const ORG_TREE_DATA = {
  name: 'Quox LTD', type: 'org', industry: 'AI/SaaS', founded: '2025', status: 'Active',
  children: [
    { name: 'Engineering', type: 'division', members: 23, health: 'green', children: [
      { name: 'Platform', type: 'dept', teams: 3, members: 8, health: 'green', children: [
        { name: 'Alpha', type: 'team', members: 3 }, { name: 'Beta', type: 'team', members: 3 }, { name: 'Core', type: 'team', members: 2 }
      ]},
      { name: 'Security', type: 'dept', teams: 2, members: 6, health: 'green', children: [
        { name: 'AppSec', type: 'team', members: 3 }, { name: 'InfraSec', type: 'team', members: 3 }
      ]},
      { name: 'DevOps', type: 'dept', teams: 2, members: 5, health: 'amber', children: [
        { name: 'CI/CD', type: 'team', members: 3 }, { name: 'SRE', type: 'team', members: 2 }
      ]},
      { name: 'QA', type: 'dept', teams: 1, members: 4, health: 'green', children: [
        { name: 'Automation', type: 'team', members: 4 }
      ]},
    ]},
    { name: 'Operations', type: 'division', members: 14, health: 'green', children: [
      { name: 'Infrastructure', type: 'dept', teams: 2, members: 5, health: 'green', children: [
        { name: 'Network', type: 'team', members: 3 }, { name: 'Storage', type: 'team', members: 2 }
      ]},
      { name: 'Support', type: 'dept', teams: 2, members: 5, health: 'green', children: [
        { name: 'L1', type: 'team', members: 3 }, { name: 'L2', type: 'team', members: 2 }
      ]},
      { name: 'Monitoring', type: 'dept', teams: 1, members: 4, health: 'green', children: [
        { name: 'Observability', type: 'team', members: 4 }
      ]},
    ]},
    { name: 'Business', type: 'division', members: 10, health: 'green', children: [
      { name: 'Sales', type: 'dept', teams: 2, members: 5, health: 'green', children: [
        { name: 'Enterprise', type: 'team', members: 3 }, { name: 'SMB', type: 'team', members: 2 }
      ]},
      { name: 'Marketing', type: 'dept', teams: 1, members: 5, health: 'green', children: [
        { name: 'Growth', type: 'team', members: 5 }
      ]},
    ]},
  ]
}

const ORG_ACTIVITY_DATA = [
  { actor: 'Adam', action: 'created Security department', target: 'Engineering', time: '2h ago', type: 'people', avatar: 'AC' },
  { actor: 'WARDEN', action: 'completed infrastructure scan', target: 'Operations', time: '3h ago', type: 'agent', avatar: 'SN' },
  { actor: 'Sarah', action: 'joined DevOps department', target: 'Engineering', time: 'yesterday', type: 'people', avatar: 'SW' },
  { actor: 'VULCAN', action: 'deployed v2.4.1 to production', target: 'Platform', time: 'yesterday', type: 'agent', avatar: 'FG' },
  { actor: 'QA team', action: 'flagged 3 regressions in Sprint 14', target: 'Engineering', time: '2 days ago', type: 'objective', avatar: 'QA' },
]

const ORG_MEMBERS_DATA = [
  { name: 'Adam Clarke', role: 'Owner', dept: 'Engineering', initials: 'AC', color: '#f59e0b', online: true, lastActive: 'Now' },
  { name: 'Sarah Wu', role: 'Admin', dept: 'Engineering', initials: 'SW', color: '#a855f7', online: true, lastActive: 'Now' },
  { name: 'Alex Chen', role: 'Admin', dept: 'Engineering', initials: 'AX', color: '#a855f7', online: true, lastActive: 'Now' },
  { name: 'James Riley', role: 'Member', dept: 'Operations', initials: 'JR', color: '#3b82f6', online: true, lastActive: 'Now' },
  { name: 'Emily Zhang', role: 'Member', dept: 'Engineering', initials: 'EZ', color: '#3b82f6', online: false, lastActive: '1h ago' },
  { name: 'Marcus Cole', role: 'Member', dept: 'DevOps', initials: 'MC', color: '#3b82f6', online: false, lastActive: '2h ago' },
  { name: 'Priya Patel', role: 'Member', dept: 'Security', initials: 'PP', color: '#3b82f6', online: false, lastActive: '3h ago' },
  { name: 'Tom Baker', role: 'Member', dept: 'Business', initials: 'TB', color: '#3b82f6', online: false, lastActive: '4h ago' },
  { name: 'Lisa Park', role: 'Member', dept: 'Marketing', initials: 'LP', color: '#3b82f6', online: false, lastActive: 'yesterday' },
  { name: 'David Okonkwo', role: 'Viewer', dept: 'Sales', initials: 'DO', color: 'rgba(255,255,255,0.4)', online: false, lastActive: 'yesterday' },
  { name: 'Nina Volkov', role: 'Member', dept: 'QA', initials: 'NV', color: '#3b82f6', online: false, lastActive: '2 days ago' },
  { name: 'Chris Tanaka', role: 'Viewer', dept: 'Operations', initials: 'CT', color: 'rgba(255,255,255,0.4)', online: false, lastActive: '3 days ago' },
]

const ORG_WEEKLY_OBJECTIVES = [32, 28, 41, 37, 45, 39, 52, 48]

const ROLE_COLORS = { Owner: '#f59e0b', Admin: '#a855f7', Member: '#3b82f6', Viewer: 'rgba(255,255,255,0.4)', Agent: '#10b981' }

// ═══════════════════════════════════════════════════════════════
// 1. OrgFullPage — Complete Reimagined Org Page
// ═══════════════════════════════════════════════════════════════
export function OrgFullPage() {
  const f = useAnimFrame()
  const [selectedNode, setSelectedNode] = useState('Quox LTD')
  const [expandedNodes, setExpandedNodes] = useState({ 'Quox LTD': true, Engineering: true, Operations: false, Business: false })
  const reveal = lerp(f, 0, 15, 0, 1)

  const toggleExpand = (name) => setExpandedNodes(prev => ({ ...prev, [name]: !prev[name] }))

  const metrics = [
    { label: 'Divisions', value: '3', color: '#a855f7' },
    { label: 'Departments', value: '9', color: '#3b82f6' },
    { label: 'Teams', value: '14', color: '#06b6d4' },
    { label: 'Members', value: '47', color: '#10b981' },
    { label: 'AI Agents', value: '16', color: '#f59e0b' },
    { label: 'Token Spend', value: '$127/mo', color: '#ec4899' },
  ]

  const quickActions = ['Create Division', 'Invite Member', 'View Audit Log', 'Export Org Chart']
  const qaIcons = ['+', '\u2709', '\u2630', '\u2B07']

  // Render tree recursively
  const renderTreeNode = (node, depth = 0, isLast = false) => {
    const isExpanded = expandedNodes[node.name]
    const hasChildren = node.children && node.children.length > 0
    const isSelected = selectedNode === node.name
    const typeColors = { org: '#a855f7', division: '#3b82f6', dept: '#06b6d4', team: '#10b981' }
    const col = typeColors[node.type] || '#fff'
    const nodeOp = lerp(f, depth * 3, depth * 3 + 10, 0, 1)

    return (
      <div key={node.name} style={{ opacity: nodeOp }}>
        <div
          onClick={() => { setSelectedNode(node.name); if (hasChildren) toggleExpand(node.name) }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', marginLeft: depth * 16,
            borderRadius: 6, cursor: 'pointer', marginBottom: 2,
            background: isSelected ? `${col}15` : 'transparent',
            borderLeft: isSelected ? `2px solid ${col}` : '2px solid transparent',
          }}
        >
          {hasChildren && <span style={{ fontFamily: M, fontSize: 8, color: col, width: 10, textAlign: 'center' }}>{isExpanded ? '\u25BC' : '\u25B6'}</span>}
          {!hasChildren && <span style={{ width: 10 }} />}
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: col, opacity: 0.8, flexShrink: 0 }} />
          <span style={{ fontFamily: F, fontSize: 10, color: isSelected ? '#fff' : 'rgba(255,255,255,0.7)', fontWeight: isSelected ? 600 : 400 }}>{node.name}</span>
          {node.members && <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginLeft: 'auto' }}>{node.members}</span>}
        </div>
        {isExpanded && hasChildren && node.children.map((child, i) => renderTreeNode(child, depth + 1, i === node.children.length - 1))}
      </div>
    )
  }

  // Activity chart (bar chart, 8 weeks)
  const maxObj = Math.max(...ORG_WEEKLY_OBJECTIVES)

  return (
    <div style={{ opacity: reveal }}>
      {/* Hero Banner */}
      <GP style={{ padding: '16px 20px', marginBottom: 10, borderTopColor: 'rgba(168,85,247,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 48, height: 48, borderRadius: 10, background: 'linear-gradient(135deg, #a855f7 0%, #6366f1 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F, fontSize: 20, fontWeight: 800, color: '#fff', flexShrink: 0 }}>Q</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: F, fontSize: 20, fontWeight: 700, color: '#fff' }}>Quox LTD</div>
            <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>AI/SaaS</span>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>|</span>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Founded 2025</span>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>|</span>
              <span style={{ fontFamily: M, fontSize: 9, padding: '1px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.12)', color: '#10b981', fontWeight: 600 }}>Active</span>
            </div>
          </div>
        </div>
      </GP>

      {/* 3-column layout */}
      <div style={{ display: 'flex', gap: 8 }}>
        {/* Left: Org tree */}
        <GP style={{ width: 200, padding: '10px 8px', flexShrink: 0, alignSelf: 'flex-start' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8, paddingLeft: 6 }}>ORGANISATION TREE</div>
          {renderTreeNode(ORG_TREE_DATA)}
          <div style={{ marginTop: 8, padding: '4px 6px', fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.35)' }}>Division (3) \u2192 Dept (9) \u2192 Team (14)</div>
        </GP>

        {/* Centre: Metrics + charts + activity */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 6 metric cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
            {metrics.map((m, i) => {
              const mOp = lerp(f, 5 + i * 2, 15 + i * 2, 0, 1)
              return (
                <GP key={i} style={{ padding: '10px 8px', textAlign: 'center', opacity: mOp, borderTopColor: `${m.color}25` }}>
                  <div style={{ fontFamily: F, fontSize: 18, fontWeight: 700, color: m.color }}>{m.value}</div>
                  <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{m.label}</div>
                </GP>
              )
            })}
          </div>

          {/* Activity chart */}
          <GP style={{ padding: 14 }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 10 }}>OBJECTIVES COMPLETED — LAST 8 WEEKS</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
              {ORG_WEEKLY_OBJECTIVES.map((v, i) => {
                const barH = lerp(f, 8 + i * 2, 20 + i * 2, 0, (v / maxObj) * 70)
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.5)' }}>{v}</span>
                    <div style={{ width: '100%', height: barH, borderRadius: 3, background: `linear-gradient(180deg, #a855f7 0%, #6366f1 100%)`, opacity: 0.7, transition: 'height 0.3s' }} />
                    <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.35)' }}>W{i + 1}</span>
                  </div>
                )
              })}
            </div>
          </GP>

          {/* Recent activity */}
          <GP style={{ padding: 12 }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>RECENT ACTIVITY</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ORG_ACTIVITY_DATA.map((ev, i) => {
                const evOp = lerp(f, 12 + i * 2, 22 + i * 2, 0, 1)
                const typeColor = ev.type === 'agent' ? '#10b981' : ev.type === 'objective' ? '#f59e0b' : '#3b82f6'
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: evOp }}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, background: `${typeColor}15`, border: `1px solid ${typeColor}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 8, fontWeight: 700, color: typeColor, flexShrink: 0 }}>{ev.avatar}</div>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontFamily: F, fontSize: 10, color: '#fff' }}>{ev.actor}</span>
                      <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}> {ev.action}</span>
                    </div>
                    <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.35)' }}>{ev.time}</span>
                  </div>
                )
              })}
            </div>
          </GP>
        </div>

        {/* Right sidebar: Quick actions */}
        <GP style={{ width: 160, padding: '10px 8px', flexShrink: 0, alignSelf: 'flex-start' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>QUICK ACTIONS</div>
          {quickActions.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px', borderRadius: 6, cursor: 'pointer', marginBottom: 2, background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ width: 22, height: 22, borderRadius: 5, background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 11, color: '#a855f7', flexShrink: 0 }}>{qaIcons[i]}</div>
              <span style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{a}</span>
            </div>
          ))}
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 2. OrgHierarchyTree — Interactive Org Tree (SVG diagram)
// ═══════════════════════════════════════════════════════════════
export function OrgHierarchyTree() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const W = 720, H = 400
  const typeColors = { org: '#a855f7', division: '#3b82f6', dept: '#06b6d4', team: '#10b981' }

  // Layout positions (manually computed for clean tree)
  const nodes = [
    { name: 'Quox LTD', type: 'org', x: 360, y: 30, members: 47, health: 'green', depth: 0 },
    // Divisions
    { name: 'Engineering', type: 'division', x: 120, y: 100, members: 23, health: 'green', depth: 1, parent: 'Quox LTD' },
    { name: 'Operations', type: 'division', x: 360, y: 100, members: 14, health: 'green', depth: 1, parent: 'Quox LTD' },
    { name: 'Business', type: 'division', x: 600, y: 100, members: 10, health: 'green', depth: 1, parent: 'Quox LTD' },
    // Engineering depts
    { name: 'Platform', type: 'dept', x: 40, y: 190, members: 8, health: 'green', depth: 2, parent: 'Engineering' },
    { name: 'Security', type: 'dept', x: 120, y: 190, members: 6, health: 'green', depth: 2, parent: 'Engineering' },
    { name: 'DevOps', type: 'dept', x: 200, y: 190, members: 5, health: 'amber', depth: 2, parent: 'Engineering' },
    { name: 'QA', type: 'dept', x: 270, y: 190, members: 4, health: 'green', depth: 2, parent: 'Engineering' },
    // Operations depts
    { name: 'Infra', type: 'dept', x: 310, y: 190, members: 5, health: 'green', depth: 2, parent: 'Operations' },
    { name: 'Support', type: 'dept', x: 380, y: 190, members: 5, health: 'green', depth: 2, parent: 'Operations' },
    { name: 'Monitoring', type: 'dept', x: 450, y: 190, members: 4, health: 'green', depth: 2, parent: 'Operations' },
    // Business depts
    { name: 'Sales', type: 'dept', x: 560, y: 190, members: 5, health: 'green', depth: 2, parent: 'Business' },
    { name: 'Marketing', type: 'dept', x: 640, y: 190, members: 5, health: 'green', depth: 2, parent: 'Business' },
    // Key teams
    { name: 'Alpha', type: 'team', x: 20, y: 270, members: 3, health: 'green', depth: 3, parent: 'Platform' },
    { name: 'Beta', type: 'team', x: 50, y: 270, members: 3, health: 'green', depth: 3, parent: 'Platform' },
    { name: 'Core', type: 'team', x: 80, y: 270, members: 2, health: 'green', depth: 3, parent: 'Platform' },
    { name: 'AppSec', type: 'team', x: 110, y: 270, members: 3, health: 'green', depth: 3, parent: 'Security' },
    { name: 'CI/CD', type: 'team', x: 190, y: 270, members: 3, health: 'amber', depth: 3, parent: 'DevOps' },
    { name: 'SRE', type: 'team', x: 220, y: 270, members: 2, health: 'green', depth: 3, parent: 'DevOps' },
    { name: 'Network', type: 'team', x: 310, y: 270, members: 3, health: 'green', depth: 3, parent: 'Infra' },
    { name: 'Enterprise', type: 'team', x: 550, y: 270, members: 3, health: 'green', depth: 3, parent: 'Sales' },
    { name: 'Growth', type: 'team', x: 640, y: 270, members: 5, health: 'green', depth: 3, parent: 'Marketing' },
  ]

  const nodeMap = {}
  nodes.forEach(n => { nodeMap[n.name] = n })

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Organisation Hierarchy</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>47 members across 3 levels</div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          {Object.entries(typeColors).map(([type, color]) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, opacity: 0.8 }} />
              <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)', textTransform: 'capitalize' }}>{type === 'dept' ? 'Department' : type === 'org' ? 'Organisation' : type}</span>
            </div>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 320 }}>
        {/* Connection lines */}
        {nodes.filter(n => n.parent).map((n, i) => {
          const p = nodeMap[n.parent]
          if (!p) return null
          const lineOp = lerp(f, n.depth * 5, n.depth * 5 + 10, 0, 0.3)
          const col = typeColors[n.type]
          return <path key={i} d={`M${p.x},${p.y + 12} C${p.x},${(p.y + n.y) / 2} ${n.x},${(p.y + n.y) / 2} ${n.x},${n.y - 12}`} fill="none" stroke={col} strokeWidth={1} opacity={lineOp} />
        })}
        {/* Nodes */}
        {nodes.map((n, i) => {
          const col = typeColors[n.type]
          const r = n.type === 'org' ? 16 : n.type === 'division' ? 12 : n.type === 'dept' ? 9 : 6
          const nodeOp = lerp(f, n.depth * 5 + 2, n.depth * 5 + 12, 0, 1)
          const healthCol = n.health === 'green' ? '#10b981' : '#f59e0b'
          const glow = n.type === 'org' ? 0.3 + Math.sin(f * 0.06) * 0.2 : 0
          return (
            <g key={i} opacity={nodeOp}>
              {glow > 0 && <circle cx={n.x} cy={n.y} r={r + 6} fill={col} opacity={glow * 0.3} />}
              <circle cx={n.x} cy={n.y} r={r} fill={`${col}20`} stroke={col} strokeWidth={1.2} />
              <circle cx={n.x + r - 2} cy={n.y - r + 2} r={3} fill={healthCol} />
              <text x={n.x} y={n.y + r + 12} textAnchor="middle" fill="rgba(255,255,255,0.8)" fontSize={n.type === 'team' ? 7 : 8} fontFamily={F} fontWeight={n.type === 'org' ? 700 : 500}>{n.name}</text>
              <text x={n.x} y={n.y + 3} textAnchor="middle" fill={col} fontSize={n.type === 'org' ? 10 : 7} fontFamily={M} fontWeight={700}>{n.members}</text>
            </g>
          )
        })}
      </svg>
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.35)', textAlign: 'center', marginTop: 4 }}>Division (3) \u2192 Department (9) \u2192 Team (14) \u2014 47 members total</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 3. OrgMemberDirectory — Member Grid
// ═══════════════════════════════════════════════════════════════
export function OrgMemberDirectory() {
  const f = useAnimFrame()
  const [filter, setFilter] = useState('All')
  const reveal = lerp(f, 0, 12, 0, 1)
  const depts = ['All', 'Engineering', 'Operations', 'Business', 'DevOps', 'Security', 'QA', 'Marketing', 'Sales']
  const filtered = filter === 'All' ? ORG_MEMBERS_DATA : ORG_MEMBERS_DATA.filter(m => m.dept === filter)
  const onlineCount = ORG_MEMBERS_DATA.filter(m => m.online).length

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Member Directory</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>47 members | {onlineCount} online | 3 pending invites</div>
        </div>
        <GP style={{ padding: '4px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>\u2315</span>
            <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Search members...</span>
          </div>
        </GP>
      </div>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
        {depts.map(d => (
          <span key={d} onClick={() => setFilter(d)} style={{
            fontFamily: M, fontSize: 8, padding: '3px 10px', borderRadius: 10, cursor: 'pointer',
            background: filter === d ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.04)',
            color: filter === d ? '#a855f7' : 'rgba(255,255,255,0.5)',
            border: `1px solid ${filter === d ? 'rgba(168,85,247,0.3)' : 'rgba(255,255,255,0.06)'}`,
          }}>{d}</span>
        ))}
      </div>

      {/* Member grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {filtered.map((m, i) => {
          const cardOp = lerp(f, 5 + i, 15 + i, 0, 1)
          const roleBg = ROLE_COLORS[m.role] || '#3b82f6'
          return (
            <GP key={i} style={{ padding: '10px 10px', opacity: cardOp, borderTopColor: `${roleBg}20` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: `${roleBg}20`, border: `1px solid ${roleBg}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 10, fontWeight: 700, color: roleBg }}>{m.initials}</div>
                  {m.online && <div style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderRadius: '50%', background: '#10b981', border: '2px solid rgba(0,0,0,0.5)' }} />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                  <span style={{ fontFamily: M, fontSize: 7, padding: '1px 6px', borderRadius: 3, background: `${roleBg}15`, color: roleBg, fontWeight: 600 }}>{m.role}</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>
                <span>{m.dept}</span>
                <span>{m.lastActive}</span>
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 4. OrgResourceAllocation — Resource Distribution
// ═══════════════════════════════════════════════════════════════
export function OrgResourceAllocation() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)

  const divisions = [
    { name: 'Engineering', pct: 55, agents: 8, members: 23, cost: 89, objectives: 67, color: '#3b82f6', capacity: 92 },
    { name: 'Operations', pct: 30, agents: 5, members: 14, cost: 28, objectives: 25, color: '#10b981', capacity: 71 },
    { name: 'Business', pct: 15, agents: 3, members: 10, cost: 10, objectives: 8, color: '#f59e0b', capacity: 45 },
  ]

  const weeklySpend = [112, 119, 134, 127]
  const maxSpend = Math.max(...weeklySpend)
  const agentActive = 12, agentTotal = 16
  const agentPct = lerp(f, 10, 25, 0, (agentActive / agentTotal) * 100)

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Resource Allocation</div>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>How resources are distributed across the organisation</div>

      {/* Stacked bar */}
      <GP style={{ padding: 12, marginBottom: 8 }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 6, letterSpacing: 1 }}>DIVISION SHARE</div>
        <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
          {divisions.map((d, i) => {
            const barW = lerp(f, 5 + i * 3, 18 + i * 3, 0, d.pct)
            return <div key={i} style={{ width: `${barW}%`, height: '100%', background: d.color, opacity: 0.7, borderRadius: i === 0 ? '6px 0 0 6px' : i === divisions.length - 1 ? '0 6px 6px 0' : 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 8, color: '#fff', fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap' }}>{barW > 12 ? `${d.name} ${d.pct}%` : ''}</div>
          })}
        </div>
      </GP>

      {/* Per-division breakdown */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {divisions.map((d, i) => {
          const cardOp = lerp(f, 8 + i * 3, 20 + i * 3, 0, 1)
          return (
            <GP key={i} style={{ flex: 1, padding: '10px 10px', opacity: cardOp, borderTopColor: `${d.color}30` }}>
              <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: d.color, marginBottom: 8 }}>{d.name}</div>
              {[
                { label: 'Agents', value: d.agents },
                { label: 'Members', value: d.members },
                { label: 'Cost', value: `$${d.cost}/mo` },
                { label: 'Objectives', value: `${d.objectives}%` },
              ].map((row, ri) => (
                <div key={ri} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{row.label}</span>
                  <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: '#fff' }}>{row.value}</span>
                </div>
              ))}
            </GP>
          )
        })}
      </div>

      {/* Bottom row: agent gauge + cost sparkline + recommendation */}
      <div style={{ display: 'flex', gap: 6 }}>
        <GP style={{ flex: 1, padding: 10 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 6, letterSpacing: 1 }}>AGENT UTILIZATION</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ position: 'relative', width: 48, height: 48 }}>
              <svg viewBox="0 0 48 48" style={{ width: 48, height: 48 }}>
                <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
                <circle cx="24" cy="24" r="20" fill="none" stroke="#10b981" strokeWidth="4" strokeDasharray={`${agentPct * 1.257} 999`} strokeLinecap="round" transform="rotate(-90 24 24)" />
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 10, fontWeight: 700, color: '#10b981' }}>{Math.round(agentPct)}%</div>
            </div>
            <div>
              <div style={{ fontFamily: F, fontSize: 11, color: '#fff' }}>{agentActive}/{agentTotal} active</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>4 idle agents available</div>
            </div>
          </div>
        </GP>
        <GP style={{ flex: 1, padding: 10 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 6, letterSpacing: 1 }}>COST TREND</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 36 }}>
            {weeklySpend.map((v, i) => {
              const bH = lerp(f, 10 + i * 2, 20 + i * 2, 0, (v / maxSpend) * 30)
              return <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.5)' }}>${v}</span>
                <div style={{ width: '100%', height: bH, borderRadius: 2, background: i === weeklySpend.length - 1 ? '#ec4899' : 'rgba(236,72,153,0.4)' }} />
              </div>
            })}
          </div>
        </GP>
        <GP style={{ flex: 1.5, padding: 10, borderTopColor: 'rgba(249,115,22,0.2)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 4, letterSpacing: 1 }}>RECOMMENDATION</div>
          <div style={{ fontFamily: F, fontSize: 10, color: '#f59e0b', lineHeight: 1.4 }}>Engineering is at {divisions[0].capacity}% agent capacity \u2014 consider adding agents or redistributing workload.</div>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 5. OrgComplianceOverview — Org Compliance
// ═══════════════════════════════════════════════════════════════
export function OrgComplianceOverview() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)

  const areas = [
    { name: 'Data Protection', standard: 'GDPR', pct: 94, finding: 'All PII redacted, DPA in place, consent records current', color: '#10b981', icon: '\u26E8' },
    { name: 'Access Control', standard: 'RBAC', pct: 97, finding: 'All roles assigned, no orphaned permissions, MFA enforced', color: '#3b82f6', icon: '\u26BF' },
    { name: 'Audit Trail', standard: 'VOLT', pct: 100, finding: 'All actions evidenced, WARD receipts witnessed, chain verified', color: '#a855f7', icon: '\u2637' },
    { name: 'Token Security', standard: 'Secrets', pct: 89, finding: '2 credentials expiring within 14 days, rotation recommended', color: '#f59e0b', icon: '\u26A0' },
  ]

  const overallScore = Math.round(areas.reduce((s, a) => s + a.pct, 0) / areas.length)

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Compliance Overview</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>Last org audit: 7 days ago</div>
        </div>
        <GP style={{ padding: '6px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative', width: 32, height: 32 }}>
              <svg viewBox="0 0 32 32" style={{ width: 32, height: 32 }}>
                <circle cx="16" cy="16" r="13" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                <circle cx="16" cy="16" r="13" fill="none" stroke="#10b981" strokeWidth="3" strokeDasharray={`${lerp(f, 5, 20, 0, overallScore) * 0.817} 999`} strokeLinecap="round" transform="rotate(-90 16 16)" />
              </svg>
            </div>
            <div>
              <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: '#10b981' }}>{Math.round(lerp(f, 5, 20, 0, overallScore))}%</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>Compliant</div>
            </div>
          </div>
        </GP>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
        {areas.map((a, i) => {
          const cardOp = lerp(f, 5 + i * 3, 18 + i * 3, 0, 1)
          const ringPct = lerp(f, 8 + i * 3, 22 + i * 3, 0, a.pct)
          const statusBadge = a.pct === 100 ? 'PASS' : a.pct >= 90 ? 'GOOD' : 'WARN'
          const statusCol = a.pct === 100 ? '#10b981' : a.pct >= 90 ? '#3b82f6' : '#f59e0b'
          return (
            <GP key={i} style={{ padding: 14, opacity: cardOp, borderTopColor: `${a.color}25` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ position: 'relative', width: 44, height: 44, flexShrink: 0 }}>
                  <svg viewBox="0 0 44 44" style={{ width: 44, height: 44 }}>
                    <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3.5" />
                    <circle cx="22" cy="22" r="18" fill="none" stroke={a.color} strokeWidth="3.5" strokeDasharray={`${ringPct * 1.131} 999`} strokeLinecap="round" transform="rotate(-90 22 22)" />
                  </svg>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 10, fontWeight: 700, color: a.color }}>{Math.round(ringPct)}%</div>
                </div>
                <div>
                  <div style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: '#fff' }}>{a.name}</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                    <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{a.standard}</span>
                    <span style={{ fontFamily: M, fontSize: 7, padding: '1px 6px', borderRadius: 3, background: `${statusCol}15`, color: statusCol, fontWeight: 600 }}>{statusBadge}</span>
                  </div>
                </div>
              </div>
              <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.6)', lineHeight: 1.4 }}>{a.finding}</div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 6. DivisionFullPage — Complete Division Page
// ═══════════════════════════════════════════════════════════════
export function DivisionFullPage() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)

  const depts = [
    { name: 'Platform', teams: 3, members: 8, health: 'green', completion: 94, color: '#3b82f6' },
    { name: 'Security', teams: 2, members: 6, health: 'green', completion: 97, color: '#10b981' },
    { name: 'DevOps', teams: 2, members: 5, health: 'amber', completion: 89, color: '#f59e0b' },
    { name: 'QA', teams: 1, members: 4, health: 'green', completion: 78, color: '#a855f7' },
  ]

  const agents = [
    { name: 'WARDEN', role: 'Security scanner', color: '#10b981' },
    { name: 'VULCAN', role: 'Deployment agent', color: '#3b82f6' },
    { name: 'CODEX', role: 'Code review', color: '#6366f1' },
    { name: 'NETWATCH', role: 'Network monitor', color: '#ec4899' },
  ]

  const metrics = [
    { label: 'Departments', value: '4', color: '#3b82f6' },
    { label: 'Teams', value: '8', color: '#06b6d4' },
    { label: 'Members', value: '23', color: '#10b981' },
    { label: 'Objectives/wk', value: '12', color: '#f59e0b' },
  ]

  const chatPreview = [
    { from: 'You', text: 'What is the deployment status?' },
    { from: 'ENG-AI', text: 'v2.4.1 deployed to production 3h ago. All health checks passing. Next release v2.5 planned for Thursday.' },
  ]

  return (
    <div style={{ opacity: reveal }}>
      {/* Header */}
      <GP style={{ padding: '14px 18px', marginBottom: 10, borderTopColor: 'rgba(59,130,246,0.3)' }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 2 }}>Quox LTD \u2192 Engineering Division</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontFamily: F, fontSize: 18, fontWeight: 700, color: '#fff' }}>Engineering Division</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>4 departments \u2022 23 members</div>
        </div>
      </GP>

      <div style={{ display: 'flex', gap: 8 }}>
        {/* Left: Department list */}
        <div style={{ width: 180, display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 2, paddingLeft: 4 }}>DEPARTMENTS</div>
          {depts.map((d, i) => {
            const dOp = lerp(f, 3 + i * 2, 13 + i * 2, 0, 1)
            const healthCol = d.health === 'green' ? '#10b981' : '#f59e0b'
            return (
              <GP key={i} style={{ padding: '8px 10px', opacity: dOp, borderTopColor: `${d.color}20` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: healthCol }} />
                  <span style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff' }}>{d.name}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>
                  <span>{d.teams} teams</span>
                  <span>{d.members} members</span>
                </div>
              </GP>
            )
          })}
        </div>

        {/* Centre: Metrics + performance + agents */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Metrics row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {metrics.map((m, i) => {
              const mOp = lerp(f, 5 + i * 2, 15 + i * 2, 0, 1)
              return (
                <GP key={i} style={{ padding: '8px 8px', textAlign: 'center', opacity: mOp, borderTopColor: `${m.color}25` }}>
                  <div style={{ fontFamily: F, fontSize: 18, fontWeight: 700, color: m.color }}>{m.value}</div>
                  <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{m.label}</div>
                </GP>
              )
            })}
          </div>

          {/* Department performance bars */}
          <GP style={{ padding: 12 }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>DEPARTMENT COMPLETION RATE</div>
            {depts.map((d, i) => {
              const barW = lerp(f, 10 + i * 3, 24 + i * 3, 0, d.completion)
              return (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontFamily: F, fontSize: 10, color: '#fff' }}>{d.name}</span>
                    <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: d.color }}>{Math.round(barW)}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                    <div style={{ width: `${barW}%`, height: '100%', borderRadius: 3, background: d.color, opacity: 0.7 }} />
                  </div>
                </div>
              )
            })}
          </GP>

          {/* Agent assignment */}
          <GP style={{ padding: 12 }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>ASSIGNED AGENTS</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {agents.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 6, background: `${a.color}08` }}>
                  <div style={{ width: 20, height: 20, borderRadius: 5, background: `${a.color}20`, border: `1px solid ${a.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 7, fontWeight: 700, color: a.color, flexShrink: 0 }}>{a.name[0]}</div>
                  <div>
                    <div style={{ fontFamily: M, fontSize: 8, fontWeight: 600, color: a.color }}>{a.name}</div>
                    <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>{a.role}</div>
                  </div>
                </div>
              ))}
            </div>
          </GP>
        </div>

        {/* Right sidebar: AI assistant chat preview */}
        <GP style={{ width: 180, padding: '10px 10px', flexShrink: 0, alignSelf: 'flex-start', borderTopColor: 'rgba(16,185,129,0.2)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>ENG-AI ASSISTANT</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {chatPreview.map((msg, i) => (
              <div key={i} style={{ padding: '6px 8px', borderRadius: 6, background: msg.from === 'You' ? 'rgba(59,130,246,0.1)' : 'rgba(16,185,129,0.08)', borderLeft: `2px solid ${msg.from === 'You' ? '#3b82f6' : '#10b981'}` }}>
                <div style={{ fontFamily: M, fontSize: 7, color: msg.from === 'You' ? '#3b82f6' : '#10b981', marginBottom: 2, fontWeight: 600 }}>{msg.from}</div>
                <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)', lineHeight: 1.3 }}>{msg.text}</div>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>Ask about deployment status, team velocity, or recent changes</div>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 7. DivisionComparisonChart — Compare Divisions
// ═══════════════════════════════════════════════════════════════
export function DivisionComparisonChart() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)

  const divs = [
    { name: 'Engineering', members: 23, teams: 8, objPerWeek: 12, successRate: 94, cost: 89, topAgent: 'VULCAN', color: '#3b82f6', trend: [88, 91, 93, 94] },
    { name: 'Operations', members: 14, teams: 5, objPerWeek: 8, successRate: 91, cost: 28, topAgent: 'WARDEN', color: '#10b981', trend: [85, 87, 90, 91] },
    { name: 'Business', members: 10, teams: 3, objPerWeek: 5, successRate: 87, cost: 10, topAgent: 'DAEDALUS', color: '#f59e0b', trend: [82, 84, 86, 87] },
  ]

  const winners = [
    { label: 'Most productive', winner: 'Engineering', color: '#3b82f6' },
    { label: 'Most efficient', winner: 'Operations', color: '#10b981' },
    { label: 'Lowest cost', winner: 'Business', color: '#f59e0b' },
  ]

  const rows = [
    { label: 'Members', key: 'members' },
    { label: 'Teams', key: 'teams' },
    { label: 'Objectives/wk', key: 'objPerWeek' },
    { label: 'Success rate', key: 'successRate', suffix: '%' },
    { label: 'Cost/month', key: 'cost', prefix: '$' },
    { label: 'Top agent', key: 'topAgent' },
  ]

  const maxSuccess = Math.max(...divs.map(d => d.successRate))

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Division Comparison</div>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>Side-by-side performance across all 3 divisions</div>

      {/* Comparison table */}
      <GP style={{ padding: 14, marginBottom: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '100px repeat(3, 1fr)', gap: 0 }}>
          {/* Header */}
          <div />
          {divs.map((d, i) => (
            <div key={i} style={{ textAlign: 'center', paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: d.color }}>{d.name}</div>
            </div>
          ))}
          {/* Rows */}
          {rows.map((row, ri) => (
            [
              <div key={`l-${ri}`} style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>{row.label}</div>,
              ...divs.map((d, di) => (
                <div key={`v-${ri}-${di}`} style={{ textAlign: 'center', fontFamily: M, fontSize: 10, fontWeight: 600, color: '#fff', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  {row.prefix || ''}{d[row.key]}{row.suffix || ''}
                </div>
              ))
            ]
          )).flat()}
        </div>
      </GP>

      {/* Success rate bar chart */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <GP style={{ flex: 2, padding: 12 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>SUCCESS RATE COMPARISON</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 60 }}>
            {divs.map((d, i) => {
              const barH = lerp(f, 8 + i * 3, 22 + i * 3, 0, (d.successRate / maxSuccess) * 50)
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                  <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: d.color }}>{d.successRate}%</span>
                  <div style={{ width: '80%', height: barH, borderRadius: 4, background: d.color, opacity: 0.7 }} />
                  <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{d.name}</span>
                </div>
              )
            })}
          </div>
        </GP>

        {/* 4-week sparklines */}
        <GP style={{ flex: 1, padding: 12 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>4-WEEK TREND</div>
          {divs.map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontFamily: M, fontSize: 8, color: d.color, width: 16 }}>{d.name[0]}</span>
              <svg viewBox="0 0 60 16" style={{ width: 60, height: 16 }}>
                <polyline points={d.trend.map((v, ti) => `${ti * 20},${16 - (v - 80) * 0.8}`).join(' ')} fill="none" stroke={d.color} strokeWidth="1.5" opacity="0.7" />
              </svg>
              <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{d.trend[3]}%</span>
            </div>
          ))}
        </GP>
      </div>

      {/* Winner badges */}
      <div style={{ display: 'flex', gap: 6 }}>
        {winners.map((w, i) => (
          <GP key={i} style={{ flex: 1, padding: '6px 10px', borderTopColor: `${w.color}25` }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{w.label}</div>
            <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: w.color }}>{w.winner}</div>
          </GP>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 8. DivisionOrgChart — Division Org Chart
// ═══════════════════════════════════════════════════════════════
export function DivisionOrgChart() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)
  const W = 600, H = 340

  const people = [
    // Division head
    { name: 'Alex Chen', role: 'VP Engineering', x: 300, y: 30, level: 0, online: true, color: '#a855f7' },
    // Dept leads
    { name: 'Sarah Wu', role: 'Platform Lead', x: 80, y: 120, level: 1, online: true, parent: 'Alex Chen', color: '#3b82f6' },
    { name: 'Priya Patel', role: 'Security Lead', x: 230, y: 120, level: 1, online: true, parent: 'Alex Chen', color: '#10b981' },
    { name: 'Marcus Cole', role: 'DevOps Lead', x: 380, y: 120, level: 1, online: false, parent: 'Alex Chen', color: '#f59e0b' },
    { name: 'Nina Volkov', role: 'QA Lead', x: 520, y: 120, level: 1, online: false, parent: 'Alex Chen', color: '#ec4899' },
    // Team members
    { name: 'Tom B.', role: 'Frontend', x: 30, y: 210, level: 2, online: false, parent: 'Sarah Wu', color: '#3b82f6' },
    { name: 'James R.', role: 'Backend', x: 80, y: 210, level: 2, online: true, parent: 'Sarah Wu', color: '#3b82f6' },
    { name: 'Emily Z.', role: 'Full Stack', x: 130, y: 210, level: 2, online: false, parent: 'Sarah Wu', color: '#3b82f6' },
    { name: 'David O.', role: 'AppSec', x: 200, y: 210, level: 2, online: false, parent: 'Priya Patel', color: '#10b981' },
    { name: 'Chris T.', role: 'InfraSec', x: 260, y: 210, level: 2, online: false, parent: 'Priya Patel', color: '#10b981' },
    { name: 'Lisa P.', role: 'SRE', x: 350, y: 210, level: 2, online: false, parent: 'Marcus Cole', color: '#f59e0b' },
    { name: 'Ryan K.', role: 'CI/CD', x: 410, y: 210, level: 2, online: false, parent: 'Marcus Cole', color: '#f59e0b' },
    { name: 'Amir H.', role: 'QA Eng', x: 490, y: 210, level: 2, online: false, parent: 'Nina Volkov', color: '#ec4899' },
    { name: 'Zoe L.', role: 'Test Lead', x: 550, y: 210, level: 2, online: false, parent: 'Nina Volkov', color: '#ec4899' },
  ]

  const personMap = {}
  people.forEach(p => { personMap[p.name] = p })

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Engineering Division Org Chart</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>23 members, 4 departments, 3 reporting levels</div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 280 }}>
        {/* Lines */}
        {people.filter(p => p.parent).map((p, i) => {
          const par = personMap[p.parent]
          if (!par) return null
          const lineOp = lerp(f, p.level * 5, p.level * 5 + 10, 0, 0.25)
          return <path key={i} d={`M${par.x},${par.y + 20} C${par.x},${(par.y + p.y) / 2 + 10} ${p.x},${(par.y + p.y) / 2 - 10} ${p.x},${p.y - 16}`} fill="none" stroke={p.color} strokeWidth={0.8} opacity={lineOp} />
        })}
        {/* Nodes */}
        {people.map((p, i) => {
          const nodeOp = lerp(f, p.level * 5 + 2, p.level * 5 + 12, 0, 1)
          const r = p.level === 0 ? 16 : p.level === 1 ? 13 : 10
          const initials = p.name.split(' ').map(w => w[0]).join('')
          return (
            <g key={i} opacity={nodeOp}>
              <circle cx={p.x} cy={p.y} r={r} fill={`${p.color}15`} stroke={p.color} strokeWidth={1} />
              <text x={p.x} y={p.y + 3} textAnchor="middle" fill={p.color} fontSize={p.level === 0 ? 9 : 7} fontFamily={M} fontWeight={700}>{initials}</text>
              {p.online && <circle cx={p.x + r - 2} cy={p.y - r + 2} r={2.5} fill="#10b981" />}
              <text x={p.x} y={p.y + r + 10} textAnchor="middle" fill="rgba(255,255,255,0.8)" fontSize={p.level < 2 ? 8 : 7} fontFamily={F} fontWeight={p.level === 0 ? 600 : 400}>{p.name}</text>
              <text x={p.x} y={p.y + r + 19} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize={6} fontFamily={M}>{p.role}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 9. DivisionActivityFeed — Division Activity Stream
// ═══════════════════════════════════════════════════════════════
export function DivisionActivityFeed() {
  const f = useAnimFrame()
  const [filter, setFilter] = useState('All')
  const reveal = lerp(f, 0, 12, 0, 1)

  const events = [
    { actor: 'Alex Chen', action: 'created Platform team Alpha', dept: 'Platform', time: '2h ago', type: 'people', avatar: 'AC' },
    { actor: 'WARDEN', action: 'completed security scan for Engineering', dept: 'Security', time: '3h ago', type: 'agent', avatar: 'SN' },
    { actor: 'Sarah Wu', action: 'joined DevOps department', dept: 'DevOps', time: 'yesterday', type: 'people', avatar: 'SW' },
    { actor: 'VULCAN', action: 'deployed v2.4.1 to production cluster', dept: 'Platform', time: 'yesterday', type: 'agent', avatar: 'FG' },
    { actor: 'QA Automation', action: 'flagged 3 regressions in Sprint 14', dept: 'QA', time: '2 days ago', type: 'objective', avatar: 'QA' },
    { actor: 'Marcus Cole', action: 'updated CI/CD pipeline configuration', dept: 'DevOps', time: '2 days ago', type: 'people', avatar: 'MC' },
    { actor: 'CODEX', action: 'reviewed 12 pull requests', dept: 'Platform', time: '3 days ago', type: 'agent', avatar: 'CX' },
    { actor: 'Emily Zhang', action: 'completed Sprint 13 retrospective', dept: 'Platform', time: '3 days ago', type: 'people', avatar: 'EZ' },
    { actor: 'NETWATCH', action: 'detected latency spike on edge-02', dept: 'DevOps', time: '4 days ago', type: 'agent', avatar: 'NW' },
    { actor: 'Priya Patel', action: 'published security audit report Q1', dept: 'Security', time: '5 days ago', type: 'people', avatar: 'PP' },
  ]

  const filters = ['All', 'People', 'Agents', 'Objectives']
  const filtered = filter === 'All' ? events : events.filter(e => {
    if (filter === 'People') return e.type === 'people'
    if (filter === 'Agents') return e.type === 'agent'
    if (filter === 'Objectives') return e.type === 'objective'
    return true
  })

  const typeColors = { people: '#3b82f6', agent: '#10b981', objective: '#f59e0b' }
  const deptColors = { Platform: '#3b82f6', Security: '#10b981', DevOps: '#f59e0b', QA: '#a855f7' }

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Engineering Activity Feed</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{events.length} events this week</div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {filters.map(fl => (
            <span key={fl} onClick={() => setFilter(fl)} style={{
              fontFamily: M, fontSize: 8, padding: '3px 10px', borderRadius: 10, cursor: 'pointer',
              background: filter === fl ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.04)',
              color: filter === fl ? '#3b82f6' : 'rgba(255,255,255,0.5)',
              border: `1px solid ${filter === fl ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.06)'}`,
            }}>{fl}</span>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filtered.map((ev, i) => {
          const evOp = lerp(f, 3 + i * 1.5, 12 + i * 1.5, 0, 1)
          const tc = typeColors[ev.type] || '#fff'
          const dc = deptColors[ev.dept] || '#06b6d4'
          return (
            <GP key={i} style={{ padding: '8px 12px', opacity: evOp }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: `${tc}12`, border: `1px solid ${tc}25`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 8, fontWeight: 700, color: tc, flexShrink: 0 }}>{ev.avatar}</div>
                <div style={{ flex: 1 }}>
                  <div>
                    <span style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff' }}>{ev.actor}</span>
                    <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.6)' }}> {ev.action}</span>
                  </div>
                </div>
                <span style={{ fontFamily: M, fontSize: 7, padding: '2px 6px', borderRadius: 3, background: `${dc}12`, color: dc, fontWeight: 600 }}>{ev.dept}</span>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap' }}>{ev.time}</span>
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 10. DivisionBudget — Division Budget Panel
// ═══════════════════════════════════════════════════════════════
export function DivisionBudget() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)

  const budget = 200, spent = 127
  const depts = [
    { name: 'Platform', spent: 56, pct: 44, color: '#3b82f6' },
    { name: 'Security', spent: 31, pct: 24, color: '#10b981' },
    { name: 'DevOps', spent: 28, pct: 22, color: '#f59e0b' },
    { name: 'QA', spent: 12, pct: 10, color: '#a855f7' },
  ]

  const gaugeVal = lerp(f, 5, 22, 0, (spent / budget) * 100)
  const projection = 184

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Engineering Budget</div>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>Monthly allocation: ${budget}</div>

      <div style={{ display: 'flex', gap: 8 }}>
        {/* Left: Gauge */}
        <GP style={{ flex: 1, padding: 14, textAlign: 'center' }}>
          <div style={{ position: 'relative', width: 100, height: 100, margin: '0 auto 8px' }}>
            <svg viewBox="0 0 100 100" style={{ width: 100, height: 100 }}>
              <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
              <circle cx="50" cy="50" r="40" fill="none" stroke="#3b82f6" strokeWidth="8" strokeDasharray={`${gaugeVal * 2.513} 999`} strokeLinecap="round" transform="rotate(-90 50 50)" />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ fontFamily: F, fontSize: 20, fontWeight: 700, color: '#3b82f6' }}>${spent}</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>of ${budget}</div>
            </div>
          </div>
          <div style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: '#3b82f6' }}>{Math.round(gaugeVal)}% used</div>
        </GP>

        {/* Right: Breakdown */}
        <GP style={{ flex: 1.5, padding: 14 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>DEPARTMENT BREAKDOWN</div>
          {depts.map((d, i) => {
            const barW = lerp(f, 8 + i * 3, 22 + i * 3, 0, d.pct)
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontFamily: F, fontSize: 10, color: '#fff' }}>{d.name}</span>
                  <span style={{ fontFamily: M, fontSize: 9, color: d.color }}>${d.spent} ({d.pct}%)</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                  <div style={{ width: `${barW}%`, height: '100%', borderRadius: 3, background: d.color, opacity: 0.7 }} />
                </div>
              </div>
            )
          })}
        </GP>
      </div>

      {/* Bottom: Trend + Projection + Alert */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <GP style={{ flex: 1, padding: '8px 10px', borderTopColor: 'rgba(16,185,129,0.2)' }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Trend</div>
          <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#10b981' }}>\u2193 Down 8% from last month</div>
        </GP>
        <GP style={{ flex: 1, padding: '8px 10px' }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Projection</div>
          <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#3b82f6' }}>Est. month-end: ${projection}</div>
          <div style={{ fontFamily: M, fontSize: 8, color: '#10b981' }}>Within budget</div>
        </GP>
        <GP style={{ flex: 1, padding: '8px 10px', borderTopColor: 'rgba(249,115,22,0.2)' }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Alert</div>
          <div style={{ fontFamily: F, fontSize: 9, color: '#f59e0b', lineHeight: 1.3 }}>DevOps spend increased 23% \u2014 new deployment pipeline</div>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 11. DepartmentFullPage — Complete Department Page
// ═══════════════════════════════════════════════════════════════
export function DepartmentFullPage() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)

  const teams = [
    { name: 'Alpha', members: 4, sprint: 'Sprint 14', velocity: 23, lead: 'Alex', day: '3/10' },
    { name: 'Beta', members: 3, sprint: 'Sprint 14', velocity: 21, lead: 'Sarah', day: '3/10' },
    { name: 'Core', members: 5, sprint: 'Sprint 14', velocity: 23, lead: 'Mike', day: '3/10' },
  ]

  const sprintCols = [
    { name: 'Backlog', count: 8, color: 'rgba(255,255,255,0.3)' },
    { name: 'In Progress', count: 5, color: '#3b82f6' },
    { name: 'Review', count: 3, color: '#f59e0b' },
    { name: 'Done', count: 12, color: '#10b981' },
  ]

  const objectives = [
    { name: 'Deploy v2.4', progress: 67, color: '#3b82f6' },
    { name: 'Migrate auth to OAuth2', progress: 34, color: '#a855f7' },
  ]

  const teamGauges = [
    { name: 'Alpha', velocity: 94, completion: 91, quality: 96, color: '#3b82f6' },
    { name: 'Beta', velocity: 82, completion: 87, quality: 89, color: '#10b981' },
    { name: 'Core', velocity: 88, completion: 85, quality: 93, color: '#f59e0b' },
  ]

  return (
    <div style={{ opacity: reveal }}>
      {/* Header with breadcrumb */}
      <GP style={{ padding: '14px 18px', marginBottom: 10, borderTopColor: 'rgba(6,182,212,0.3)' }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 2 }}>Engineering Division \u2192 Quox LTD</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontFamily: F, fontSize: 18, fontWeight: 700, color: '#fff' }}>Platform Department</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>3 teams \u2022 12 members \u2022 Sprint 14 Day 3</div>
        </div>
      </GP>

      <div style={{ display: 'flex', gap: 8 }}>
        {/* Left: Team list */}
        <div style={{ width: 170, display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, paddingLeft: 4, marginBottom: 2 }}>TEAMS</div>
          {teams.map((t, i) => {
            const tOp = lerp(f, 3 + i * 2, 13 + i * 2, 0, 1)
            return (
              <GP key={i} style={{ padding: '8px 10px', opacity: tOp }}>
                <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 3 }}>{t.name}</div>
                <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginBottom: 2 }}>Lead: {t.lead}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>
                  <span>{t.sprint}</span>
                  <span>{t.velocity} pts/sprint</span>
                </div>
                <div style={{ fontFamily: M, fontSize: 7, color: '#06b6d4', marginTop: 2 }}>Day {t.day}</div>
              </GP>
            )
          })}
        </div>

        {/* Centre: Sprint board + performance + objectives */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Sprint board mini */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {sprintCols.map((col, i) => {
              const cOp = lerp(f, 5 + i * 2, 15 + i * 2, 0, 1)
              return (
                <GP key={i} style={{ padding: '10px 8px', textAlign: 'center', opacity: cOp, borderTopColor: `${col.color}30` }}>
                  <div style={{ fontFamily: F, fontSize: 24, fontWeight: 700, color: col.color }}>{col.count}</div>
                  <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{col.name}</div>
                </GP>
              )
            })}
          </div>

          {/* Team performance mini gauges */}
          <GP style={{ padding: 12 }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>TEAM PERFORMANCE</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {teamGauges.map((tg, i) => (
                <div key={i} style={{ textAlign: 'center' }}>
                  <div style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: tg.color, marginBottom: 6 }}>{tg.name}</div>
                  {[{ label: 'Velocity', val: tg.velocity }, { label: 'Completion', val: tg.completion }, { label: 'Quality', val: tg.quality }].map((m, mi) => {
                    const mW = lerp(f, 10 + i * 3 + mi * 2, 24 + i * 3 + mi * 2, 0, m.val)
                    return (
                      <div key={mi} style={{ marginBottom: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)', marginBottom: 1 }}>
                          <span>{m.label}</span><span>{Math.round(mW)}%</span>
                        </div>
                        <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                          <div style={{ width: `${mW}%`, height: '100%', borderRadius: 2, background: tg.color, opacity: 0.6 }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </GP>

          {/* Current objectives */}
          <GP style={{ padding: 12 }}>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>ACTIVE OBJECTIVES</div>
            {objectives.map((obj, i) => {
              const pW = lerp(f, 12 + i * 4, 26 + i * 4, 0, obj.progress)
              return (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontFamily: F, fontSize: 10, color: '#fff' }}>{obj.name}</span>
                    <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: obj.color }}>{Math.round(pW)}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                    <div style={{ width: `${pW}%`, height: '100%', borderRadius: 3, background: `linear-gradient(90deg, ${obj.color}, ${obj.color}88)` }} />
                  </div>
                </div>
              )
            })}
          </GP>
        </div>

        {/* Right: AI assistant */}
        <GP style={{ width: 160, padding: '10px 10px', flexShrink: 0, alignSelf: 'flex-start', borderTopColor: 'rgba(6,182,212,0.2)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>PLATFORM AI</div>
          <div style={{ padding: '6px 8px', borderRadius: 6, background: 'rgba(6,182,212,0.08)', borderLeft: '2px solid #06b6d4', marginBottom: 8 }}>
            <div style={{ fontFamily: M, fontSize: 7, color: '#06b6d4', marginBottom: 2, fontWeight: 600 }}>PLATFORM-AI</div>
            <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.7)', lineHeight: 1.3 }}>Sprint 14 is on track. Alpha team velocity is up 8% from last sprint. Beta team has 2 blocked items needing review.</div>
          </div>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.35)', textAlign: 'center', lineHeight: 1.3 }}>Ask about deployment status, team velocity, or recent changes</div>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 12. DepartmentTeamView — Teams Within Department
// ═══════════════════════════════════════════════════════════════
export function DepartmentTeamView() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)

  const teams = [
    { name: 'Alpha', lead: 'Alex', members: ['AX', 'JR', 'EZ', 'PP'], sprint: 'Sprint 14', day: '3/10', velocity: 23, trend: 'up', objective: 'Deploy v2.4', objProgress: 67, build: true, tests: true, coverage: false, color: '#3b82f6' },
    { name: 'Beta', lead: 'Sarah', members: ['SW', 'MC', 'DO'], sprint: 'Sprint 14', day: '3/10', velocity: 21, trend: 'down', objective: 'OAuth2 migration', objProgress: 34, build: true, tests: true, coverage: true, color: '#10b981' },
    { name: 'Core', lead: 'Mike', members: ['MR', 'CT', 'LP', 'NV', 'TB'], sprint: 'Sprint 14', day: '3/10', velocity: 23, trend: 'up', objective: 'Memory tier refactor', objProgress: 52, build: true, tests: false, coverage: false, color: '#f59e0b' },
  ]

  const totalVelocity = teams.reduce((s, t) => s + t.velocity, 0)
  const totalMembers = teams.reduce((s, t) => s + t.members.length, 0)

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Platform Teams</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>3 teams | {totalMembers} members | Sprint velocity: {totalVelocity} pts</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {teams.map((t, i) => {
          const cardOp = lerp(f, 3 + i * 3, 16 + i * 3, 0, 1)
          const objW = lerp(f, 10 + i * 3, 24 + i * 3, 0, t.objProgress)
          return (
            <GP key={i} style={{ padding: 14, opacity: cardOp, borderTopColor: `${t.color}25` }}>
              {/* Team header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: t.color }}>{t.name}</div>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{t.lead}</span>
              </div>

              {/* Member avatars */}
              <div style={{ display: 'flex', gap: -4, marginBottom: 8 }}>
                {t.members.map((m, mi) => (
                  <div key={mi} style={{ width: 24, height: 24, borderRadius: '50%', background: `${t.color}20`, border: `1.5px solid ${t.color}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 8, fontWeight: 600, color: t.color, marginLeft: mi > 0 ? -6 : 0, zIndex: t.members.length - mi }}>{m}</div>
                ))}
              </div>

              {/* Sprint info */}
              <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>{t.sprint} \u2014 Day {t.day}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: '#fff' }}>{t.velocity} pts/sprint</span>
                <span style={{ fontFamily: M, fontSize: 9, color: t.trend === 'up' ? '#10b981' : '#ef4444' }}>{t.trend === 'up' ? '\u2191' : '\u2193'}</span>
              </div>

              {/* Active objective */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{t.objective}</span>
                  <span style={{ fontFamily: M, fontSize: 8, fontWeight: 600, color: t.color }}>{Math.round(objW)}%</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                  <div style={{ width: `${objW}%`, height: '100%', borderRadius: 2, background: t.color, opacity: 0.7 }} />
                </div>
              </div>

              {/* Health indicators */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {[{ label: 'Build', ok: t.build }, { label: 'Tests', ok: t.tests }, { label: 'Coverage', ok: t.coverage }].map((h, hi) => (
                  <div key={hi} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: h.ok ? '#10b981' : '#f59e0b' }} />
                    <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>{h.label}</span>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 6 }}>
                {['View Board', 'Chat with Team'].map((action, ai) => (
                  <span key={ai} style={{ fontFamily: M, fontSize: 8, padding: '3px 8px', borderRadius: 4, background: ai === 0 ? `${t.color}15` : 'rgba(255,255,255,0.04)', color: ai === 0 ? t.color : 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>{action}</span>
                ))}
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 13. DepartmentKnowledge — Department Knowledge Base
// ═══════════════════════════════════════════════════════════════
export function DepartmentKnowledge() {
  const f = useAnimFrame()
  const [typeFilter, setTypeFilter] = useState('All')
  const reveal = lerp(f, 0, 12, 0, 1)

  const items = [
    { title: 'Deployment runbook', type: 'doc', icon: '\uD83D\uDCC4', views: 23, updated: '2 days ago', author: 'Sarah' },
    { title: 'Architecture diagram', type: 'diagram', icon: '\uD83D\uDCCA', views: 45, updated: '1 week ago', author: 'Alex' },
    { title: 'On-call rotation', type: 'schedule', icon: '\uD83D\uDCC5', views: 18, updated: 'weekly', author: 'Auto' },
    { title: 'CI/CD config', type: 'config', icon: '\u2699', views: 31, updated: '3 days ago', author: 'Mike' },
    { title: 'Post-mortem: March 15 outage', type: 'post-mortem', icon: '\uD83D\uDD0D', views: 12, updated: '10 days ago', author: 'Alex' },
    { title: 'API docs', type: 'doc', icon: '\uD83D\uDCC4', views: 15, updated: '2 weeks ago', author: 'Sarah' },
  ]

  const types = ['All', 'doc', 'diagram', 'schedule', 'config', 'post-mortem']
  const typeColors = { doc: '#3b82f6', diagram: '#a855f7', schedule: '#10b981', config: '#f59e0b', 'post-mortem': '#ef4444' }
  const filtered = typeFilter === 'All' ? items : items.filter(it => it.type === typeFilter)

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Platform Knowledge Base</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>Managed by ARCHIVIST agent \u2014 auto-indexed from team activity</div>
        </div>
        <GP style={{ padding: '4px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>\u2315</span>
            <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Search knowledge...</span>
          </div>
        </GP>
      </div>

      {/* Type filter pills */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
        {types.map(t => {
          const col = typeColors[t] || '#a855f7'
          return (
            <span key={t} onClick={() => setTypeFilter(t)} style={{
              fontFamily: M, fontSize: 8, padding: '3px 10px', borderRadius: 10, cursor: 'pointer', textTransform: t === 'All' ? 'none' : 'capitalize',
              background: typeFilter === t ? `${col}20` : 'rgba(255,255,255,0.04)',
              color: typeFilter === t ? col : 'rgba(255,255,255,0.5)',
              border: `1px solid ${typeFilter === t ? `${col}30` : 'rgba(255,255,255,0.06)'}`,
            }}>{t}</span>
          )
        })}
      </div>

      {/* Knowledge items */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
        {filtered.map((item, i) => {
          const iOp = lerp(f, 5 + i * 1.5, 14 + i * 1.5, 0, 1)
          const col = typeColors[item.type] || '#3b82f6'
          return (
            <GP key={i} style={{ padding: '10px 12px', opacity: iOp, borderTopColor: `${col}20` }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: 6, background: `${col}10`, border: `1px solid ${col}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>{item.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
                  <div style={{ display: 'flex', gap: 8, fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>
                    <span>{item.views} views</span>
                    <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
                    <span>{item.updated}</span>
                  </div>
                  <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>by {item.author}</div>
                </div>
                <span style={{ fontFamily: M, fontSize: 7, padding: '2px 6px', borderRadius: 3, background: `${col}12`, color: col, fontWeight: 600, textTransform: 'capitalize', flexShrink: 0 }}>{item.type}</span>
              </div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 14. DepartmentMetrics — Department Performance Dashboard
// ═══════════════════════════════════════════════════════════════
export function DepartmentMetrics() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)

  const topMetrics = [
    { label: 'Velocity', value: '67', unit: 'pts/sprint', color: '#3b82f6' },
    { label: 'Completion', value: '89', unit: '%', color: '#10b981' },
    { label: 'Cycle Time', value: '2.3', unit: 'days', color: '#06b6d4' },
    { label: 'Quality', value: '94', unit: '%', color: '#a855f7' },
    { label: 'Cost', value: '$56', unit: '/mo', color: '#ec4899' },
  ]

  const velocityData = [52, 58, 61, 63, 65, 67]
  const maxVel = Math.max(...velocityData)

  const donutSegments = [
    { label: 'On time', pct: 78, color: '#10b981' },
    { label: 'Late', pct: 11, color: '#f59e0b' },
    { label: 'Blocked', pct: 5, color: '#ef4444' },
    { label: 'Cancelled', pct: 6, color: 'rgba(255,255,255,0.2)' },
  ]

  const teamBars = [
    { name: 'Alpha', pct: 94, color: '#3b82f6' },
    { name: 'Beta', pct: 87, color: '#10b981' },
    { name: 'Core', pct: 82, color: '#f59e0b' },
  ]

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Platform Metrics</div>
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>Performance dashboard for the Platform department</div>

      {/* Top metrics row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 8 }}>
        {topMetrics.map((m, i) => {
          const mOp = lerp(f, 3 + i * 2, 13 + i * 2, 0, 1)
          return (
            <GP key={i} style={{ padding: '10px 8px', textAlign: 'center', opacity: mOp, borderTopColor: `${m.color}25` }}>
              <div style={{ fontFamily: F, fontSize: 18, fontWeight: 700, color: m.color }}>{m.value}</div>
              <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>{m.unit}</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{m.label}</div>
            </GP>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {/* Velocity area chart */}
        <GP style={{ flex: 2, padding: 12 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>VELOCITY — LAST 6 SPRINTS</div>
          <svg viewBox="0 0 200 60" style={{ width: '100%', height: 60 }}>
            <defs>
              <linearGradient id="orgVelGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {/* Area */}
            <path d={`M0,60 ${velocityData.map((v, i) => `L${i * 40},${60 - (v / maxVel) * lerp(f, 8, 25, 0, 50)}`).join(' ')} L200,60 Z`} fill="url(#orgVelGrad)" />
            {/* Line */}
            <polyline points={velocityData.map((v, i) => `${i * 40},${60 - (v / maxVel) * lerp(f, 8, 25, 0, 50)}`).join(' ')} fill="none" stroke="#3b82f6" strokeWidth="1.5" opacity="0.8" />
            {/* Points */}
            {velocityData.map((v, i) => {
              const py = 60 - (v / maxVel) * lerp(f, 8, 25, 0, 50)
              return <circle key={i} cx={i * 40} cy={py} r={2} fill="#3b82f6" opacity={lerp(f, 10 + i * 2, 18 + i * 2, 0, 1)} />
            })}
            {/* Labels */}
            {velocityData.map((v, i) => (
              <text key={i} x={i * 40} y={55 - (v / maxVel) * lerp(f, 8, 25, 0, 50) + 15} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="6" fontFamily={M}>S{i + 9}</text>
            ))}
          </svg>
        </GP>

        {/* Completion donut */}
        <GP style={{ flex: 1, padding: 12 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 6 }}>COMPLETION</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ position: 'relative', width: 56, height: 56 }}>
              <svg viewBox="0 0 56 56" style={{ width: 56, height: 56 }}>
                {(() => {
                  let cumulative = 0
                  return donutSegments.map((seg, si) => {
                    const dashLen = lerp(f, 8 + si * 3, 22 + si * 3, 0, seg.pct * 1.131)
                    const offset = -cumulative * 1.131 - 28.27
                    cumulative += seg.pct
                    return <circle key={si} cx="28" cy="28" r="18" fill="none" stroke={seg.color} strokeWidth="6" strokeDasharray={`${dashLen} 999`} strokeDashoffset={offset} transform="rotate(-90 28 28)" />
                  })
                })()}
              </svg>
            </div>
            <div>
              {donutSegments.map((seg, si) => (
                <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: seg.color }} />
                  <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.5)' }}>{seg.label} {seg.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </GP>
      </div>

      {/* Team comparison + AI insight */}
      <div style={{ display: 'flex', gap: 8 }}>
        <GP style={{ flex: 1, padding: 12 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>TEAM COMPARISON</div>
          {teamBars.map((t, i) => {
            const bW = lerp(f, 12 + i * 3, 26 + i * 3, 0, t.pct)
            return (
              <div key={i} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontFamily: F, fontSize: 10, color: '#fff' }}>{t.name}</span>
                  <span style={{ fontFamily: M, fontSize: 9, fontWeight: 600, color: t.color }}>{Math.round(bW)}%</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                  <div style={{ width: `${bW}%`, height: '100%', borderRadius: 3, background: t.color, opacity: 0.7 }} />
                </div>
              </div>
            )
          })}
        </GP>
        <GP style={{ flex: 1, padding: 12, borderTopColor: 'rgba(6,182,212,0.2)' }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 6 }}>AI INSIGHT</div>
          <div style={{ fontFamily: F, fontSize: 10, color: '#06b6d4', lineHeight: 1.5 }}>Platform dept is 12% above org average. Team Beta needs support \u2014 velocity dropped 15% this sprint. Consider pairing Beta with Core for the OAuth migration.</div>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.35)', marginTop: 6 }}>Generated by METRICS agent \u2022 confidence: 87%</div>
        </GP>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 15. DepartmentRBAC — Access Control Panel
// ═══════════════════════════════════════════════════════════════
export function DepartmentRBAC() {
  const f = useAnimFrame()
  const reveal = lerp(f, 0, 12, 0, 1)

  const roles = [
    { role: 'Admin', count: 2, people: ['Alex Chen', 'Sarah Wu'], badge: 'Full access', color: '#a855f7' },
    { role: 'Editor', count: 5, people: ['Tom Baker', 'Emily Zhang', 'James Riley', 'Priya Patel', 'Marcus Cole'], badge: 'Can modify objectives, manage teams', color: '#3b82f6' },
    { role: 'Agent', count: 3, people: ['WARDEN', 'VULCAN', 'CODEX'], badge: 'Scoped to department tasks', color: '#10b981' },
    { role: 'Viewer', count: 4, people: ['David Okonkwo', 'Nina Volkov', 'Chris Tanaka', 'Lisa Park'], badge: 'Read-only access', color: 'rgba(255,255,255,0.4)' },
  ]

  const resources = ['Objectives', 'Teams', 'Knowledge', 'Config', 'Agents', 'Budget']
  const permissions = {
    Admin:  [true, true, true, true, true, true],
    Editor: [true, true, true, false, false, false],
    Agent:  [true, false, true, false, false, false],
    Viewer: [false, false, true, false, false, false],
  }

  const totalPeople = roles.filter(r => r.role !== 'Agent').reduce((s, r) => s + r.count, 0)
  const totalAgents = roles.find(r => r.role === 'Agent')?.count || 0

  return (
    <div style={{ opacity: reveal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Access Control</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{totalPeople} members | {totalAgents} agents | {roles.length} roles</div>
        </div>
        <span style={{ fontFamily: M, fontSize: 8, padding: '3px 8px', borderRadius: 4, background: 'rgba(168,85,247,0.12)', color: '#a855f7', fontWeight: 600 }}>RBAC enforced by AOCL policy layer</span>
      </div>

      {/* Role rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
        {roles.map((r, i) => {
          const rOp = lerp(f, 3 + i * 2, 13 + i * 2, 0, 1)
          return (
            <GP key={i} style={{ padding: '8px 12px', opacity: rOp, borderTopColor: `${r.color}20` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 60, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: r.color }}>{r.role}</span>
                  <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>({r.count})</span>
                </div>
                <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {r.people.map((p, pi) => (
                    <span key={pi} style={{ fontFamily: M, fontSize: 8, padding: '2px 8px', borderRadius: 4, background: r.role === 'Agent' ? `${r.color}12` : 'rgba(255,255,255,0.04)', color: r.role === 'Agent' ? r.color : 'rgba(255,255,255,0.6)' }}>{p}</span>
                  ))}
                </div>
                <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap', flexShrink: 0 }}>{r.badge}</span>
              </div>
            </GP>
          )
        })}
      </div>

      {/* Permission matrix */}
      <GP style={{ padding: 12 }}>
        <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, marginBottom: 8 }}>PERMISSION MATRIX</div>
        <div style={{ display: 'grid', gridTemplateColumns: `70px repeat(${resources.length}, 1fr)`, gap: 0 }}>
          {/* Header */}
          <div />
          {resources.map((res, ri) => (
            <div key={ri} style={{ textAlign: 'center', paddingBottom: 6, fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>{res}</div>
          ))}
          {/* Role rows */}
          {roles.map((r, ri) => {
            const perms = permissions[r.role] || []
            return [
              <div key={`r-${ri}`} style={{ fontFamily: M, fontSize: 9, color: r.color, fontWeight: 600, padding: '4px 0' }}>{r.role}</div>,
              ...perms.map((has, pi) => (
                <div key={`p-${ri}-${pi}`} style={{ textAlign: 'center', padding: '4px 0', fontFamily: M, fontSize: 10, color: has ? '#10b981' : 'rgba(255,255,255,0.15)' }}>{has ? '\u2713' : '\u25CB'}</div>
              ))
            ]
          }).flat()}
        </div>
      </GP>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// COMMANDERQ CORE VISUALISER — 6 Variations
// The face of QuoxCORE. Q letterform centre, agents orbiting,
// cognitive core represented minimally, blue-violet aura.
// ═══════════════════════════════════════════════════════════════

const CVQ_AGENTS = [
  { id: 'sentinel', name: 'WARDEN', color: '#10b981' },
  { id: 'forge', name: 'VULCAN', color: '#3b82f6' },
  { id: 'nova', name: 'DAEDALUS', color: '#a855f7' },
  { id: 'cipher', name: 'CIPHER', color: '#f59e0b' },
  { id: 'atlas', name: 'HYPERION', color: '#6366f1' },
  { id: 'codex', name: 'CODEX', color: '#ec4899' },
  { id: 'herald', name: 'HERALD', color: '#06b6d4' },
  { id: 'keeper', name: 'KEEPER', color: '#14b8a6' },
]

const CVQ_CORE = [
  { id: 'memory', label: 'Memory', color: '#38bdf8' },
  { id: 'tools', label: 'Tools', color: '#f59e0b' },
  { id: 'protocols', label: 'Protocols', color: '#a855f7' },
  { id: 'context', label: 'Context', color: '#10b981' },
]

const CVQ_PROTOCOLS = ['AEE', 'AOCL', 'VOLT', 'WARD']

// ─── Q Letterform SVG (shared across all 6) ───
const QMark = ({ size = 48, opacity = 1, shimmer = 0 }) => (
  <g opacity={opacity}>
    <defs>
      <linearGradient id="qcvGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#38bdf8" />
        <stop offset="50%" stopColor="#6366f1" />
        <stop offset="100%" stopColor="#a855f7" />
      </linearGradient>
      {shimmer > 0 && <linearGradient id="qcvShimmer" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#fff" stopOpacity={0} />
        <stop offset={`${shimmer * 100}%`} stopColor="#fff" stopOpacity={0.3} />
        <stop offset="100%" stopColor="#fff" stopOpacity={0} />
      </linearGradient>}
    </defs>
    <text
      textAnchor="middle"
      dominantBaseline="central"
      fill="url(#qcvGrad)"
      fontSize={size}
      fontFamily="'Inter',system-ui,sans-serif"
      fontWeight={800}
      letterSpacing="-1"
    >Q</text>
    {shimmer > 0 && <text
      textAnchor="middle"
      dominantBaseline="central"
      fill="url(#qcvShimmer)"
      fontSize={size}
      fontFamily="'Inter',system-ui,sans-serif"
      fontWeight={800}
      letterSpacing="-1"
    >Q</text>}
  </g>
)

// ═══════════════════════════════════════════════════════════════
// 1. CoreVizMinimal — Clean Minimal Version
// ═══════════════════════════════════════════════════════════════
export function CoreVizMinimal() {
  const f = useAnimFrame()
  const size = 300, cx = size / 2, cy = size / 2
  const breathe = 1.0 + Math.sin(f * 0.05) * 0.02
  const agents = CVQ_AGENTS.slice(0, 5)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }}>
        {/* Radial gradient background */}
        <defs>
          <radialGradient id="cvmBg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="100%" stopColor="rgba(99,102,241,0.08)" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={cx} fill="url(#cvmBg)" />

        {/* Orbital ring */}
        <circle cx={cx} cy={cy} r={80} fill="none" stroke="rgba(99,102,241,0.12)" strokeWidth={1} strokeDasharray="4 6" />

        {/* Agent dots orbiting */}
        {agents.map((a, i) => {
          const angle = (i / agents.length) * Math.PI * 2 + f * 0.012
          const ax = cx + Math.cos(angle) * 80
          const ay = cy + Math.sin(angle) * 80
          const pulse = 0.5 + Math.sin(f * 0.06 + i * 1.2) * 0.3
          return (
            <g key={a.id}>
              <circle cx={ax} cy={ay} r={4} fill={a.color} opacity={pulse} />
              <circle cx={ax} cy={ay} r={7} fill="none" stroke={a.color} strokeWidth={0.5} opacity={pulse * 0.4} />
            </g>
          )
        })}

        {/* Centre Q letterform with breathing */}
        <g transform={`translate(${cx},${cy}) scale(${breathe})`}>
          <QMark size={48} />
        </g>
      </svg>
      <div style={{ fontFamily: M, fontSize: 10, color: '#06b6d4', letterSpacing: 2, opacity: 0.6 + Math.sin(f * 0.04) * 0.2 }}>LISTENING</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 2. CoreVizConstellation — Agent Constellation
// ═══════════════════════════════════════════════════════════════
export function CoreVizConstellation() {
  const f = useAnimFrame()
  const size = 400, cx = size / 2, cy = size / 2
  const breathe = 1.0 + Math.sin(f * 0.04) * 0.015
  const activeAgents = [0, 3] // WARDEN and CIPHER active

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }}>
        {/* Blue-violet lens */}
        <defs>
          <radialGradient id="cvcLens" cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor="rgba(99,102,241,0.15)" />
            <stop offset="60%" stopColor="rgba(168,85,247,0.08)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
        </defs>
        <ellipse cx={cx} cy={cy} rx={cx * 0.95} ry={cy * 0.95} fill="url(#cvcLens)" />

        {/* Inner ring — core systems */}
        <circle cx={cx} cy={cy} r={50} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={0.8} />
        {CVQ_CORE.map((c, i) => {
          const angle = (i / CVQ_CORE.length) * Math.PI * 2 - Math.PI / 2 + f * 0.008
          const px = cx + Math.cos(angle) * 50
          const py = cy + Math.sin(angle) * 50
          return (
            <g key={c.id}>
              {/* Connection line from Q to core */}
              <line x1={cx} y1={cy} x2={px} y2={py} stroke={c.color} strokeWidth={0.5} opacity={0.15} />
              <circle cx={px} cy={py} r={3.5} fill={c.color} opacity={0.7} />
              <text x={px} y={py + 12} textAnchor="middle" fill={c.color} fontSize={7} fontFamily={M} opacity={0.6}>{c.label}</text>
            </g>
          )
        })}

        {/* Outer ring — agents */}
        <circle cx={cx} cy={cy} r={100} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={0.8} strokeDasharray="3 7" />
        {CVQ_AGENTS.map((a, i) => {
          const angle = (i / CVQ_AGENTS.length) * Math.PI * 2 - Math.PI / 2 + f * 0.005
          const ax = cx + Math.cos(angle) * 100
          const ay = cy + Math.sin(angle) * 100
          const isActive = activeAgents.includes(i)
          const pulse = isActive ? (0.8 + Math.sin(f * 0.1 + i) * 0.2) : 0.35
          return (
            <g key={a.id}>
              <circle cx={ax} cy={ay} r={isActive ? 5 : 3.5} fill={a.color} opacity={pulse} />
              {isActive && <circle cx={ax} cy={ay} r={9} fill="none" stroke={a.color} strokeWidth={0.8} opacity={0.3 + Math.sin(f * 0.08) * 0.2} />}
              <text x={ax} y={ay - 10} textAnchor="middle" fill={a.color} fontSize={7} fontFamily={M} opacity={isActive ? 0.8 : 0.45} fontWeight={isActive ? 600 : 400}>{a.name}</text>
            </g>
          )
        })}

        {/* Delegation arcs to active agents */}
        {activeAgents.map((ai, di) => {
          const angle = (ai / CVQ_AGENTS.length) * Math.PI * 2 - Math.PI / 2 + f * 0.005
          const ax = cx + Math.cos(angle) * 100
          const ay = cy + Math.sin(angle) * 100
          const travelT = ((f * 0.03 + di * 0.5) % 1)
          const tx = cx + (ax - cx) * travelT
          const ty = cy + (ay - cy) * travelT
          return (
            <g key={`arc-${di}`}>
              <line x1={cx} y1={cy} x2={ax} y2={ay} stroke="#06b6d4" strokeWidth={1} opacity={0.25} strokeDasharray="3 4" />
              <circle cx={tx} cy={ty} r={2} fill="#06b6d4" opacity={0.8} />
              <circle cx={tx} cy={ty} r={5} fill="#06b6d4" opacity={0.15} />
            </g>
          )
        })}

        {/* Centre Q */}
        <g transform={`translate(${cx},${cy}) scale(${breathe})`}>
          <circle r={20} fill="rgba(99,102,241,0.08)" />
          <QMark size={36} />
        </g>
      </svg>
      <div style={{ fontFamily: M, fontSize: 10, letterSpacing: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ color: '#a855f7', opacity: 0.8 }}>PROCESSING</span>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>{'\u2014'}</span>
        <span style={{ color: 'rgba(255,255,255,0.6)' }}>2 agents active</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 3. CoreVizPulse — Pulsing Energy Core
// ═══════════════════════════════════════════════════════════════
export function CoreVizPulse() {
  const f = useAnimFrame()
  const size = 350, cx = size / 2, cy = size / 2
  const breathe = 1.0 + Math.sin(f * 0.04) * 0.02
  const pulseAgents = CVQ_AGENTS.slice(0, 6)
  const activeIdx = 0 // WARDEN active

  // Pulse waves expand from centre
  const pulseWaves = [0, 1, 2].map(i => {
    const t = ((f * 0.015 + i * 0.33) % 1)
    return { r: 20 + t * 120, opacity: (1 - t) * 0.25 }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }}>
        {/* Blue-violet gradient lens */}
        <defs>
          <radialGradient id="cvpLens" cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor="rgba(99,102,241,0.12)" />
            <stop offset="50%" stopColor="rgba(168,85,247,0.06)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
        </defs>
        <ellipse cx={cx} cy={cy} rx={cx * 0.95} ry={cy * 0.95} fill="url(#cvpLens)" />

        {/* Pulse waves (sonar ping) */}
        {pulseWaves.map((pw, i) => (
          <circle key={`pw-${i}`} cx={cx} cy={cy} r={pw.r} fill="none" stroke="#6366f1" strokeWidth={1.2} opacity={pw.opacity} />
        ))}

        {/* Zone 2 — identity zone, faint hex pattern + protocol badges */}
        <circle cx={cx} cy={cy} r={80} fill="none" stroke="rgba(99,102,241,0.06)" strokeWidth={0.5} />
        {CVQ_PROTOCOLS.map((p, i) => {
          const angle = (i / CVQ_PROTOCOLS.length) * Math.PI * 2 - Math.PI / 2 + f * 0.006
          const px = cx + Math.cos(angle) * 60
          const py = cy + Math.sin(angle) * 60
          return (
            <g key={p}>
              <rect x={px - 14} y={py - 6} width={28} height={12} rx={3} fill="rgba(99,102,241,0.1)" stroke="rgba(99,102,241,0.2)" strokeWidth={0.5} />
              <text x={px} y={py + 1} textAnchor="middle" dominantBaseline="central" fill="rgba(255,255,255,0.6)" fontSize={7} fontFamily={M} fontWeight={600}>{p}</text>
            </g>
          )
        })}

        {/* Zone 3 — agent zone ring */}
        <circle cx={cx} cy={cy} r={120} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={0.8} strokeDasharray="2 6" />
        {pulseAgents.map((a, i) => {
          const angle = (i / pulseAgents.length) * Math.PI * 2 - Math.PI / 2 + f * 0.004
          const ax = cx + Math.cos(angle) * 120
          const ay = cy + Math.sin(angle) * 120
          const isActive = i === activeIdx
          const op = isActive ? 0.9 : (0.35 + Math.sin(f * 0.05 + i * 0.9) * 0.15)
          return (
            <g key={a.id}>
              {/* Faint arcs between adjacent agents */}
              {i < pulseAgents.length - 1 && (() => {
                const nAngle = ((i + 1) / pulseAgents.length) * Math.PI * 2 - Math.PI / 2 + f * 0.004
                const nx = cx + Math.cos(nAngle) * 120
                const ny = cy + Math.sin(nAngle) * 120
                return <line x1={ax} y1={ay} x2={nx} y2={ny} stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} />
              })()}
              <circle cx={ax} cy={ay} r={isActive ? 5 : 4} fill={a.color} opacity={op} />
              {isActive && <>
                <circle cx={ax} cy={ay} r={10} fill="none" stroke={a.color} strokeWidth={1} opacity={0.3 + Math.sin(f * 0.1) * 0.2} />
                <circle cx={ax} cy={ay} r={14} fill="none" stroke={a.color} strokeWidth={0.5} opacity={0.15 + Math.sin(f * 0.12) * 0.1} />
              </>}
              <text x={ax} y={ay - 10} textAnchor="middle" fill={a.color} fontSize={7} fontFamily={M} opacity={isActive ? 0.8 : 0.4}>{a.name}</text>
            </g>
          )
        })}

        {/* Zone 1 — Q core, bright, solid */}
        <g transform={`translate(${cx},${cy}) scale(${breathe})`}>
          <circle r={25} fill="rgba(99,102,241,0.06)" />
          <circle r={15} fill="rgba(56,189,248,0.04)" />
          <QMark size={38} />
        </g>
      </svg>
      <div style={{ fontFamily: M, fontSize: 10, letterSpacing: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ color: '#10b981', opacity: 0.8 }}>ACTIVE</span>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>{'\u2014'}</span>
        <span style={{ color: 'rgba(255,255,255,0.6)' }}>Objective running</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 4. CoreVizHUD — HUD Overlay Style
// ═══════════════════════════════════════════════════════════════
export function CoreVizHUD() {
  const f = useAnimFrame()
  const size = 400, cx = size / 2, cy = size / 2
  const breathe = 1.0 + Math.sin(f * 0.04) * 0.01
  const scanY = ((f * 0.008) % 1) * size

  const readouts = [
    { label: 'AGENTS', value: '8/16', x: cx, y: 42, color: '#38bdf8' },
    { label: 'MEMORY', value: '8.2K', x: size - 42, y: cy, color: '#a855f7' },
    { label: 'TOKENS', value: '1.2K/hr', x: cx, y: size - 36, color: '#06b6d4' },
    { label: 'OBJECTIVES', value: '3', x: 50, y: cy, color: '#10b981' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }}>
        {/* Blue-violet lens with subtle grid */}
        <defs>
          <radialGradient id="cvhLens" cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor="rgba(99,102,241,0.1)" />
            <stop offset="60%" stopColor="rgba(168,85,247,0.05)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
          <pattern id="cvhGrid" width="20" height="20" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="20" y2="0" stroke="rgba(99,102,241,0.03)" strokeWidth="0.5" />
            <line x1="0" y1="0" x2="0" y2="20" stroke="rgba(99,102,241,0.03)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={size} height={size} fill="url(#cvhGrid)" />
        <ellipse cx={cx} cy={cy} rx={cx * 0.9} ry={cy * 0.9} fill="url(#cvhLens)" />

        {/* Corner brackets */}
        {[[15, 15, 1, 1], [size - 15, 15, -1, 1], [15, size - 15, 1, -1], [size - 15, size - 15, -1, -1]].map(([bx, by, dx, dy], i) => (
          <g key={`bracket-${i}`} opacity={0.25}>
            <line x1={bx} y1={by} x2={bx + dx * 20} y2={by} stroke="#38bdf8" strokeWidth={1} />
            <line x1={bx} y1={by} x2={bx} y2={by + dy * 20} stroke="#38bdf8" strokeWidth={1} />
          </g>
        ))}

        {/* Targeting reticle around Q */}
        <line x1={cx - 40} y1={cy} x2={cx - 18} y2={cy} stroke="rgba(56,189,248,0.2)" strokeWidth={0.8} />
        <line x1={cx + 18} y1={cy} x2={cx + 40} y2={cy} stroke="rgba(56,189,248,0.2)" strokeWidth={0.8} />
        <line x1={cx} y1={cy - 40} x2={cx} y2={cy - 18} stroke="rgba(56,189,248,0.2)" strokeWidth={0.8} />
        <line x1={cx} y1={cy + 18} x2={cx} y2={cy + 40} stroke="rgba(56,189,248,0.2)" strokeWidth={0.8} />
        <circle cx={cx} cy={cy} r={30} fill="none" stroke="rgba(56,189,248,0.1)" strokeWidth={0.5} />

        {/* Scanning line */}
        <line x1={30} y1={scanY} x2={size - 30} y2={scanY} stroke="rgba(56,189,248,0.08)" strokeWidth={1} />
        <line x1={30} y1={scanY} x2={size - 30} y2={scanY} stroke="rgba(56,189,248,0.2)" strokeWidth={0.3} />

        {/* Orbital ring with agent dots */}
        <circle cx={cx} cy={cy} r={100} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={0.8} strokeDasharray="2 5" />
        {CVQ_AGENTS.map((a, i) => {
          const angle = (i / CVQ_AGENTS.length) * Math.PI * 2 - Math.PI / 2 + f * 0.005
          const ax = cx + Math.cos(angle) * 100
          const ay = cy + Math.sin(angle) * 100
          const op = 0.4 + Math.sin(f * 0.06 + i * 0.8) * 0.2
          return <circle key={a.id} cx={ax} cy={ay} r={3} fill={a.color} opacity={op} />
        })}

        {/* Data readouts at compass points */}
        {readouts.map((r, i) => (
          <g key={`ro-${i}`}>
            <text x={r.x} y={r.y - 6} textAnchor="middle" fill="rgba(255,255,255,0.45)" fontSize={7} fontFamily={M} letterSpacing={1}>{r.label}</text>
            <text x={r.x} y={r.y + 6} textAnchor="middle" fill={r.color} fontSize={12} fontFamily={M} fontWeight={700}>{r.value}</text>
            {/* Mini bar for AGENTS readout */}
            {r.label === 'AGENTS' && <rect x={r.x - 20} y={r.y + 12} width={40 * (8 / 16)} height={2} rx={1} fill={r.color} opacity={0.5} />}
          </g>
        ))}

        {/* Centre Q */}
        <g transform={`translate(${cx},${cy}) scale(${breathe})`}>
          <QMark size={40} />
        </g>
      </svg>
      <div style={{ fontFamily: M, fontSize: 8, letterSpacing: 1.5, display: 'flex', gap: 8, alignItems: 'center', color: 'rgba(255,255,255,0.45)' }}>
        <span>QUOXCORE v2.0</span>
        <span style={{ color: '#10b981', fontSize: 6 }}>{'\u25CF'}</span>
        <span>CONNECTED</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 5. CoreVizNebula — Organic/Nebula Style
// ═══════════════════════════════════════════════════════════════
export function CoreVizNebula() {
  const f = useAnimFrame()
  const w = 400, h = 350, cx = w / 2, cy = h / 2
  const breathe = 1.0 + Math.sin(f * 0.03) * 0.015

  // Agent nodes with gentle organic drift (Brownian motion)
  const agentPos = CVQ_AGENTS.map((a, i) => {
    const baseAngle = (i / CVQ_AGENTS.length) * Math.PI * 2
    const baseR = 60 + (i % 3) * 25
    const drift = Math.sin(f * 0.013 + i * 2.1) * 12 + Math.cos(f * 0.017 + i * 1.7) * 8
    const driftA = Math.sin(f * 0.009 + i * 3.2) * 0.2
    const r = baseR + drift
    return {
      ...a,
      x: cx + Math.cos(baseAngle + driftA) * r,
      y: cy + Math.sin(baseAngle + driftA) * r,
    }
  })

  // Particles drifting through nebula
  const particles = Array.from({ length: 12 }, (_, i) => {
    const px = cx + Math.sin(f * 0.008 + i * 5.3) * (100 + i * 8) + Math.cos(f * 0.012 + i * 3.1) * 30
    const py = cy + Math.cos(f * 0.009 + i * 4.7) * (80 + i * 6) + Math.sin(f * 0.011 + i * 2.9) * 25
    return { x: px % w, y: py % h, op: 0.15 + Math.sin(f * 0.04 + i * 1.1) * 0.1 }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative', width: w, height: h }}>
        {/* Nebula background — layered gradients */}
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 12,
          background: [
            'radial-gradient(ellipse at 40% 45%, rgba(56,189,248,0.2), transparent 60%)',
            'radial-gradient(ellipse at 65% 55%, rgba(168,85,247,0.15), transparent 55%)',
            'radial-gradient(ellipse at 50% 50%, rgba(99,102,241,0.1), transparent 70%)',
          ].join(','),
        }} />

        <svg viewBox={`0 0 ${w} ${h}`} style={{ position: 'relative', width: w, height: h }}>
          {/* Floating particles */}
          {particles.map((p, i) => (
            <circle key={`p-${i}`} cx={p.x} cy={p.y} r={1.2} fill="#fff" opacity={p.op} />
          ))}

          {/* Neural web connections between nearby agents */}
          {agentPos.map((a, i) => agentPos.slice(i + 1).map((b, j) => {
            const dist = Math.hypot(a.x - b.x, a.y - b.y)
            if (dist < 130) {
              const op = Math.max(0, (130 - dist) / 130) * 0.08
              return <line key={`c-${i}-${j}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(255,255,255,1)" strokeWidth={0.5} opacity={op} />
            }
            return null
          }))}

          {/* Agent nodes floating in nebula */}
          {agentPos.map((a, i) => {
            const op = 0.5 + Math.sin(f * 0.04 + i * 1.5) * 0.2
            return (
              <g key={a.id}>
                <circle cx={a.x} cy={a.y} r={10} fill={a.color} opacity={0.06} />
                <circle cx={a.x} cy={a.y} r={4} fill={a.color} opacity={op} />
                <text x={a.x} y={a.y - 9} textAnchor="middle" fill={a.color} fontSize={7} fontFamily={M} opacity={op * 0.7}>{a.name}</text>
              </g>
            )
          })}

          {/* Centre Q with soft glow */}
          <circle cx={cx} cy={cy} r={30} fill="rgba(99,102,241,0.06)" />
          <circle cx={cx} cy={cy} r={18} fill="rgba(56,189,248,0.04)" />
          <g transform={`translate(${cx},${cy}) scale(${breathe})`}>
            <QMark size={40} shimmer={(f * 0.005) % 1} />
          </g>
        </svg>
      </div>
      <div style={{ fontFamily: M, fontSize: 10, letterSpacing: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ color: 'rgba(255,255,255,0.5)', opacity: 0.6 + Math.sin(f * 0.03) * 0.15 }}>IDLE {'\u2014'} awaiting instruction</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 6. CoreVizMatrix — Matrix/Data Stream Style
// ═══════════════════════════════════════════════════════════════
export function CoreVizMatrix() {
  const f = useAnimFrame()
  const w = 400, h = 350, cx = w / 2, cy = h / 2
  const breathe = 1.0 + Math.sin(f * 0.04) * 0.01

  // Data stream columns behind Q
  const streams = Array.from({ length: 8 }, (_, i) => {
    const sx = 50 + i * (w - 100) / 7
    const chars = '01QXAB'
    const offset = (f * 0.04 + i * 3) % 10
    return { x: sx, chars, offset }
  })

  // Agent squares (digital feel)
  const agents = CVQ_AGENTS.map((a, i) => {
    const angle = (i / CVQ_AGENTS.length) * Math.PI * 2 - Math.PI / 2 + f * 0.004
    const r = 110
    return { ...a, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, angle }
  })

  // Active agents (pulse with scan line)
  const activeIdxs = [0, 2, 5]

  // Protocol badges orbiting
  const protocolR = 70

  // Horizontal data bands
  const bands = [0.3, 0.55, 0.75]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: w, height: h }}>
        {/* Blue lens — more blue-heavy */}
        <defs>
          <radialGradient id="cvxLens" cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor="rgba(56,189,248,0.1)" />
            <stop offset="50%" stopColor="rgba(99,102,241,0.07)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
        </defs>
        <rect width={w} height={h} fill="url(#cvxLens)" rx={8} />

        {/* Vertical data streams (very subtle) */}
        {streams.map((s, si) => (
          <g key={`s-${si}`} opacity={0.08}>
            {Array.from({ length: 12 }, (_, ci) => {
              const charY = ((s.offset + ci * 0.8) % 12) * 28
              const ch = s.chars[Math.floor((f * 0.1 + ci + si * 3) % s.chars.length)]
              return <text key={ci} x={s.x} y={charY} textAnchor="middle" fill="#38bdf8" fontSize={9} fontFamily={M}>{ch}</text>
            })}
          </g>
        ))}

        {/* Horizontal data bands */}
        {bands.map((b, bi) => {
          const by = b * h
          const bw = 40 + Math.sin(f * 0.05 + bi * 2) * 20
          const bx = cx - bw / 2 + Math.sin(f * 0.03 + bi * 1.5) * 30
          return <rect key={`band-${bi}`} x={bx} y={by - 1} width={bw} height={2} rx={1} fill="#38bdf8" opacity={0.08 + Math.sin(f * 0.06 + bi) * 0.04} />
        })}

        {/* Agent ring — squares, not circles */}
        <circle cx={cx} cy={cy} r={110} fill="none" stroke="rgba(56,189,248,0.05)" strokeWidth={0.5} strokeDasharray="4 8" />
        {agents.map((a, i) => {
          const isActive = activeIdxs.includes(i)
          const op = isActive ? (0.7 + Math.sin(f * 0.08 + i) * 0.2) : 0.3
          const s = isActive ? 7 : 5
          // Scan line on active agents
          const scanOp = isActive ? (0.4 + Math.sin(f * 0.12 + i * 0.5) * 0.3) : 0
          return (
            <g key={a.id}>
              <rect x={a.x - s / 2} y={a.y - s / 2} width={s} height={s} fill={a.color} opacity={op} rx={1} />
              {isActive && <rect x={a.x - s} y={a.y - 0.5} width={s * 2} height={1} fill={a.color} opacity={scanOp} />}
              <text x={a.x} y={a.y - 8} textAnchor="middle" fill={a.color} fontSize={7} fontFamily={M} opacity={isActive ? 0.7 : 0.35} fontWeight={isActive ? 600 : 400}>{a.name}</text>
            </g>
          )
        })}

        {/* Connection lines — dashed for digital feel */}
        {activeIdxs.map((ai, di) => {
          const a = agents[ai]
          return <line key={`conn-${di}`} x1={cx} y1={cy} x2={a.x} y2={a.y} stroke={a.color} strokeWidth={0.5} opacity={0.15} strokeDasharray="3 5" />
        })}

        {/* Protocol badges orbiting */}
        {CVQ_PROTOCOLS.map((p, i) => {
          const angle = (i / CVQ_PROTOCOLS.length) * Math.PI * 2 + f * 0.007
          const px = cx + Math.cos(angle) * protocolR
          const py = cy + Math.sin(angle) * protocolR
          return (
            <g key={`proto-${i}`}>
              <rect x={px - 14} y={py - 6} width={28} height={12} rx={2} fill="rgba(56,189,248,0.06)" stroke="rgba(56,189,248,0.15)" strokeWidth={0.5} />
              <text x={px} y={py + 1} textAnchor="middle" dominantBaseline="central" fill="rgba(255,255,255,0.5)" fontSize={7} fontFamily={M} fontWeight={600}>{p}</text>
            </g>
          )
        })}

        {/* Centre Q — monospace digital shimmer */}
        <g transform={`translate(${cx},${cy}) scale(${breathe})`}>
          <circle r={22} fill="rgba(56,189,248,0.04)" />
          <QMark size={38} shimmer={(f * 0.008) % 1} />
        </g>
      </svg>
      <div style={{ fontFamily: M, fontSize: 10, letterSpacing: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ color: '#38bdf8', opacity: 0.8 }}>EXECUTING</span>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>{'\u2014'}</span>
        <span style={{ color: 'rgba(255,255,255,0.6)' }}>3 tasks in pipeline</span>
      </div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// INBOXQ — Deep Email Intelligence (5 components)
// ═══════════════════════════════════════════════════════════════

// ─── IQ1. InboxQFullPage — Full Inbox Dashboard ───
const IQ_ACCOUNTS = [
  { email: 'admin@example.com', unread: 12, total: 847, provider: 'IMAP', color: '#3b82f6', health: 'connected' },
  { email: 'support@example.com', unread: 31, total: 2104, provider: 'IMAP', color: '#a855f7', health: 'connected' },
  { email: 'billing@example.com', unread: 3, total: 412, provider: 'IMAP', color: '#10b981', health: 'connected' },
  { email: 'hr@example.com', unread: 0, total: 89, provider: 'Google', color: '#f59e0b', health: 'syncing' },
]
const IQ_THREADS = [
  { id: 1, from: 'Sarah Chen', subject: 'Q2 Partnership Proposal — Response Needed', preview: '$50K joint AI governance toolkit. Legal reviewed, awaiting your sign-off.', time: '10:42', labels: ['urgent', 'partnership'], starred: true, attachments: 1, account: 'admin@example.com' },
  { id: 2, from: 'Hetzner Billing', subject: 'Invoice #HZ-2026-0341 — EUR 847.50', preview: 'Monthly infrastructure invoice. Auto-pay scheduled for 28th.', time: '09:15', labels: ['billing'], starred: false, attachments: 1, account: 'billing@example.com' },
  { id: 3, from: 'GitHub Actions', subject: '[quoxai/quox] Run failed — main #1247', preview: 'vitest test suite: 2 failures in collector/chat.test.js', time: '08:30', labels: ['ci'], starred: false, attachments: 0, account: 'admin@example.com' },
  { id: 4, from: 'Board Secretary', subject: 'Emergency Board Vote Required', preview: 'Acquisition approval needed. Deadline: 5pm today. Quorum requires 4/5.', time: '07:55', labels: ['urgent', 'board'], starred: true, attachments: 2, account: 'admin@example.com' },
  { id: 5, from: 'Customer (Ticket #891)', subject: 'Cannot access dashboard after SSO change', preview: 'User reports 403 after org migrated to SAML. Needs credential re-link.', time: 'Yesterday', labels: ['support'], starred: false, attachments: 0, account: 'support@example.com' },
]
const IQ_LABEL_COLORS = { urgent: '#ef4444', partnership: '#a855f7', billing: '#10b981', ci: '#f59e0b', board: '#ec4899', support: '#06b6d4' }

export function InboxQFullPage() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#fff' }}>{'\u2709'}</div>
          <div>
            <div style={{ fontFamily: F, fontSize: 15, fontWeight: 700, color: '#fff' }}>Inbox-Q — Email Intelligence Centre</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>4 inboxes connected — 46 unread across all accounts</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['Triage All', 'Compose', 'Rules'].map((a, i) => (
            <div key={i} style={{ padding: '5px 12px', borderRadius: 6, background: i === 0 ? '#3b82f620' : 'rgba(255,255,255,0.04)', border: `1px solid ${i === 0 ? '#3b82f630' : 'rgba(255,255,255,0.08)'}`, fontFamily: M, fontSize: 9, color: i === 0 ? '#3b82f6' : 'rgba(255,255,255,0.6)', fontWeight: 600, cursor: 'pointer' }}>{a}</div>
          ))}
        </div>
      </div>

      {/* Account Strip */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {IQ_ACCOUNTS.map((acc, i) => {
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          return (
            <GP key={i} style={{ flex: 1, padding: '8px 10px', borderTopColor: `${acc.color}30`, opacity: op }}>
              <div style={{ fontFamily: M, fontSize: 9, color: acc.color, fontWeight: 700, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.email}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: F, fontSize: 10, color: '#fff', fontWeight: 600 }}>{acc.unread} unread</span>
                <span style={{ fontFamily: M, fontSize: 8, color: acc.health === 'connected' ? '#30ff90' : '#f59e0b' }}>{acc.health === 'connected' ? '\u2713' : '\u21BB'} {acc.provider}</span>
              </div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>{acc.total.toLocaleString()} total</div>
            </GP>
          )
        })}
      </div>

      {/* Thread List */}
      <div style={{ marginBottom: 12 }}>
        {IQ_THREADS.map((t, i) => {
          const op = lerp(f, 8 + i * 2, 10 + i * 2 + 6, 0, 1)
          return (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', marginBottom: 3, borderRadius: 8, background: t.starred ? 'rgba(255,255,255,0.03)' : 'transparent', border: '1px solid rgba(255,255,255,0.04)', opacity: op, cursor: 'pointer' }}>
              <span style={{ fontSize: 12, opacity: t.starred ? 1 : 0.3, flexShrink: 0 }}>{t.starred ? '\u2605' : '\u2606'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff' }}>{t.from}</span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {t.labels.map((l, li) => (
                      <span key={li} style={{ fontFamily: M, fontSize: 7, padding: '1px 5px', borderRadius: 3, background: `${IQ_LABEL_COLORS[l] || '#666'}15`, color: IQ_LABEL_COLORS[l] || '#666', fontWeight: 600 }}>{l}</span>
                    ))}
                  </div>
                </div>
                <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 1 }}>{t.subject}</div>
                <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.preview}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{t.time}</div>
                {t.attachments > 0 && <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>{'\uD83D\uDCCE'} {t.attachments}</div>}
              </div>
            </div>
          )
        })}
      </div>

      {/* Bottom Stats */}
      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
        46 unread &nbsp;\u2502&nbsp; 12 auto-triaged today &nbsp;\u2502&nbsp; 5 drafts prepared &nbsp;\u2502&nbsp; avg response: 23min
      </div>
    </div>
  )
}

// ─── IQ2. InboxQCompose — AI-Assisted Compose View ───
const IQ_SUGGESTIONS = [
  { label: 'Accept partnership, propose call', tone: 'Professional', confidence: 92 },
  { label: 'Request more details on budget', tone: 'Curious', confidence: 78 },
  { label: 'Decline politely, suggest Q3', tone: 'Diplomatic', confidence: 65 },
]

export function InboxQCompose() {
  const f = useAnimFrame()
  const cursor = Math.floor(f / 15) % 2 === 0
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\u270F\uFE0F'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Inbox-Q — AI Compose</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Drafting reply to: Sarah Chen</div>
        </div>
      </div>

      {/* Reply Context */}
      <GP style={{ padding: 10, marginBottom: 10, borderTopColor: '#3b82f620' }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>REPLYING TO</div>
        <div style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.6)', lineHeight: 1.4 }}>
          Q2 Partnership Proposal — $50K joint AI governance toolkit. Legal reviewed clause 4.2 (liability cap), no blockers. Awaiting your sign-off before Thursday.
        </div>
      </GP>

      {/* AI Suggestions */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>AI-SUGGESTED RESPONSES</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        {IQ_SUGGESTIONS.map((s, i) => {
          const op = lerp(f, i * 4, i * 4 + 8, 0, 1)
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, background: i === 0 ? '#3b82f610' : 'rgba(255,255,255,0.02)', border: `1px solid ${i === 0 ? '#3b82f625' : 'rgba(255,255,255,0.05)'}`, cursor: 'pointer', opacity: op }}>
              <div style={{ width: 28, height: 28, borderRadius: 6, background: `rgba(59,130,246,${0.15 - i * 0.04})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 10, color: '#3b82f6', fontWeight: 700 }}>{i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: F, fontSize: 10, color: '#fff', fontWeight: 500 }}>{s.label}</div>
                <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Tone: {s.tone}</div>
              </div>
              <div style={{ fontFamily: M, fontSize: 9, color: '#3b82f6', fontWeight: 600 }}>{s.confidence}%</div>
            </div>
          )
        })}
      </div>

      {/* Draft Editor */}
      <GP style={{ padding: 12, marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>DRAFT</div>
        <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.8)', lineHeight: 1.5 }}>
          Hi Sarah,<br /><br />
          Thank you for the proposal. We have reviewed the terms and are happy to proceed with the Q2 partnership. Our legal team has cleared clause 4.2.<br /><br />
          Could we schedule a 30-minute call this week to finalise the timeline?{cursor && <span style={{ color: '#3b82f6' }}>|</span>}
        </div>
      </GP>

      <div style={{ display: 'flex', gap: 6 }}>
        {['Send', 'Save Draft', 'Regenerate', 'Schedule'].map((a, i) => (
          <div key={i} style={{ padding: '6px 14px', borderRadius: 6, background: i === 0 ? '#3b82f620' : 'rgba(255,255,255,0.04)', border: `1px solid ${i === 0 ? '#3b82f630' : 'rgba(255,255,255,0.08)'}`, fontFamily: M, fontSize: 9, color: i === 0 ? '#3b82f6' : 'rgba(255,255,255,0.6)', fontWeight: 600, cursor: 'pointer' }}>{a}</div>
        ))}
      </div>
    </div>
  )
}

// ─── IQ3. InboxQTriageRules — Automated Triage Engine ───
const IQ_RULES = [
  { name: 'VIP Senders', condition: 'From: *@board.quox.ai OR *@investor.*', action: 'Flag urgent + notify Telegram', matches: 47, color: '#ef4444', enabled: true },
  { name: 'CI/CD Failures', condition: 'Subject: "Run failed" AND From: github.com', action: 'Route to Action-Q → create task', matches: 213, color: '#f59e0b', enabled: true },
  { name: 'Invoices', condition: 'Subject: "Invoice" OR attachment: *.pdf', action: 'Tag billing + forward to billing@', matches: 89, color: '#10b981', enabled: true },
  { name: 'Newsletter', condition: 'List-Unsubscribe header present', action: 'Archive, no notification', matches: 1247, color: 'rgba(255,255,255,0.3)', enabled: true },
  { name: 'Support Tickets', condition: 'To: support@example.com', action: 'Tag support + create HITL task', matches: 341, color: '#06b6d4', enabled: true },
  { name: 'Spam Guard', condition: 'SpamAssassin score > 5', action: 'Delete + report', matches: 62, color: '#ef4444', enabled: false },
]

export function InboxQTriageRules() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>{'\u2699\uFE0F'}</span>
          <div>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Inbox-Q — Triage Rules Engine</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>6 rules active — 1,999 emails matched this month</div>
          </div>
        </div>
        <div style={{ padding: '5px 12px', borderRadius: 6, background: '#10b98120', border: '1px solid #10b98130', fontFamily: M, fontSize: 9, color: '#10b981', fontWeight: 600, cursor: 'pointer' }}>+ Add Rule</div>
      </div>

      {IQ_RULES.map((r, i) => {
        const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
        return (
          <GP key={i} style={{ padding: '10px 12px', marginBottom: 6, borderTopColor: `${r.color}20`, opacity: op * (r.enabled ? 1 : 0.5) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: r.enabled ? r.color : 'rgba(255,255,255,0.15)' }} />
                <span style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff' }}>{r.name}</span>
                {!r.enabled && <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', padding: '1px 5px', borderRadius: 3, background: 'rgba(255,255,255,0.05)' }}>DISABLED</span>}
              </div>
              <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>{r.matches} matches</span>
            </div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 3, paddingLeft: 16 }}>IF: {r.condition}</div>
            <div style={{ fontFamily: M, fontSize: 9, color: r.color, paddingLeft: 16 }}>THEN: {r.action}</div>
          </GP>
        )
      })}

      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 8 }}>
        Rules execute in order. First match wins. Drag to reorder priority.
      </div>
    </div>
  )
}

// ─── IQ4. InboxQMultiInbox — Multi-Account Management ───
const IQ_SYNC_LOG = [
  { account: 'admin@example.com', action: 'Full sync completed', messages: 12, time: '2m ago', color: '#3b82f6' },
  { account: 'support@example.com', action: 'Delta sync — 4 new messages', messages: 4, time: '5m ago', color: '#a855f7' },
  { account: 'billing@example.com', action: 'IDLE connection renewed', messages: 0, time: '8m ago', color: '#10b981' },
  { account: 'hr@example.com', action: 'Google OAuth token refreshed', messages: 0, time: '12m ago', color: '#f59e0b' },
]

export function InboxQMultiInbox() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.06) * 0.3
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDCEC'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Inbox-Q — Multi-Account Manager</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>4 accounts across 2 providers</div>
        </div>
      </div>

      {/* Account Health Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
        {IQ_ACCOUNTS.map((acc, i) => {
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          return (
            <GP key={i} style={{ padding: 10, borderTopColor: `${acc.color}30`, opacity: op }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontFamily: M, fontSize: 10, color: acc.color, fontWeight: 700 }}>{acc.email}</span>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: acc.health === 'connected' ? '#30ff90' : '#f59e0b', boxShadow: `0 0 ${4 + pulse * 3}px ${acc.health === 'connected' ? '#30ff9040' : '#f59e0b40'}` }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: M, fontSize: 9 }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>{acc.unread} unread / {acc.total.toLocaleString()} total</span>
                <span style={{ color: 'rgba(255,255,255,0.4)' }}>{acc.provider}</span>
              </div>
              <div style={{ marginTop: 6, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, (acc.unread / 50) * 100)}%`, height: '100%', borderRadius: 2, background: acc.color }} />
              </div>
            </GP>
          )
        })}
      </div>

      {/* Sync Log */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>SYNC LOG</div>
      {IQ_SYNC_LOG.map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: s.color }} />
          <span style={{ fontFamily: M, fontSize: 9, color: s.color, fontWeight: 600, minWidth: 120 }}>{s.account}</span>
          <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.6)', flex: 1 }}>{s.action}</span>
          <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{s.time}</span>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <div style={{ padding: '6px 14px', borderRadius: 6, background: '#3b82f620', border: '1px solid #3b82f630', fontFamily: M, fontSize: 9, color: '#3b82f6', fontWeight: 600, cursor: 'pointer' }}>+ Add Account</div>
        <div style={{ padding: '6px 14px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', fontWeight: 600, cursor: 'pointer' }}>Force Sync All</div>
      </div>
    </div>
  )
}

// ─── IQ5. InboxQAnalytics — Email Intelligence Analytics ───
const IQ_HOURLY = [2,5,12,28,45,38,22,31,47,52,44,35,28,19,14,8,4,2,1,0,0,0,1,2]
const IQ_SENDERS = [
  { name: 'GitHub', count: 342, pct: 28, color: '#3b82f6' },
  { name: 'Internal', count: 287, pct: 24, color: '#a855f7' },
  { name: 'Clients', count: 198, pct: 16, color: '#10b981' },
  { name: 'Newsletters', count: 156, pct: 13, color: '#f59e0b' },
  { name: 'Other', count: 231, pct: 19, color: 'rgba(255,255,255,0.3)' },
]

export function InboxQAnalytics() {
  const f = useAnimFrame()
  const maxH = Math.max(...IQ_HOURLY)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDCCA'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Inbox-Q — Email Analytics</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>This month — 1,214 emails processed</div>
        </div>
      </div>

      {/* Hourly Volume Chart */}
      <GP style={{ padding: 10, marginBottom: 12 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>HOURLY VOLUME (24H)</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 60 }}>
          {IQ_HOURLY.map((v, i) => {
            const h = Math.max(2, (v / maxH) * 55)
            const op = lerp(f, i, i + 6, 0, 1)
            return <div key={i} style={{ flex: 1, height: h, borderRadius: '2px 2px 0 0', background: i >= 8 && i <= 17 ? '#3b82f6' : 'rgba(255,255,255,0.1)', opacity: op * 0.8 }} />
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          {[0, 6, 12, 18, 23].map(h => <span key={h} style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{String(h).padStart(2, '0')}:00</span>)}
        </div>
      </GP>

      {/* Sender Breakdown */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>SENDER BREAKDOWN</div>
      {IQ_SENDERS.map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontFamily: M, fontSize: 9, color: s.color, fontWeight: 600, minWidth: 70 }}>{s.name}</span>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
            <div style={{ width: `${s.pct}%`, height: '100%', borderRadius: 3, background: s.color, transition: 'width 0.3s' }} />
          </div>
          <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', minWidth: 50, textAlign: 'right' }}>{s.count} ({s.pct}%)</span>
        </div>
      ))}

      {/* Key Metrics */}
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {[{ label: 'Avg Response', value: '23m', color: '#3b82f6' }, { label: 'Auto-Triaged', value: '78%', color: '#10b981' }, { label: 'Spam Blocked', value: '62', color: '#ef4444' }, { label: 'Drafts Used', value: '89%', color: '#a855f7' }].map((m, i) => (
          <GP key={i} style={{ flex: 1, padding: '8px 6px', textAlign: 'center' }}>
            <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: m.color }}>{m.value}</div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{m.label}</div>
          </GP>
        ))}
      </div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// CALENDARQ — Deep Schedule Intelligence (5 components)
// ═══════════════════════════════════════════════════════════════

// ─── CQ1. CalendarQFullPage — Full Calendar Dashboard ───
const CQ_CALENDARS = [
  { name: 'Work', color: '#3b82f6', events: 23, provider: 'CalDAV' },
  { name: 'Board', color: '#ef4444', events: 4, provider: 'CalDAV' },
  { name: 'Personal', color: '#10b981', events: 8, provider: 'Google' },
  { name: 'Team Shared', color: '#a855f7', events: 15, provider: 'CalDAV' },
]
const CQ_TODAY = [
  { time: '09:00', end: '09:30', title: 'Team Standup', cal: 'Work', attendees: ['Adam', 'Sarah', 'Dev Team'], location: 'Zoom', prep: null, color: '#3b82f6' },
  { time: '10:00', end: '11:00', title: 'Product Strategy Session', cal: 'Work', attendees: ['Adam', 'CTO', 'Product'], location: 'Meeting Room A', prep: 'Research-Q compiled competitor analysis', color: '#3b82f6' },
  { time: '11:30', end: '12:00', title: 'Investor Update Call', cal: 'Board', attendees: ['Adam', 'CFO', 'Lead Investor'], location: 'Zoom', prep: 'Research-Q prepared deck + financials', color: '#ef4444' },
  { time: '14:00', end: '15:00', title: 'Security Audit Review', cal: 'Work', attendees: ['Adam', 'WARDEN', 'DevOps'], location: 'Teams', prep: 'WARDEN generated threat report', color: '#3b82f6' },
  { time: '16:00', end: '16:30', title: '1:1 with CTO', cal: 'Work', attendees: ['Adam', 'CTO'], location: 'Office', prep: null, color: '#3b82f6' },
  { time: '17:30', end: '18:00', title: 'Gym', cal: 'Personal', attendees: [], location: 'Gym', prep: null, color: '#10b981' },
]

export function CalendarQFullPage() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#fff' }}>{'\uD83D\uDCC5'}</div>
          <div>
            <div style={{ fontFamily: F, fontSize: 15, fontWeight: 700, color: '#fff' }}>Calendar-Q — Schedule Intelligence</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>4 calendars synced — 6 events today</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['New Event', 'Find Time', 'Week View'].map((a, i) => (
            <div key={i} style={{ padding: '5px 12px', borderRadius: 6, background: i === 0 ? '#a855f720' : 'rgba(255,255,255,0.04)', border: `1px solid ${i === 0 ? '#a855f730' : 'rgba(255,255,255,0.08)'}`, fontFamily: M, fontSize: 9, color: i === 0 ? '#a855f7' : 'rgba(255,255,255,0.6)', fontWeight: 600, cursor: 'pointer' }}>{a}</div>
          ))}
        </div>
      </div>

      {/* Calendar Sources */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {CQ_CALENDARS.map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, background: `${c.color}10`, border: `1px solid ${c.color}25` }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: c.color }} />
            <span style={{ fontFamily: M, fontSize: 9, color: c.color, fontWeight: 600 }}>{c.name}</span>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>({c.events})</span>
          </div>
        ))}
      </div>

      {/* Day Timeline */}
      {CQ_TODAY.map((ev, i) => {
        const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
        return (
          <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 6, opacity: op }}>
            <div style={{ width: 50, flexShrink: 0, textAlign: 'right', paddingTop: 8 }}>
              <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>{ev.time}</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{ev.end}</div>
            </div>
            <div style={{ width: 3, borderRadius: 2, background: ev.color, flexShrink: 0 }} />
            <GP style={{ flex: 1, padding: '8px 12px', borderTopColor: `${ev.color}20` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <span style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff' }}>{ev.title}</span>
                <span style={{ fontFamily: M, fontSize: 8, color: ev.color }}>{ev.cal}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>
                <span>{'\uD83D\uDCCD'} {ev.location}</span>
                {ev.attendees.length > 0 && <span>{'\uD83D\uDC64'} {ev.attendees.length} attendees</span>}
              </div>
              {ev.prep && <div style={{ fontFamily: M, fontSize: 8, color: '#10b981', marginTop: 4 }}>{'\u2713'} {ev.prep}</div>}
            </GP>
          </div>
        )
      })}

      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginTop: 10 }}>
        Next free slot: 12:00-14:00 &nbsp;\u2502&nbsp; Tomorrow: 4 meetings, no conflicts
      </div>
    </div>
  )
}

// ─── CQ2. CalendarQWeekView — Week Overview with Heatmap ───
const CQ_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const CQ_WEEK_DATA = [
  [1,0,1,1,0,1,0,0,1,0], // Mon
  [0,1,1,0,1,0,1,1,0,0], // Tue
  [1,1,0,0,1,1,0,0,0,0], // Wed
  [0,0,1,1,1,0,0,1,0,0], // Thu
  [1,0,0,1,0,0,0,0,0,0], // Fri
  [0,0,0,0,0,0,0,0,0,0], // Sat
  [0,0,0,1,0,0,0,0,0,0], // Sun
]
const CQ_HOURS = ['08', '09', '10', '11', '12', '13', '14', '15', '16', '17']

export function CalendarQWeekView() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDCC6'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Calendar-Q — Week Overview</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>24-30 March 2026 — 18 events, 2 conflicts</div>
        </div>
      </div>

      {/* Availability Heatmap */}
      <GP style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: 1 }}>AVAILABILITY HEATMAP</div>
        <div style={{ display: 'flex', gap: 2 }}>
          <div style={{ width: 30 }}>
            <div style={{ height: 18 }} />
            {CQ_HOURS.map(h => <div key={h} style={{ height: 18, fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center' }}>{h}:00</div>)}
          </div>
          {CQ_WEEK.map((day, di) => (
            <div key={di} style={{ flex: 1 }}>
              <div style={{ height: 18, fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)', textAlign: 'center', fontWeight: 600 }}>{day}</div>
              {CQ_WEEK_DATA[di].map((busy, hi) => {
                const op = lerp(f, di * 2 + hi, di * 2 + hi + 6, 0, 1)
                return <div key={hi} style={{ height: 18, margin: 1, borderRadius: 3, background: busy ? '#a855f740' : 'rgba(255,255,255,0.03)', border: `1px solid ${busy ? '#a855f720' : 'rgba(255,255,255,0.02)'}`, opacity: op }} />
              })}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 8, justifyContent: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 10, height: 10, borderRadius: 2, background: 'rgba(255,255,255,0.03)' }} /><span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Free</span></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 10, height: 10, borderRadius: 2, background: '#a855f740' }} /><span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Busy</span></div>
        </div>
      </GP>

      {/* Daily Summary */}
      <div style={{ display: 'flex', gap: 4 }}>
        {CQ_WEEK.map((day, i) => {
          const count = CQ_WEEK_DATA[i].filter(Boolean).length
          return (
            <GP key={i} style={{ flex: 1, padding: '8px 4px', textAlign: 'center' }}>
              <div style={{ fontFamily: M, fontSize: 9, color: i < 5 ? '#a855f7' : 'rgba(255,255,255,0.3)', fontWeight: 600, marginBottom: 4 }}>{day}</div>
              <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: count > 4 ? '#ef4444' : count > 2 ? '#f59e0b' : '#30ff90' }}>{count}</div>
              <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>events</div>
            </GP>
          )
        })}
      </div>
    </div>
  )
}

// ─── CQ3. CalendarQMeetingPrep — AI Meeting Preparation ───
const CQ_PREP = {
  title: 'Investor Update Call',
  time: '11:30 — 12:00',
  attendees: [
    { name: 'Adam (CEO)', role: 'Presenter', status: 'confirmed' },
    { name: 'James (CFO)', role: 'Finance backup', status: 'confirmed' },
    { name: 'Victoria (Lead Investor)', role: 'Key stakeholder', status: 'tentative' },
  ],
  docs: [
    { name: 'Q1 Investor Deck v3.pdf', agent: 'Research-Q', ready: true },
    { name: 'Financial Summary Q1.xlsx', agent: 'Action-Q', ready: true },
    { name: 'Product Roadmap Update', agent: 'Research-Q', ready: false },
  ],
  talking: [
    'Q1 revenue: \u00A3847K (+12% vs forecast)',
    'User growth: 3,200 DAU, 89% retention',
    'QuoxCORE v2.1 shipped (HITL, teams, workflows)',
    'Hiring: 3 roles approved, 1 offer out',
    'Ask: Bridge round timing discussion',
  ],
}

export function CalendarQMeetingPrep() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDCCB'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Calendar-Q — Meeting Prep</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Auto-compiled by Research-Q + Action-Q</div>
        </div>
      </div>

      {/* Meeting Header */}
      <GP style={{ padding: 12, marginBottom: 10, borderTopColor: '#ef444420' }}>
        <div style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{CQ_PREP.title}</div>
        <div style={{ fontFamily: M, fontSize: 9, color: '#ef4444' }}>{CQ_PREP.time} — In 45 minutes</div>
      </GP>

      {/* Attendees */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>ATTENDEES</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {CQ_PREP.attendees.map((a, i) => (
          <GP key={i} style={{ flex: 1, padding: '6px 8px' }}>
            <div style={{ fontFamily: F, fontSize: 10, color: '#fff', fontWeight: 600, marginBottom: 2 }}>{a.name}</div>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{a.role}</div>
            <div style={{ fontFamily: M, fontSize: 8, color: a.status === 'confirmed' ? '#30ff90' : '#f59e0b', marginTop: 2 }}>{a.status === 'confirmed' ? '\u2713' : '?'} {a.status}</div>
          </GP>
        ))}
      </div>

      {/* Prepared Docs */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>PREPARED DOCUMENTS</div>
      {CQ_PREP.docs.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
          <span style={{ fontSize: 10 }}>{d.ready ? '\u2705' : '\u23F3'}</span>
          <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{d.name}</span>
          <span style={{ fontFamily: M, fontSize: 8, color: '#06b6d4' }}>{d.agent}</span>
        </div>
      ))}

      {/* Talking Points */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, marginTop: 12, letterSpacing: 1 }}>AI-SUGGESTED TALKING POINTS</div>
      {CQ_PREP.talking.map((t, i) => {
        const op = lerp(f, 8 + i * 2, 10 + i * 2 + 5, 0, 1)
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0', opacity: op }}>
            <span style={{ fontFamily: M, fontSize: 9, color: '#a855f7', fontWeight: 700, minWidth: 14 }}>{i + 1}.</span>
            <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4 }}>{t}</span>
          </div>
        )
      })}
    </div>
  )
}

// ─── CQ4. CalendarQConflicts — Conflict Resolution ───
const CQ_CONFLICTS = [
  { a: { title: 'Investor Call', time: '11:00-11:30', priority: 'critical', color: '#ef4444' }, b: { title: 'Product Review', time: '11:15-12:00', priority: 'high', color: '#f59e0b' }, suggestion: 'Move Product Review to 13:00 (slot free, all attendees available)', status: 'pending' },
  { a: { title: 'Board Prep', time: '15:00-16:00', priority: 'high', color: '#a855f7' }, b: { title: 'Team Retro', time: '15:30-16:30', priority: 'medium', color: '#3b82f6' }, suggestion: 'Shorten Team Retro to 30min, start at 16:00', status: 'resolved' },
]

export function CalendarQConflicts() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.08) * 0.3
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16, opacity: pulse }}>{'\u26A0\uFE0F'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Calendar-Q — Conflict Resolver</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>1 active conflict, 1 resolved this week</div>
        </div>
      </div>

      {CQ_CONFLICTS.map((c, ci) => {
        const resolved = c.status === 'resolved'
        const op = lerp(f, ci * 6, ci * 6 + 10, 0, 1)
        return (
          <GP key={ci} style={{ padding: 12, marginBottom: 10, borderTopColor: resolved ? '#10b98120' : '#ef444420', opacity: op * (resolved ? 0.6 : 1) }}>
            {resolved && <div style={{ fontFamily: M, fontSize: 8, color: '#10b981', marginBottom: 6 }}>{'\u2713'} RESOLVED</div>}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {[c.a, c.b].map((ev, ei) => (
                <div key={ei} style={{ flex: 1, padding: '6px 8px', borderRadius: 6, background: `${ev.color}10`, borderLeft: `3px solid ${ev.color}` }}>
                  <div style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff' }}>{ev.title}</div>
                  <div style={{ fontFamily: M, fontSize: 8, color: ev.color }}>{ev.time}</div>
                  <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>Priority: {ev.priority}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 6, background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.15)' }}>
              <span style={{ fontFamily: M, fontSize: 8, color: '#a855f7', fontWeight: 700 }}>AI SUGGESTION:</span>
              <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{c.suggestion}</span>
            </div>
            {!resolved && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {['Accept Suggestion', 'Reschedule Manually', 'Dismiss'].map((a, i) => (
                  <div key={i} style={{ padding: '5px 10px', borderRadius: 6, background: i === 0 ? '#a855f720' : 'rgba(255,255,255,0.04)', border: `1px solid ${i === 0 ? '#a855f730' : 'rgba(255,255,255,0.08)'}`, fontFamily: M, fontSize: 8, color: i === 0 ? '#a855f7' : 'rgba(255,255,255,0.5)', fontWeight: 600, cursor: 'pointer' }}>{a}</div>
                ))}
              </div>
            )}
          </GP>
        )
      })}

      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
        Calendar-Q checks for conflicts every 5 minutes across all synced calendars
      </div>
    </div>
  )
}

// ─── CQ5. CalendarQAvailability — Smart Availability Finder ───
const CQ_SLOTS = [
  { day: 'Today', slots: [{ time: '12:00-13:00', quality: 'good' }, { time: '15:30-16:00', quality: 'tight' }] },
  { day: 'Tomorrow', slots: [{ time: '09:00-10:30', quality: 'great' }, { time: '13:00-15:00', quality: 'great' }, { time: '16:30-17:30', quality: 'good' }] },
  { day: 'Wednesday', slots: [{ time: '10:00-12:00', quality: 'great' }, { time: '14:00-17:00', quality: 'great' }] },
]
const CQ_QUAL_COLORS = { great: '#30ff90', good: '#3b82f6', tight: '#f59e0b' }

export function CalendarQAvailability() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDD0D'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Calendar-Q — Find Available Time</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Scanning 4 calendars for open slots</div>
        </div>
      </div>

      {/* Search Parameters */}
      <GP style={{ padding: 10, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>DURATION</div>
          <div style={{ fontFamily: F, fontSize: 12, color: '#fff', fontWeight: 600 }}>30 minutes</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>PARTICIPANTS</div>
          <div style={{ fontFamily: F, fontSize: 12, color: '#fff', fontWeight: 600 }}>Adam + Victoria</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>RANGE</div>
          <div style={{ fontFamily: F, fontSize: 12, color: '#fff', fontWeight: 600 }}>Next 3 days</div>
        </div>
      </GP>

      {/* Available Slots */}
      {CQ_SLOTS.map((day, di) => (
        <div key={di} style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', fontWeight: 700, marginBottom: 6, letterSpacing: 1 }}>{day.day.toUpperCase()}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {day.slots.map((s, si) => {
              const qc = CQ_QUAL_COLORS[s.quality]
              const op = lerp(f, di * 4 + si * 2, di * 4 + si * 2 + 6, 0, 1)
              return (
                <div key={si} style={{ padding: '8px 14px', borderRadius: 8, background: `${qc}10`, border: `1px solid ${qc}25`, cursor: 'pointer', opacity: op }}>
                  <div style={{ fontFamily: F, fontSize: 11, color: '#fff', fontWeight: 600 }}>{s.time}</div>
                  <div style={{ fontFamily: M, fontSize: 8, color: qc, marginTop: 2 }}>{s.quality}</div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'center' }}>
        {Object.entries(CQ_QUAL_COLORS).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: v }} />
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{k}</span>
          </div>
        ))}
      </div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// BROWSERQ — Deep Web Automation Intelligence (5 components)
// ═══════════════════════════════════════════════════════════════

// ─── BQ1. BrowserQFullPage — Full Automation Dashboard ───
const BQ_SESSIONS = [
  { id: 1, title: 'GitHub — PR Review Queue', url: 'github.com/quoxai/quox/pulls', status: 'active', pages: 3, actions: 12, duration: '4m 23s', color: '#38bdf8', gradient: 'linear-gradient(135deg, #0d1117 0%, #161b22 50%, #21262d 100%)' },
  { id: 2, title: 'Hetzner Console — Infrastructure', url: 'console.hetzner.cloud/projects/quox', status: 'active', pages: 1, actions: 5, duration: '1m 47s', color: '#ef4444', gradient: 'linear-gradient(135deg, #1a1a2e 0%, #2d1b2e 50%, #1a1a2e 100%)' },
  { id: 3, title: 'Stripe Dashboard — Revenue', url: 'dashboard.stripe.com/payments', status: 'paused', pages: 2, actions: 8, duration: '2m 12s', color: '#a855f7', gradient: 'linear-gradient(135deg, #1a1022 0%, #2d1b3e 50%, #1a1022 100%)' },
]
const BQ_RECENT = [
  { action: 'Extracted PR review comments (#47, #48, #49)', session: 'GitHub', time: '3m ago', color: '#38bdf8' },
  { action: 'Downloaded monthly invoice PDF', session: 'Hetzner', time: '12m ago', color: '#ef4444' },
  { action: 'Captured revenue screenshot for investor deck', session: 'Stripe', time: '25m ago', color: '#a855f7' },
  { action: 'Approved GitHub Actions re-run for main #1247', session: 'GitHub', time: '1h ago', color: '#38bdf8' },
  { action: 'Updated DNS record in Hetzner panel', session: 'Hetzner', time: '2h ago', color: '#ef4444' },
]

export function BrowserQFullPage() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.06) * 0.3
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#fff' }}>{'\uD83C\uDF10'}</div>
          <div>
            <div style={{ fontFamily: F, fontSize: 15, fontWeight: 700, color: '#fff' }}>Browser-Q — Web Automation Centre</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>Playwright engine — 3 sessions, 25 actions today</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#30ff90', boxShadow: `0 0 ${6 + pulse * 4}px #30ff9060`, opacity: pulse }} />
          <span style={{ fontFamily: M, fontSize: 9, color: '#30ff90', fontWeight: 600 }}>ENGINE RUNNING</span>
        </div>
      </div>

      {/* Active Sessions */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {BQ_SESSIONS.map((s, i) => {
          const op = lerp(f, i * 4, i * 4 + 10, 0, 1)
          return (
            <GP key={s.id} style={{ flex: 1, padding: 10, borderTopColor: `${s.color}30`, opacity: op }}>
              <div style={{ width: '100%', height: 50, borderRadius: 6, background: s.gradient, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.2)' }}>LIVE VIEW</div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff' }}>{s.title}</span>
                <span style={{ fontFamily: M, fontSize: 7, padding: '1px 5px', borderRadius: 3, background: s.status === 'active' ? '#30ff9015' : '#f59e0b15', color: s.status === 'active' ? '#30ff90' : '#f59e0b', fontWeight: 600 }}>{s.status}</span>
              </div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.url}</div>
              <div style={{ display: 'flex', gap: 8, fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>
                <span>{s.pages} pages</span>
                <span>{s.actions} actions</span>
                <span>{s.duration}</span>
              </div>
            </GP>
          )
        })}
      </div>

      {/* Recent Actions */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>RECENT ACTIONS</div>
      {BQ_RECENT.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: a.color }} />
          <span style={{ fontFamily: M, fontSize: 8, color: a.color, fontWeight: 600, minWidth: 50 }}>{a.session}</span>
          <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{a.action}</span>
          <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{a.time}</span>
        </div>
      ))}

      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginTop: 10 }}>
        25 actions today &nbsp;\u2502&nbsp; 3 active sessions &nbsp;\u2502&nbsp; 0 HITL gates pending &nbsp;\u2502&nbsp; 47 screenshots archived
      </div>
    </div>
  )
}

// ─── BQ2. BrowserQSessionManager — Credential & Session Management ───
const BQ_CREDS = [
  { site: 'GitHub', username: 'quoxai-bot', method: 'OAuth2', lastUsed: '3m ago', health: 'active', color: '#38bdf8' },
  { site: 'Hetzner', username: 'admin@example.com', method: 'Password + 2FA', lastUsed: '12m ago', health: 'active', color: '#ef4444' },
  { site: 'Stripe', username: 'admin@example.com', method: 'OAuth2', lastUsed: '25m ago', health: 'expired', color: '#a855f7' },
  { site: 'AWS Console', username: 'quox-prod', method: 'SSO (SAML)', lastUsed: '2d ago', health: 'idle', color: '#f59e0b' },
  { site: 'Cloudflare', username: 'admin@example.com', method: 'API Token', lastUsed: '5d ago', health: 'idle', color: '#10b981' },
]

export function BrowserQSessionManager() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDD11'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Browser-Q — Session Manager</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>5 sites configured — credentials from Vault</div>
        </div>
      </div>

      {BQ_CREDS.map((c, i) => {
        const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
        const hColor = c.health === 'active' ? '#30ff90' : c.health === 'expired' ? '#ef4444' : 'rgba(255,255,255,0.3)'
        return (
          <GP key={i} style={{ padding: '10px 12px', marginBottom: 5, borderTopColor: `${c.color}20`, opacity: op }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: 6, background: `${c.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 10, color: c.color, fontWeight: 700 }}>{c.site[0]}</div>
                <div>
                  <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff' }}>{c.site}</div>
                  <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{c.username} \u2014 {c.method}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: M, fontSize: 8, color: hColor, fontWeight: 600 }}>{c.health === 'active' ? '\u2713 Active' : c.health === 'expired' ? '\u2717 Expired' : '\u25CB Idle'}</div>
                <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>Last: {c.lastUsed}</div>
              </div>
            </div>
          </GP>
        )
      })}

      <GP style={{ padding: 8, marginTop: 8 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', textAlign: 'center' }}>
          {'\uD83D\uDD12'} All credentials stored in Vault — never in agent memory. Login actions require HITL approval.
        </div>
      </GP>
    </div>
  )
}

// ─── BQ3. BrowserQRecorder — Automation Recorder ───
const BQ_SEQUENCE = [
  { step: 1, type: 'navigate', target: 'github.com/quoxai/quox/pulls', status: 'done' },
  { step: 2, type: 'wait', target: 'Pull requests list loaded', status: 'done' },
  { step: 3, type: 'click', target: 'PR #49 — Auth refactor', status: 'done' },
  { step: 4, type: 'scroll', target: 'To diff section', status: 'done' },
  { step: 5, type: 'extract', target: 'Changed files list + line counts', status: 'active' },
  { step: 6, type: 'click', target: 'Files changed tab', status: 'pending' },
  { step: 7, type: 'extract', target: 'Diff content for each file', status: 'pending' },
  { step: 8, type: 'screenshot', target: 'Capture final state', status: 'pending' },
]
const BQ_STEP_ICONS = { navigate: '\uD83C\uDF10', wait: '\u23F3', click: '\uD83D\uDC46', scroll: '\u2193', extract: '\uD83D\uDCE6', screenshot: '\uD83D\uDCF7' }
const BQ_STEP_COLORS = { done: '#30ff90', active: '#38bdf8', pending: 'rgba(255,255,255,0.2)' }

export function BrowserQRecorder() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.1) * 0.3
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>{'\u23FA\uFE0F'}</span>
          <div>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Browser-Q — Automation Recorder</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Recording: "Extract PR review data"</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ padding: '4px 10px', borderRadius: 6, background: '#ef444420', border: '1px solid #ef444430', fontFamily: M, fontSize: 9, color: '#ef4444', fontWeight: 600 }}>{'\u25A0'} Stop</div>
          <div style={{ padding: '4px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>Save Sequence</div>
        </div>
      </div>

      {/* Step Timeline */}
      <div style={{ position: 'relative', paddingLeft: 28 }}>
        <div style={{ position: 'absolute', left: 12, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.06)' }} />
        {BQ_SEQUENCE.map((s, i) => {
          const sc = BQ_STEP_COLORS[s.status]
          const op = lerp(f, i * 2, i * 2 + 6, 0, 1)
          const isActive = s.status === 'active'
          return (
            <div key={i} style={{ position: 'relative', marginBottom: 4, opacity: op * (s.status === 'pending' ? 0.4 : 1) }}>
              <div style={{ position: 'absolute', left: -22, top: 6, width: 16, height: 16, borderRadius: '50%', background: `${sc}15`, border: `1.5px solid ${sc}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, boxShadow: isActive ? `0 0 8px ${sc}40` : 'none' }}>
                {s.status === 'done' ? <span style={{ color: sc, fontSize: 9 }}>{'\u2713'}</span> : <span style={{ color: sc, fontSize: 8, fontFamily: M }}>{s.step}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 6, background: isActive ? 'rgba(56,189,248,0.05)' : 'transparent', border: `1px solid ${isActive ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.03)'}` }}>
                <span style={{ fontSize: 12, opacity: isActive ? pulse : 0.6 }}>{BQ_STEP_ICONS[s.type]}</span>
                <span style={{ fontFamily: M, fontSize: 8, color: sc, fontWeight: 600, minWidth: 55, textTransform: 'uppercase' }}>{s.type}</span>
                <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>{s.target}</span>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontFamily: M, fontSize: 9 }}>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>Step 5/8 — extracting data</span>
        <span style={{ color: '#38bdf8' }}>Estimated: 12s remaining</span>
      </div>
    </div>
  )
}

// ─── BQ4. BrowserQExtraction — Data Extraction Results ───
const BQ_EXTRACTED = [
  { field: 'PR Title', value: 'Auth refactor — OAuth2 + session management', type: 'text' },
  { field: 'Author', value: 'adam-quox', type: 'text' },
  { field: 'Files Changed', value: '14', type: 'number' },
  { field: 'Additions', value: '+847', type: 'number' },
  { field: 'Deletions', value: '-312', type: 'number' },
  { field: 'Review Status', value: '2 approved, 1 changes requested', type: 'text' },
  { field: 'CI Status', value: 'Passing (47/47 tests)', type: 'status' },
  { field: 'Labels', value: 'auth, security, breaking-change', type: 'tags' },
]

export function BrowserQExtraction() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDCE6'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Browser-Q — Extracted Data</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Source: github.com/quoxai/quox/pull/49</div>
        </div>
      </div>

      <GP style={{ padding: 12, marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: 1 }}>STRUCTURED EXTRACTION</div>
        {BQ_EXTRACTED.map((d, i) => {
          const op = lerp(f, i * 2, i * 2 + 6, 0, 1)
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: op }}>
              <span style={{ fontFamily: M, fontSize: 9, color: '#06b6d4', fontWeight: 600, minWidth: 110 }}>{d.field}</span>
              <span style={{ fontFamily: F, fontSize: 10, color: d.type === 'number' ? '#3b82f6' : d.type === 'status' ? '#30ff90' : 'rgba(255,255,255,0.7)' }}>{d.value}</span>
            </div>
          )
        })}
      </GP>

      {/* Screenshot */}
      <GP style={{ padding: 10, marginBottom: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>PAGE SCREENSHOT</div>
        <div style={{ width: '100%', height: 80, borderRadius: 6, background: 'linear-gradient(135deg, #0d1117 0%, #161b22 50%, #21262d 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.2)' }}>CAPTURED AT 10:42:17 — 1920x1080</div>
        </div>
      </GP>

      <div style={{ display: 'flex', gap: 6 }}>
        {['Save to Memory', 'Export JSON', 'Create Task', 'Send to Inbox-Q'].map((a, i) => (
          <div key={i} style={{ padding: '5px 10px', borderRadius: 6, background: i === 0 ? '#06b6d420' : 'rgba(255,255,255,0.04)', border: `1px solid ${i === 0 ? '#06b6d430' : 'rgba(255,255,255,0.08)'}`, fontFamily: M, fontSize: 8, color: i === 0 ? '#06b6d4' : 'rgba(255,255,255,0.5)', fontWeight: 600, cursor: 'pointer' }}>{a}</div>
        ))}
      </div>
    </div>
  )
}

// ─── BQ5. BrowserQSecurity — Automation Security & Audit ───
const BQ_AUDIT = [
  { action: 'OAuth2 login to GitHub', approval: 'Auto (trusted site)', risk: 'low', time: '10:38', witness: 'WARD-7a3f', color: '#30ff90' },
  { action: 'Password login to Hetzner', approval: 'HITL approved (Adam)', risk: 'medium', time: '10:25', witness: 'WARD-8b4c', color: '#f59e0b' },
  { action: 'Form submission on Stripe', approval: 'HITL approved (Adam)', risk: 'high', time: '10:12', witness: 'WARD-9c5d', color: '#ef4444' },
  { action: 'Data extraction from GitHub', approval: 'Auto (read-only)', risk: 'low', time: '10:42', witness: 'WARD-a1e2', color: '#30ff90' },
  { action: 'Screenshot capture', approval: 'Auto (passive)', risk: 'low', time: '10:43', witness: 'WARD-b2f3', color: '#30ff90' },
]
const BQ_RISK_COLORS = { low: '#30ff90', medium: '#f59e0b', high: '#ef4444' }

export function BrowserQSecurity() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDD12'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Browser-Q — Security Audit</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>AOCL governance — every action logged and witnessed</div>
        </div>
      </div>

      {/* Security Policy */}
      <GP style={{ padding: 10, marginBottom: 12, borderTopColor: '#10b98120' }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>ACTIVE POLICIES</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['Login \u2192 HITL required', 'Payments \u2192 HITL + 2FA', 'Read-only \u2192 Auto-approve', 'Screenshots \u2192 Auto-approve', 'Form submit \u2192 HITL required'].map((p, i) => (
            <div key={i} style={{ padding: '3px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.15)', fontFamily: M, fontSize: 8, color: '#10b981' }}>{p}</div>
          ))}
        </div>
      </GP>

      {/* Audit Log */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>AUDIT LOG (VOLT-WITNESSED)</div>
      {BQ_AUDIT.map((a, i) => {
        const op = lerp(f, i * 2, i * 2 + 6, 0, 1)
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 3, borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', opacity: op }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: a.color, flexShrink: 0 }} />
            <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{a.action}</span>
            <span style={{ fontFamily: M, fontSize: 7, padding: '1px 5px', borderRadius: 3, background: `${BQ_RISK_COLORS[a.risk]}12`, color: BQ_RISK_COLORS[a.risk], fontWeight: 600 }}>{a.risk}</span>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{a.approval}</span>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{a.time}</span>
            <span style={{ fontFamily: M, fontSize: 7, color: '#a855f7' }}>{a.witness}</span>
          </div>
        )
      })}

      {/* Stats */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        {[{ label: 'Total Actions', value: '147', color: '#3b82f6' }, { label: 'HITL Approved', value: '23', color: '#f59e0b' }, { label: 'Auto-Approved', value: '124', color: '#30ff90' }, { label: 'Blocked', value: '0', color: '#ef4444' }].map((m, i) => (
          <GP key={i} style={{ flex: 1, padding: '6px 4px', textAlign: 'center' }}>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: m.color }}>{m.value}</div>
            <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>{m.label}</div>
          </GP>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEDIAQ — Unified Media Gallery & Agent (Phase 9G)
// Accent: #ec4899 (pink) — replaces Image Gallery with full quoxified gallery
// Sources: AI-generated images, Browser-Q screenshots, video captures, uploads
// ═══════════════════════════════════════════════════════════════════════════════

// ─── MQ1. MediaQFullPage — Main Gallery Dashboard ───
const MQ_STATS = [
  { label: 'Total Media', value: '1,847', color: '#ec4899' },
  { label: 'AI Generated', value: '892', color: '#a855f7' },
  { label: 'Screenshots', value: '614', color: '#06b6d4' },
  { label: 'Videos', value: '87', color: '#6366f1' },
  { label: 'Uploads', value: '254', color: '#f59e0b' },
]
const MQ_RECENT = [
  { id: 1, title: 'Infrastructure topology diagram', source: 'ai-gen', agent: 'DAEDALUS', type: 'image', size: '2.4 MB', time: '3m ago', dim: '2048x2048', color: '#a855f7', gradient: 'linear-gradient(135deg, #a855f720 0%, #6366f120 100%)' },
  { id: 2, title: 'Hetzner console — server list', source: 'browser-q', agent: 'Browser-Q', type: 'screenshot', size: '847 KB', time: '12m ago', dim: '1920x1080', color: '#06b6d4', gradient: 'linear-gradient(135deg, #06b6d420 0%, #3b82f620 100%)' },
  { id: 3, title: 'QuoxCORE dashboard walkthrough', source: 'video', agent: 'MEDIA', type: 'video', size: '34.2 MB', time: '1h ago', dim: '1920x1080', color: '#6366f1', gradient: 'linear-gradient(135deg, #6366f120 0%, #ec489920 100%)' },
  { id: 4, title: 'Brand logo — dark variant', source: 'upload', agent: 'Adam', type: 'image', size: '156 KB', time: '2h ago', dim: '512x512', color: '#f59e0b', gradient: 'linear-gradient(135deg, #f59e0b20 0%, #ef444420 100%)' },
  { id: 5, title: 'GitHub PR diff — auth refactor', source: 'browser-q', agent: 'Browser-Q', type: 'screenshot', size: '1.1 MB', time: '3h ago', dim: '1920x4200', color: '#06b6d4', gradient: 'linear-gradient(135deg, #06b6d420 0%, #10b98120 100%)' },
  { id: 6, title: 'Agent delegation flow diagram', source: 'ai-gen', agent: 'CODEX', type: 'image', size: '1.8 MB', time: '5h ago', dim: '2048x1024', color: '#a855f7', gradient: 'linear-gradient(135deg, #a855f720 0%, #ec489920 100%)' },
]
const MQ_SOURCE_ICONS = { 'ai-gen': '\uD83C\uDFA8', 'browser-q': '\uD83C\uDF10', video: '\uD83C\uDFA5', upload: '\uD83D\uDCE4' }
const MQ_TYPE_BADGES = { image: { bg: '#a855f715', color: '#a855f7' }, screenshot: { bg: '#06b6d415', color: '#06b6d4' }, video: { bg: '#6366f115', color: '#6366f1' } }

export function MediaQFullPage() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.06) * 0.3
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #ec4899 0%, #a855f7 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#fff' }}>{'\uD83D\uDDBC\uFE0F'}</div>
          <div>
            <div style={{ fontFamily: F, fontSize: 15, fontWeight: 700, color: '#fff' }}>Media-Q — Unified Media Gallery</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>1,847 assets — 4 sources — MEDIA agent active</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#30ff90', boxShadow: `0 0 ${6 + pulse * 4}px #30ff9060`, opacity: pulse }} />
          <span style={{ fontFamily: M, fontSize: 9, color: '#30ff90', fontWeight: 600 }}>GALLERY ONLINE</span>
        </div>
      </div>

      {/* Stats Strip */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {MQ_STATS.map((s, i) => {
          const op = lerp(f, i * 3, i * 3 + 8, 0, 1)
          return (
            <GP key={i} style={{ flex: 1, padding: '8px 6px', textAlign: 'center', opacity: op }}>
              <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>{s.label}</div>
            </GP>
          )
        })}
      </div>

      {/* Search & Filters Bar */}
      <GP style={{ padding: '8px 12px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>{'\uD83D\uDD0D'}</span>
          <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.3)', flex: 1 }}>Search media by prompt, agent, tag, or objective...</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {['All', 'Images', 'Screenshots', 'Videos'].map((fil, i) => (
              <div key={i} style={{ padding: '3px 8px', borderRadius: 4, background: i === 0 ? '#ec489920' : 'rgba(255,255,255,0.04)', border: `1px solid ${i === 0 ? '#ec489930' : 'rgba(255,255,255,0.06)'}`, fontFamily: M, fontSize: 8, color: i === 0 ? '#ec4899' : 'rgba(255,255,255,0.5)', fontWeight: 600 }}>{fil}</div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <div style={{ width: 22, height: 22, borderRadius: 4, background: '#ec489920', border: '1px solid #ec489930', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0" y="0" width="4" height="4" rx="0.5" fill="#ec4899"/><rect x="6" y="0" width="4" height="4" rx="0.5" fill="#ec4899"/><rect x="0" y="6" width="4" height="4" rx="0.5" fill="#ec4899"/><rect x="6" y="6" width="4" height="4" rx="0.5" fill="#ec4899"/></svg>
            </div>
            <div style={{ width: 22, height: 22, borderRadius: 4, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0" y="0" width="10" height="2" rx="0.5" fill="rgba(255,255,255,0.4)"/><rect x="0" y="4" width="10" height="2" rx="0.5" fill="rgba(255,255,255,0.4)"/><rect x="0" y="8" width="10" height="2" rx="0.5" fill="rgba(255,255,255,0.4)"/></svg>
            </div>
          </div>
        </div>
      </GP>

      {/* Media Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
        {MQ_RECENT.map((m, i) => {
          const op = lerp(f, i * 3, i * 3 + 10, 0, 1)
          const badge = MQ_TYPE_BADGES[m.type] || MQ_TYPE_BADGES.image
          return (
            <GP key={m.id} style={{ padding: 0, overflow: 'hidden', opacity: op }}>
              {/* Thumbnail area */}
              <div style={{ width: '100%', height: 80, background: m.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ fontSize: 24, opacity: 0.3 }}>{MQ_SOURCE_ICONS[m.source]}</span>
                {m.type === 'video' && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', border: '1.5px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="10" height="12" viewBox="0 0 10 12" fill="white"><polygon points="2,1 9,6 2,11"/></svg>
                  </div>
                </div>}
                <div style={{ position: 'absolute', top: 5, right: 5, padding: '1px 5px', borderRadius: 3, background: badge.bg, fontFamily: M, fontSize: 7, color: badge.color, fontWeight: 600, border: `1px solid ${badge.color}20` }}>{m.type}</div>
              </div>
              {/* Info */}
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: m.color }} />
                    <span style={{ fontFamily: M, fontSize: 7, color: m.color }}>{m.agent}</span>
                  </div>
                  <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{m.size}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                  <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{m.dim}</span>
                  <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{m.time}</span>
                </div>
              </div>
            </GP>
          )
        })}
      </div>

      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
        1,847 assets &nbsp;\u2502&nbsp; 12.4 GB stored &nbsp;\u2502&nbsp; 47 expiring in 7d &nbsp;\u2502&nbsp; 3 collections
      </div>
    </div>
  )
}

// ─── MQ2. MediaQGrid — Masonry Gallery with Infinite Scroll ───
const MQ_GRID_ITEMS = [
  { w: 2, h: 2, title: 'Fleet topology — full cluster', prompt: 'isometric view of server cluster with glowing connections', model: 'DALL-E 3', agent: 'DAEDALUS', color: '#a855f7', gradient: 'linear-gradient(135deg, #1a0533 0%, #0c0a1f 50%, #0a1628 100%)' },
  { w: 1, h: 1, title: 'Stripe dashboard capture', prompt: null, model: null, agent: 'Browser-Q', color: '#06b6d4', gradient: 'linear-gradient(135deg, #0d1117 0%, #161b22 100%)' },
  { w: 1, h: 2, title: 'Agent hierarchy poster', prompt: 'cyberpunk org chart with neon connections', model: 'DALL-E 3', agent: 'CODEX', color: '#a855f7', gradient: 'linear-gradient(135deg, #0f0520 0%, #1a0a2e 50%, #0c1530 100%)' },
  { w: 1, h: 1, title: 'Login flow recording', prompt: null, model: null, agent: 'Browser-Q', color: '#6366f1', gradient: 'linear-gradient(135deg, #0f0f23 0%, #1a1a35 100%)' },
  { w: 2, h: 1, title: 'QuoxCORE banner — v3 dark', prompt: 'futuristic command centre banner, purple and cyan', model: 'Midjourney v6', agent: 'MEDIA', color: '#ec4899', gradient: 'linear-gradient(135deg, #1a0a20 0%, #0a0f28 50%, #0c1a30 100%)' },
  { w: 1, h: 1, title: 'Brand icon set', prompt: null, model: null, agent: 'Adam', color: '#f59e0b', gradient: 'linear-gradient(135deg, #1a1508 0%, #201a0a 100%)' },
  { w: 1, h: 1, title: 'Docker host metrics', prompt: null, model: null, agent: 'Browser-Q', color: '#06b6d4', gradient: 'linear-gradient(135deg, #081a20 0%, #0a2030 100%)' },
  { w: 2, h: 1, title: 'Onboarding sequence — 4 frames', prompt: 'step-by-step wizard UI dark glass theme', model: 'DALL-E 3', agent: 'MEDIA', color: '#ec4899', gradient: 'linear-gradient(135deg, #200a1a 0%, #0a1028 100%)' },
]

export function MediaQGrid() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDDBC\uFE0F'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Media-Q — Gallery View</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Masonry layout — hover for details, click to expand</div>
        </div>
      </div>

      {/* Sort Controls */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {['Recent', 'By Agent', 'By Source', 'By Size', 'Favourites'].map((s, i) => (
          <div key={i} style={{ padding: '3px 8px', borderRadius: 4, background: i === 0 ? '#ec489918' : 'rgba(255,255,255,0.03)', border: `1px solid ${i === 0 ? '#ec489925' : 'rgba(255,255,255,0.05)'}`, fontFamily: M, fontSize: 8, color: i === 0 ? '#ec4899' : 'rgba(255,255,255,0.4)', fontWeight: 600 }}>{s}</div>
        ))}
      </div>

      {/* Masonry Grid (simulated with CSS grid) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, gridAutoRows: 60 }}>
        {MQ_GRID_ITEMS.map((item, i) => {
          const op = lerp(f, i * 3, i * 3 + 10, 0, 1)
          return (
            <div key={i} style={{ gridColumn: `span ${item.w}`, gridRow: `span ${item.h}`, borderRadius: 8, background: item.gradient, border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden', position: 'relative', opacity: op, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              {/* Content area */}
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {item.prompt ? <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.12)', maxWidth: '80%', textAlign: 'center', lineHeight: 1.4 }}>{item.prompt}</div> : <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.15)' }}>CAPTURED</div>}
              </div>
              {/* Shimmer overlay */}
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(105deg, rgba(255,255,255,0.03) 0%, transparent 40%, transparent 60%, rgba(255,255,255,0.01) 100%)', pointerEvents: 'none' }} />
              {/* Bottom info bar */}
              <div style={{ position: 'relative', padding: '6px 8px', background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)' }}>
                <div style={{ fontFamily: F, fontSize: 9, fontWeight: 600, color: '#fff', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: item.color }} />
                    <span style={{ fontFamily: M, fontSize: 7, color: item.color }}>{item.agent}</span>
                  </div>
                  {item.model && <span style={{ fontFamily: M, fontSize: 6, color: 'rgba(255,255,255,0.3)' }}>{item.model}</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 10 }}>
        Showing 8 of 1,847 &nbsp;\u2022&nbsp; Scroll for more &nbsp;\u2022&nbsp; Double-click to open lightbox
      </div>
    </div>
  )
}

// ─── MQ3. MediaQLightbox — Full-Size Viewer with Metadata ───
const MQ_LB_TAGS = ['infrastructure', 'topology', 'cluster', 'production', 'auto-tagged']
const MQ_LB_LINKED = [
  { type: 'Objective', name: 'Infrastructure audit Q1', id: 'OBJ-047', color: '#38bdf8' },
  { type: 'Task', name: 'Map production topology', id: 'TSK-312', color: '#30ff90' },
  { type: 'Workflow', name: 'wf-infra-audit-0x3f', id: 'WF-089', color: '#a855f7' },
]
const MQ_LB_VERSIONS = [
  { ver: 'v3', time: '3m ago', note: 'Upscaled 4x + colour correction', size: '2.4 MB' },
  { ver: 'v2', time: '8m ago', note: 'Regenerated with wider aspect', size: '1.9 MB' },
  { ver: 'v1', time: '14m ago', note: 'Initial generation', size: '1.2 MB' },
]

export function MediaQLightbox() {
  const f = useAnimFrame()
  const pulse = 0.6 + Math.sin(f * 0.08) * 0.4
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDD0D'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Media-Q — Lightbox Viewer</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Full metadata, versioning, linked objects</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        {/* Main Image Area */}
        <div style={{ flex: 2 }}>
          <GP style={{ padding: 0, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{ width: '100%', height: 180, background: 'linear-gradient(135deg, #1a0533 0%, #0c0a1f 50%, #0a1628 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.12)' }}>FULL RESOLUTION — 2048x2048</div>
              {/* Nav arrows */}
              <div style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', width: 24, height: 24, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{'\u2039'}</div>
              <div style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 24, height: 24, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{'\u203A'}</div>
              {/* Counter */}
              <div style={{ position: 'absolute', bottom: 8, right: 8, padding: '2px 8px', borderRadius: 4, background: 'rgba(0,0,0,0.6)', fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>14 / 892</div>
            </div>
          </GP>
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 4 }}>
            {[{ label: '\u2B07 Download', color: '#ec4899' }, { label: '\u2661 Favourite', color: 'rgba(255,255,255,0.5)' }, { label: '\uD83D\uDD17 Copy Link', color: 'rgba(255,255,255,0.5)' }, { label: '\uD83D\uDCC1 Add to Collection', color: 'rgba(255,255,255,0.5)' }, { label: '\uD83D\uDDD1 Delete', color: '#ef4444' }].map((a, i) => (
              <div key={i} style={{ padding: '4px 8px', borderRadius: 4, background: i === 0 ? '#ec489915' : 'rgba(255,255,255,0.03)', border: `1px solid ${i === 0 ? '#ec489920' : 'rgba(255,255,255,0.06)'}`, fontFamily: M, fontSize: 8, color: a.color, fontWeight: 600 }}>{a.label}</div>
            ))}
          </div>
        </div>

        {/* Metadata Sidebar */}
        <div style={{ flex: 1 }}>
          <GP style={{ padding: 10, marginBottom: 8 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>METADATA</div>
            {[{ k: 'Source', v: 'AI Generated', c: '#a855f7' }, { k: 'Model', v: 'DALL-E 3', c: '#ec4899' }, { k: 'Agent', v: 'DAEDALUS', c: '#38bdf8' }, { k: 'Dimensions', v: '2048 \u00d7 2048', c: 'rgba(255,255,255,0.7)' }, { k: 'Size', v: '2.4 MB', c: 'rgba(255,255,255,0.7)' }, { k: 'Created', v: '2026-03-28 14:22', c: 'rgba(255,255,255,0.7)' }, { k: 'Org', v: 'quox-ai', c: 'rgba(255,255,255,0.6)' }].map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{m.k}</span>
                <span style={{ fontFamily: M, fontSize: 8, color: m.c, fontWeight: 600 }}>{m.v}</span>
              </div>
            ))}
          </GP>

          <GP style={{ padding: 10, marginBottom: 8 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>PROMPT</div>
            <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5, fontStyle: 'italic' }}>"Isometric view of a server cluster with glowing neon connections, dark background, cyberpunk aesthetic, high detail, 4K"</div>
          </GP>

          <GP style={{ padding: 10, marginBottom: 8 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>TAGS</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {MQ_LB_TAGS.map((t, i) => (
                <div key={i} style={{ padding: '2px 6px', borderRadius: 3, background: i === MQ_LB_TAGS.length - 1 ? 'rgba(168,85,247,0.1)' : '#ec489910', border: `1px solid ${i === MQ_LB_TAGS.length - 1 ? 'rgba(168,85,247,0.2)' : '#ec489920'}`, fontFamily: M, fontSize: 7, color: i === MQ_LB_TAGS.length - 1 ? '#a855f7' : '#ec4899' }}>{i === MQ_LB_TAGS.length - 1 ? '\u2728 ' : ''}{t}</div>
              ))}
            </div>
          </GP>

          <GP style={{ padding: 10, marginBottom: 8 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>LINKED OBJECTS</div>
            {MQ_LB_LINKED.map((l, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                <span style={{ fontFamily: M, fontSize: 7, color: l.color, fontWeight: 600, minWidth: 36 }}>{l.id}</span>
                <span style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.6)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
              </div>
            ))}
          </GP>

          <GP style={{ padding: 10 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>VERSIONS</div>
            {MQ_LB_VERSIONS.map((v, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', opacity: i === 0 ? 1 : 0.5 }}>
                <span style={{ fontFamily: M, fontSize: 8, color: i === 0 ? '#ec4899' : 'rgba(255,255,255,0.5)', fontWeight: 700, minWidth: 18 }}>{v.ver}</span>
                <span style={{ fontFamily: F, fontSize: 8, color: 'rgba(255,255,255,0.5)', flex: 1 }}>{v.note}</span>
                <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{v.size}</span>
              </div>
            ))}
          </GP>
        </div>
      </div>
    </div>
  )
}

// ─── MQ4. MediaQCollections — Album & Smart Collection Manager ───
const MQ_COLLECTIONS = [
  { name: 'Infrastructure Diagrams', count: 47, cover: 'linear-gradient(135deg, #a855f720 0%, #6366f120 100%)', icon: '\uD83C\uDFD7\uFE0F', type: 'manual', updated: '2h ago', size: '89 MB' },
  { name: 'Browser-Q Captures', count: 614, cover: 'linear-gradient(135deg, #06b6d420 0%, #3b82f620 100%)', icon: '\uD83C\uDF10', type: 'smart', rule: 'source:browser-q', updated: '12m ago', size: '1.2 GB' },
  { name: 'Brand Assets', count: 32, cover: 'linear-gradient(135deg, #ec489920 0%, #f59e0b20 100%)', icon: '\u2B50', type: 'manual', updated: '1d ago', size: '156 MB' },
  { name: 'Objective Evidence', count: 189, cover: 'linear-gradient(135deg, #30ff9020 0%, #38bdf820 100%)', icon: '\uD83C\uDFAF', type: 'smart', rule: 'linked:objective.*', updated: '30m ago', size: '445 MB' },
  { name: 'Video Library', count: 87, cover: 'linear-gradient(135deg, #6366f120 0%, #ec489920 100%)', icon: '\uD83C\uDFA5', type: 'smart', rule: 'type:video', updated: '1h ago', size: '8.7 GB' },
  { name: 'Expiring Soon', count: 47, cover: 'linear-gradient(135deg, #ef444420 0%, #f59e0b20 100%)', icon: '\u23F3', type: 'smart', rule: 'expires:<7d', updated: 'live', size: '312 MB' },
]

export function MediaQCollections() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>{'\uD83D\uDCC1'}</span>
          <div>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Media-Q — Collections</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>6 collections — 3 smart, 3 manual</div>
          </div>
        </div>
        <div style={{ padding: '4px 10px', borderRadius: 6, background: '#ec489915', border: '1px solid #ec489925', fontFamily: M, fontSize: 9, color: '#ec4899', fontWeight: 600 }}>+ New Collection</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {MQ_COLLECTIONS.map((c, i) => {
          const op = lerp(f, i * 3, i * 3 + 10, 0, 1)
          return (
            <GP key={i} style={{ padding: 0, overflow: 'hidden', opacity: op }}>
              {/* Cover */}
              <div style={{ width: '100%', height: 60, background: c.cover, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ fontSize: 22 }}>{c.icon}</span>
                {c.type === 'smart' && <div style={{ position: 'absolute', top: 5, right: 5, padding: '1px 5px', borderRadius: 3, background: '#a855f712', border: '1px solid #a855f720', fontFamily: M, fontSize: 6, color: '#a855f7', fontWeight: 600 }}>{'\u26A1'} SMART</div>}
              </div>
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 2 }}>{c.name}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: M, fontSize: 8, color: '#ec4899', fontWeight: 600 }}>{c.count} items</span>
                  <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{c.size}</span>
                </div>
                {c.rule && <div style={{ fontFamily: M, fontSize: 7, color: '#a855f7', padding: '2px 5px', borderRadius: 3, background: '#a855f708', display: 'inline-block' }}>{c.rule}</div>}
                <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', marginTop: 3 }}>Updated {c.updated}</div>
              </div>
            </GP>
          )
        })}
      </div>

      <GP style={{ padding: 8, marginTop: 10 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', textAlign: 'center' }}>
          Smart collections auto-update based on filter rules. &nbsp;\u2022&nbsp; Drag media to any collection to add.
        </div>
      </GP>
    </div>
  )
}

// ─── MQ5. MediaQAgent — MEDIA Agent Panel ───
const MQ_AGENT_CAPS = [
  { name: 'Image Generation', desc: 'DALL-E 3, Midjourney, Stable Diffusion via API', status: 'active', icon: '\uD83C\uDFA8', color: '#a855f7' },
  { name: 'Screenshot Ingestion', desc: 'Auto-import from Browser-Q captures', status: 'active', icon: '\uD83D\uDCF7', color: '#06b6d4' },
  { name: 'Video Processing', desc: 'Thumbnail generation, frame extraction, transcoding', status: 'active', icon: '\uD83C\uDFA5', color: '#6366f1' },
  { name: 'Auto-Tagging', desc: 'Vision model analysis for tags + description', status: 'active', icon: '\uD83C\uDFF7\uFE0F', color: '#30ff90' },
  { name: 'Expiry Management', desc: 'Browser screenshots auto-expire in 30d, override with "keep"', status: 'active', icon: '\u23F3', color: '#f59e0b' },
  { name: 'Objective Linking', desc: 'Auto-link media to objectives, tasks, and workflows', status: 'beta', icon: '\uD83D\uDD17', color: '#ec4899' },
]
const MQ_AGENT_RECENT = [
  { action: 'Generated infrastructure diagram', target: '4 variants', time: '3m ago', color: '#a855f7' },
  { action: 'Imported 12 screenshots from Browser-Q', target: 'Hetzner session', time: '12m ago', color: '#06b6d4' },
  { action: 'Auto-tagged 23 images', target: 'infrastructure, topology, monitoring', time: '45m ago', color: '#30ff90' },
  { action: 'Linked 8 captures to OBJ-047', target: 'Infrastructure audit', time: '1h ago', color: '#ec4899' },
  { action: 'Transcoded video to webm', target: 'dashboard-walkthrough.mp4', time: '2h ago', color: '#6366f1' },
]

export function MediaQAgent() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.06) * 0.3
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #ec4899 0%, #a855f7 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: '#fff', fontWeight: 700, fontFamily: M }}>M</div>
          <div>
            <div style={{ fontFamily: F, fontSize: 15, fontWeight: 700, color: '#fff' }}>MEDIA — Media Intelligence Agent</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>Specialist agent — generation, ingestion, tagging, lifecycle</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#30ff90', boxShadow: `0 0 ${6 + pulse * 4}px #30ff9060`, opacity: pulse }} />
          <span style={{ fontFamily: M, fontSize: 9, color: '#30ff90', fontWeight: 600 }}>ONLINE</span>
        </div>
      </div>

      {/* Agent Identity Card */}
      <GP style={{ padding: 12, marginBottom: 12, borderTopColor: '#ec489930' }}>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4, letterSpacing: 1 }}>PERSONA</div>
            <div style={{ fontFamily: F, fontSize: 9, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>I am MEDIA, the visual intelligence specialist. I manage all media assets across the Quox ecosystem — generating images on demand, ingesting screenshots from Browser-Q, processing video, and keeping everything tagged, linked, and lifecycle-managed.</div>
          </div>
          <div style={{ width: 100 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 4, letterSpacing: 1 }}>STATS</div>
            {[{ k: 'Delegation Score', v: '85' }, { k: 'Tools', v: '12' }, { k: 'Actions Today', v: '47' }, { k: 'Queue', v: '2' }].map((s, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{s.k}</span>
                <span style={{ fontFamily: M, fontSize: 8, color: '#ec4899', fontWeight: 600 }}>{s.v}</span>
              </div>
            ))}
          </div>
        </div>
      </GP>

      {/* Capabilities */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>CAPABILITIES</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 12 }}>
        {MQ_AGENT_CAPS.map((c, i) => {
          const op = lerp(f, i * 2, i * 2 + 8, 0, 1)
          return (
            <GP key={i} style={{ padding: '8px 10px', borderTopColor: `${c.color}15`, opacity: op }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 12 }}>{c.icon}</span>
                <span style={{ fontFamily: F, fontSize: 10, fontWeight: 600, color: '#fff' }}>{c.name}</span>
                <span style={{ fontFamily: M, fontSize: 6, padding: '1px 4px', borderRadius: 3, background: c.status === 'active' ? '#30ff9010' : '#f59e0b10', color: c.status === 'active' ? '#30ff90' : '#f59e0b', fontWeight: 600, marginLeft: 'auto' }}>{c.status}</span>
              </div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', lineHeight: 1.3 }}>{c.desc}</div>
            </GP>
          )
        })}
      </div>

      {/* Recent Actions */}
      <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 6, letterSpacing: 1 }}>RECENT ACTIONS</div>
      {MQ_AGENT_RECENT.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: a.color }} />
          <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{a.action}</span>
          <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{a.target}</span>
          <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{a.time}</span>
        </div>
      ))}
    </div>
  )
}

// ─── MQ6. MediaQTimeline — Temporal Media Stream ───
const MQ_TIMELINE_HOURS = [
  { hour: '14:00', items: [
    { title: 'Fleet topology diagram v3', source: 'ai-gen', agent: 'DAEDALUS', color: '#a855f7' },
    { title: 'Topology diagram v2 (wider)', source: 'ai-gen', agent: 'DAEDALUS', color: '#a855f7' },
  ]},
  { hour: '13:00', items: [
    { title: 'Hetzner console — server list', source: 'browser-q', agent: 'Browser-Q', color: '#06b6d4' },
    { title: 'Hetzner console — firewall rules', source: 'browser-q', agent: 'Browser-Q', color: '#06b6d4' },
    { title: 'Hetzner console — load balancer', source: 'browser-q', agent: 'Browser-Q', color: '#06b6d4' },
  ]},
  { hour: '12:00', items: [
    { title: 'Dashboard walkthrough recording', source: 'video', agent: 'MEDIA', color: '#6366f1' },
  ]},
  { hour: '11:00', items: [
    { title: 'Brand logo dark variant', source: 'upload', agent: 'Adam', color: '#f59e0b' },
    { title: 'Brand logo light variant', source: 'upload', agent: 'Adam', color: '#f59e0b' },
    { title: 'Icon set — 24 SVGs', source: 'upload', agent: 'Adam', color: '#f59e0b' },
  ]},
  { hour: '10:00', items: [
    { title: 'GitHub PR diff — auth refactor', source: 'browser-q', agent: 'Browser-Q', color: '#06b6d4' },
    { title: 'CI pipeline screenshot', source: 'browser-q', agent: 'Browser-Q', color: '#06b6d4' },
  ]},
  { hour: '09:00', items: [
    { title: 'Agent delegation flow diagram', source: 'ai-gen', agent: 'CODEX', color: '#a855f7' },
    { title: 'Delegation flow — alternate layout', source: 'ai-gen', agent: 'CODEX', color: '#a855f7' },
    { title: 'AOCL layer visualisation concept', source: 'ai-gen', agent: 'CODEX', color: '#a855f7' },
    { title: 'QuoxCORE banner v3', source: 'ai-gen', agent: 'MEDIA', color: '#ec4899' },
  ]},
]

export function MediaQTimeline() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>{'\uD83D\uDD52'}</span>
          <div>
            <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Media-Q — Timeline</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Today — 18 assets across 6 hours</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['Today', '7d', '30d', 'All'].map((p, i) => (
            <div key={i} style={{ padding: '3px 8px', borderRadius: 4, background: i === 0 ? '#ec489918' : 'rgba(255,255,255,0.03)', border: `1px solid ${i === 0 ? '#ec489925' : 'rgba(255,255,255,0.05)'}`, fontFamily: M, fontSize: 8, color: i === 0 ? '#ec4899' : 'rgba(255,255,255,0.4)', fontWeight: 600 }}>{p}</div>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div style={{ position: 'relative', paddingLeft: 50 }}>
        <div style={{ position: 'absolute', left: 38, top: 0, bottom: 0, width: 2, background: 'linear-gradient(to bottom, #ec489940 0%, #ec489910 100%)' }} />
        {MQ_TIMELINE_HOURS.map((block, bi) => (
          <div key={bi} style={{ marginBottom: 12 }}>
            {/* Hour marker */}
            <div style={{ position: 'relative', marginBottom: 6 }}>
              <div style={{ position: 'absolute', left: -46, top: 2, fontFamily: M, fontSize: 9, color: '#ec4899', fontWeight: 600, width: 32, textAlign: 'right' }}>{block.hour}</div>
              <div style={{ position: 'absolute', left: -16, top: 4, width: 8, height: 8, borderRadius: '50%', background: '#ec4899', border: '2px solid #080b14', boxShadow: '0 0 8px #ec489940' }} />
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', paddingLeft: 4 }}>{block.items.length} item{block.items.length > 1 ? 's' : ''}</div>
            </div>
            {/* Items */}
            {block.items.map((item, ii) => {
              const op = lerp(f, (bi * 3 + ii) * 2, (bi * 3 + ii) * 2 + 8, 0, 1)
              return (
                <div key={ii} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', marginBottom: 2, marginLeft: 4, borderRadius: 4, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', opacity: op }}>
                  <span style={{ fontSize: 10, opacity: 0.7 }}>{MQ_SOURCE_ICONS[item.source]}</span>
                  <span style={{ fontFamily: F, fontSize: 10, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{item.title}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: item.color }} />
                    <span style={{ fontFamily: M, fontSize: 7, color: item.color }}>{item.agent}</span>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── MQ7. MediaQAnalytics — Usage & Storage Analytics ───
const MQ_STORAGE_BREAKDOWN = [
  { label: 'Videos', value: 8.7, max: 20, color: '#6366f1', pct: 43.5 },
  { label: 'AI Images', value: 2.1, max: 20, color: '#a855f7', pct: 10.5 },
  { label: 'Screenshots', value: 1.2, max: 20, color: '#06b6d4', pct: 6.0 },
  { label: 'Uploads', value: 0.4, max: 20, color: '#f59e0b', pct: 2.0 },
]
const MQ_GEN_HISTORY = [
  { day: 'Mon', count: 14 }, { day: 'Tue', count: 23 }, { day: 'Wed', count: 8 },
  { day: 'Thu', count: 31 }, { day: 'Fri', count: 19 }, { day: 'Sat', count: 5 },
  { day: 'Sun', count: 2 },
]
const MQ_AGENT_USAGE = [
  { agent: 'DAEDALUS', images: 312, pct: 35, color: '#38bdf8' },
  { agent: 'Browser-Q', images: 614, pct: 33, color: '#06b6d4' },
  { agent: 'MEDIA', images: 287, pct: 15, color: '#ec4899' },
  { agent: 'CODEX', images: 156, pct: 8, color: '#a855f7' },
  { agent: 'Adam', images: 254, pct: 7, color: '#f59e0b' },
  { agent: 'Others', images: 224, pct: 2, color: 'rgba(255,255,255,0.3)' },
]

export function MediaQAnalytics() {
  const f = useAnimFrame()
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDCCA'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Media-Q — Analytics</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Storage, generation history, agent usage</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {/* Storage Breakdown */}
        <GP style={{ flex: 1, padding: 12 }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: 1 }}>STORAGE — 12.4 / 20 GB</div>
          {MQ_STORAGE_BREAKDOWN.map((s, i) => {
            const barW = lerp(f, i * 4, i * 4 + 15, 0, s.pct)
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontFamily: M, fontSize: 8, color: s.color, fontWeight: 600 }}>{s.label}</span>
                  <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{s.value} GB</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${barW}%`, borderRadius: 2, background: `linear-gradient(90deg, ${s.color} 0%, ${s.color}80 100%)`, transition: 'width 0.3s ease', boxShadow: `0 0 6px ${s.color}30` }} />
                </div>
              </div>
            )
          })}
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.05)', marginTop: 8, overflow: 'hidden', display: 'flex' }}>
            {MQ_STORAGE_BREAKDOWN.map((s, i) => <div key={i} style={{ height: '100%', width: `${s.pct}%`, background: s.color }} />)}
          </div>
          <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', marginTop: 4, textAlign: 'right' }}>62% used</div>
        </GP>

        {/* Generation History (7-day bar chart) */}
        <GP style={{ flex: 1, padding: 12 }}>
          <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: 1 }}>GENERATION HISTORY (7D)</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
            {MQ_GEN_HISTORY.map((d, i) => {
              const maxH = 70
              const h = lerp(f, i * 3, i * 3 + 12, 0, (d.count / 35) * maxH)
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                  <span style={{ fontFamily: M, fontSize: 7, color: '#ec4899', fontWeight: 600 }}>{d.count}</span>
                  <div style={{ width: '100%', height: h, borderRadius: '3px 3px 0 0', background: `linear-gradient(to top, #ec489940 0%, #ec4899 100%)`, minHeight: 2 }} />
                  <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{d.day}</span>
                </div>
              )
            })}
          </div>
          <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', marginTop: 6, textAlign: 'center' }}>102 total &nbsp;\u2022&nbsp; avg 14.6/day &nbsp;\u2022&nbsp; peak Thu (31)</div>
        </GP>
      </div>

      {/* Agent Usage Breakdown */}
      <GP style={{ padding: 12 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: 1 }}>MEDIA BY AGENT</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {MQ_AGENT_USAGE.map((a, i) => {
            const op = lerp(f, i * 3, i * 3 + 10, 0, 1)
            return (
              <div key={i} style={{ flex: 1, textAlign: 'center', opacity: op }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: `${a.color}15`, border: `1.5px solid ${a.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 4px', fontFamily: M, fontSize: 10, color: a.color, fontWeight: 700 }}>{a.agent[0]}</div>
                <div style={{ fontFamily: M, fontSize: 9, color: a.color, fontWeight: 700 }}>{a.images}</div>
                <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.4)' }}>{a.agent}</div>
                <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.05)', marginTop: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${a.pct}%`, background: a.color, borderRadius: 2 }} />
                </div>
              </div>
            )
          })}
        </div>
      </GP>
    </div>
  )
}

// ─── MQ8. MediaQSources — Source Integration & Health ───
const MQ_SOURCES = [
  {
    name: 'AI Image Generation', id: 'ai-gen', status: 'active', icon: '\uD83C\uDFA8', color: '#a855f7', accent: 'linear-gradient(135deg, #a855f7 0%, #6366f1 100%)',
    providers: [
      { name: 'DALL-E 3', status: 'active', count: 647, lastUsed: '3m ago' },
      { name: 'Midjourney v6', status: 'active', count: 189, lastUsed: '2h ago' },
      { name: 'Stable Diffusion XL', status: 'idle', count: 56, lastUsed: '3d ago' },
    ],
    stats: { today: 14, week: 102, total: 892 }
  },
  {
    name: 'Browser-Q Captures', id: 'browser-q', status: 'active', icon: '\uD83C\uDF10', color: '#06b6d4', accent: 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
    providers: [
      { name: 'Playwright Engine', status: 'active', count: 614, lastUsed: '12m ago' },
    ],
    stats: { today: 12, week: 87, total: 614 },
    note: 'Auto-imported — 30d expiry, override with "keep"'
  },
  {
    name: 'Video Capture', id: 'video', status: 'active', icon: '\uD83C\uDFA5', color: '#6366f1', accent: 'linear-gradient(135deg, #6366f1 0%, #ec4899 100%)',
    providers: [
      { name: 'Browser Video Recorder', status: 'active', count: 52, lastUsed: '1h ago' },
      { name: 'Remotion Renderer', status: 'idle', count: 35, lastUsed: '5d ago' },
    ],
    stats: { today: 1, week: 8, total: 87 }
  },
  {
    name: 'Manual Uploads', id: 'upload', status: 'active', icon: '\uD83D\uDCE4', color: '#f59e0b', accent: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
    providers: [
      { name: 'Dashboard Upload', status: 'active', count: 198, lastUsed: '2h ago' },
      { name: 'API Upload', status: 'active', count: 56, lastUsed: '1d ago' },
    ],
    stats: { today: 3, week: 18, total: 254 }
  },
]

export function MediaQSources() {
  const f = useAnimFrame()
  const pulse = 0.7 + Math.sin(f * 0.06) * 0.3
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{'\uD83D\uDD0C'}</span>
        <div>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>Media-Q — Sources & Integrations</div>
          <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>4 sources — all healthy — unified ingestion pipeline</div>
        </div>
      </div>

      {MQ_SOURCES.map((src, si) => {
        const op = lerp(f, si * 5, si * 5 + 12, 0, 1)
        return (
          <GP key={src.id} style={{ padding: 12, marginBottom: 8, borderTopColor: `${src.color}25`, opacity: op }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: src.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>{src.icon}</div>
                <div>
                  <div style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: '#fff' }}>{src.name}</div>
                  <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>{src.providers.length} provider{src.providers.length > 1 ? 's' : ''}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ display: 'flex', gap: 12, fontFamily: M, fontSize: 8 }}>
                  <div style={{ textAlign: 'center' }}><div style={{ color: src.color, fontWeight: 700 }}>{src.stats.today}</div><div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 7 }}>today</div></div>
                  <div style={{ textAlign: 'center' }}><div style={{ color: src.color, fontWeight: 700 }}>{src.stats.week}</div><div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 7 }}>week</div></div>
                  <div style={{ textAlign: 'center' }}><div style={{ color: src.color, fontWeight: 700 }}>{src.stats.total}</div><div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 7 }}>total</div></div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#30ff90', boxShadow: `0 0 ${4 + pulse * 3}px #30ff9040`, opacity: pulse }} />
                  <span style={{ fontFamily: M, fontSize: 8, color: '#30ff90', fontWeight: 600 }}>active</span>
                </div>
              </div>
            </div>

            {/* Providers */}
            <div style={{ display: 'flex', gap: 5 }}>
              {src.providers.map((p, pi) => {
                const pColor = p.status === 'active' ? '#30ff90' : 'rgba(255,255,255,0.3)'
                return (
                  <div key={pi} style={{ flex: 1, padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ fontFamily: F, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>{p.name}</span>
                      <span style={{ fontFamily: M, fontSize: 7, color: pColor, fontWeight: 600 }}>{p.status === 'active' ? '\u2713' : '\u25CB'} {p.status}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontFamily: M, fontSize: 7, color: src.color }}>{p.count} assets</span>
                      <span style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{p.lastUsed}</span>
                    </div>
                  </div>
                )
              })}
            </div>

            {src.note && <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,0.3)', marginTop: 6, fontStyle: 'italic' }}>{'\u2139\uFE0F'} {src.note}</div>}
          </GP>
        )
      })}

      <GP style={{ padding: 8, marginTop: 4 }}>
        <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.3)', textAlign: 'center' }}>
          All sources feed into unified gallery via ingestion pipeline. &nbsp;\u2022&nbsp; AOCL audit on every ingest. &nbsp;\u2022&nbsp; org_id scoped.
        </div>
      </GP>
    </div>
  )
}
