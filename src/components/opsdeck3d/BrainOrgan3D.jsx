/**
 * BrainOrgan3D: the data-driven living brain (Stream BRAIN-LIVE).
 *
 * Product twin of the website's Qortex hero visual, rebuilt in R3F and driven
 * by the org's REAL knowledge graph (the same graphData that ForceGraph2D and
 * ForceGraph3D draw) instead of a scripted cosmetic ladder:
 *
 *   - GHOST BRAIN: the anatomical shape, held by ~24k dim blue-grey points
 *     area-sampled onto the brain mesh surface (three's MeshSurfaceSampler,
 *     the same sampler drei's <Sampler> wraps). This is the dim vessel only.
 *   - LIVE NEURONS: one bright point per REAL note. Each note is placed at a
 *     deterministic position sampled on the brain surface via a PRNG seeded
 *     from a hash of its note id, so the same note always lands in the same
 *     place regardless of which other notes are loaded, the facet filters, or
 *     the ordering. Colour matches the 2D/3D scope/source palette; size grows
 *     with the note's link degree. Clicking a neuron selects that note.
 *   - AXONS: one glowing additive line per REAL graph link, drawn between the
 *     connected notes' neuron positions, with occasional travelling pulses.
 *   - MILESTONE: the real /brain/status band + note count caption the canvas.
 *
 * Positions depend on the brain glb geometry. If rotten-brain-geo.glb is ever
 * re-exported, every note position shifts (the sampler face table changes).
 *
 * NOT barrel-exported and only ever lazy-loaded (see QuoxbrainView.jsx):
 * static imports of R3F views crash every page (CLAUDE.md R3F rules).
 * All R3F hooks (useFrame/useThree/useGLTF) live in components mounted
 * INSIDE <Canvas>. Hover and selection state that drives the HTML overlay
 * lives in the OUTER component (event handlers are plain functions, legal
 * anywhere). Perf: 3 draw calls (ghost Points + neuron Points + axon
 * LineSegments) + bloom. prefers-reduced-motion => a calm static brain.
 */

import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF, OrbitControls } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js'
import * as THREE from 'three'

const BRAIN_GLB_URL = '/assets/brain/rotten-brain-geo.glb'

// Points sampled onto the brain surface for the dim anatomical vessel.
const GHOST_POINTS = 24000
// World-unit radius the sampled brain is normalized to (camera at z=18).
const BRAIN_SCALE = 6.0

// Fallback note colour by scope when no getNodeColor prop is supplied, kept
// in sync with QuoxbrainView's SCOPE_COLORS palette.
const SCOPE_COLORS = { org: '#38bdf8', user: '#a855f7', shared: '#f59e0b' }
const DEFAULT_NEURON_HEX = '#38bdf8'

// Real /brain/status bands (services/quoxbrain: dormant|forming|growing|
// alive|dense) mapped to on-canvas caption text.
const BAND_LABELS = {
  dormant: 'Dormant',
  forming: 'First sparks',
  growing: 'Growing',
  alive: 'Alive',
  dense: 'Dense · alive',
}

// ─────────────────────────────────────────────────────────────────────────
// Shaders. Colours are deeper than the brand hex on purpose: additive
// stacking + ACES tone mapping (R3F default) lift them back to brand values.
// ─────────────────────────────────────────────────────────────────────────

// Ghost vessel: dim, shimmering blue-grey points. No note data.
const POINTS_VERT = /* glsl */ `
  uniform float uTime, uFade, uPx;
  attribute vec4 aRand;
  varying vec3 vColor;
  varying float vAlpha;
  const vec3 C_GHOST = vec3(0.260, 0.345, 0.520);
  void main() {
    float ghostA = 0.108 + 0.058 * aRand.y + 0.02 * sin(uTime * 0.8 + aRand.w * 6.283);
    vColor = C_GHOST;
    vAlpha = ghostA * uFade;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float sizeW = 0.046 + 0.013 * aRand.x;
    gl_PointSize = clamp(sizeW * uPx / -mv.z, 0.0, 14.0);
    gl_Position = projectionMatrix * mv;
  }`

const POINTS_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float l = length(d);
    if (l > 0.5) discard;
    float a = exp(-l * l * 9.0) - 0.105;
    gl_FragColor = vec4(vColor, max(a, 0.0) * vAlpha);
  }`

// Live neurons: one bright point per real note. aColor from the scope/source
// palette, aSize from link degree, gentle pulse from aRand, white flash on the
// selected neuron (uSelected carries its vertex index, -1 = none).
// aMatch (0/1, per note) + uHighlightActive drive the search-coupling
// treatment (BRAIN2-PRODUCT P1e): dim everything that isn't a search hit,
// and pulse/brighten what is — same "carry state as a shader input, follow
// the selected-neuron pattern" idiom as uSelected/aIndex above, just
// per-vertex instead of a single index since a search can match many notes.
const NEURON_VERT = /* glsl */ `
  uniform float uTime, uFade, uPx, uSelected, uHighlightActive;
  uniform float uPhase, uPhaseT, uYMin, uYRange;
  uniform float uSparkT, uDreamT, uShimmer, uIngestT;
  attribute vec3 aColor;
  attribute float aSize;
  attribute vec4 aRand;
  attribute float aIndex;
  attribute float aMatch;
  attribute float aSpark;
  varying vec3 vColor;
  varying float vAlpha;
  const vec3 C_WHITE = vec3(1.000, 0.985, 0.950);
  const vec3 C_INGEST = vec3(1.000, 0.820, 0.380);
  void main() {
    float sel = step(abs(aIndex - uSelected), 0.5);
    float hlDim = uHighlightActive * (1.0 - aMatch);
    float hlBoost = uHighlightActive * aMatch;
    float pulse = 0.72 + 0.28 * sin(uTime * 1.7 + aRand.w * 6.28318);
    float spark = pow(max(sin(uTime * 2.1 + aRand.z * 91.7), 0.0), 20.0);
    float matchPulse = 0.5 + 0.5 * sin(uTime * 3.2 + aRand.x * 6.28318);
    // Living-brain reactivity, driven by the REAL Cortex turn phase (uPhase):
    //   1 = searching  -> a bright band sweeps up the brain (it reads itself)
    //   2 = answering  -> the cited neurons (aMatch) flare, then decay
    // Idle (0) fires neither (both gates resolve to 0), so nothing is scripted.
    float phaseSearch = step(0.5, uPhase) * (1.0 - step(1.5, uPhase));
    float phaseAnswer = step(1.5, uPhase);
    float normH = clamp((position.y - uYMin) / max(uYRange, 0.0001), 0.0, 1.0);
    float sweep = fract(uPhaseT * 0.5);
    float scanBand = exp(-pow((normH - sweep) * 5.0, 2.0)) * phaseSearch;
    float flare = phaseAnswer * exp(-uPhaseT * 0.9) * aMatch;
    // Autonomic life, driven by REAL /brain/activity events (never scripted):
    //   aSpark  -> a newly INGESTED note is born: a bright flash that decays (~2s)
    //   uDreamT -> a QuoxDream consolidation wave sweeps slowly through (~6s)
    //   uShimmer-> embedding/index work in progress adds a faint extra twinkle
    float spark2 = aSpark * exp(-uSparkT * 1.5);
    float dreamSweep = fract(uDreamT * 0.18);
    float dreamWave = exp(-pow((normH - dreamSweep) * 3.5, 2.0)) * (1.0 - step(6.0, uDreamT));
    float shimmerBoost = spark * uShimmer * 1.8;
    // Ambient ingest glow: a brief whole-brain swell (with a twinkle) when real
    // knowledge arrives that we can't place on a specific rendered neuron.
    float ingestGlow = exp(-uIngestT * 0.6) * (1.0 - step(7.0, uIngestT));
    vec3 c = mix(aColor, C_WHITE, clamp(spark * 0.35 + sel * 0.75 + hlBoost * 0.5 + scanBand * 0.6 + flare * 0.9 + spark2 + dreamWave * 0.4, 0.0, 1.0));
    // Ingest flushes the brain gold — a distinct "new knowledge arrived" wave,
    // visually separate from the cool search/dream effects. Pushed hard (0.85):
    // a weaker mix cannot overcome the cool base colour of dim neurons under
    // additive blending, so the flush was computed but invisible.
    c = mix(c, C_INGEST, clamp(ingestGlow * 0.85, 0.0, 1.0));
    vColor = c;
    float baseAlpha = ((0.55 + 0.30 * aRand.y) * pulse + spark * 0.30) * uFade + sel * 0.4;
    // ingest alpha kept modest (0.26): additive stacking of hundreds of gold
    // fragments summed past gold into a white-hot blowout at 0.55. Lower add =
    // the brain warms to GOLD, not white (owner taste, loose end #2). The gold
    // hue lives in the colour mix above, so cutting brightness keeps the colour.
    vAlpha = mix(baseAlpha, baseAlpha * 0.10, hlDim) + hlBoost * (0.35 + 0.25 * matchPulse) + scanBand * 0.5 + flare * 0.8 + spark2 * 0.9 + dreamWave * 0.35 + shimmerBoost * 0.3 + ingestGlow * 0.26;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float sizeW = aSize * (1.0 + 0.12 * sin(uTime * 1.9 + aRand.x * 6.283)) * (1.0 + sel * 0.6) * (1.0 + hlBoost * 0.55 * matchPulse) * (1.0 + flare * 0.9 + scanBand * 0.35 + spark2 * 1.3);
    gl_PointSize = clamp(sizeW * uPx / -mv.z, 1.0, 40.0);
    gl_Position = projectionMatrix * mv;
  }`

const NEURON_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float l = length(d);
    if (l > 0.5) discard;
    float core = exp(-l * l * 7.0);
    float a = core - 0.06;
    gl_FragColor = vec4(vColor, max(a, 0.0) * vAlpha);
  }`

const AXON_VERT = /* glsl */ `
  uniform float uYMin, uYRange;
  attribute float aT;
  attribute vec4 aInf;
  varying float vT;
  varying vec4 vInf;
  varying float vH;
  void main() {
    vT = aT; vInf = aInf;
    vH = clamp((position.y - uYMin) / max(uYRange, 0.0001), 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`

// Real axons: always visible (no ignition gate), with an occasional thought
// pulse travelling from one endpoint to the other.
const AXON_FRAG = /* glsl */ `
  uniform float uTime, uFade, uIngestT, uDreamT, uSparkT;
  varying float vT;
  varying vec4 vInf;
  varying float vH;
  const vec3 C_CYAN   = vec3(0.070, 0.550, 0.990);
  const vec3 C_PURPLE = vec3(0.560, 0.180, 0.980);
  const vec3 C_WHITE  = vec3(1.000, 0.985, 0.950);
  const vec3 C_INGEST = vec3(1.000, 0.820, 0.380);
  const vec3 C_DREAM  = vec3(0.750, 0.620, 1.000);
  void main() {
    /* an occasional thought fires down the axon */
    float gate = pow(max(sin(uTime * (0.45 + vInf.y * 0.65) + vInf.x * 6.28318), 0.0), 18.0);
    float head = fract(uTime * (0.16 + vInf.y * 0.22) + vInf.x);
    float pulse = exp(-abs(vT - head) * 7.0) * gate;
    vec3 col = mix(C_CYAN, C_PURPLE, vT);
    col = mix(col, C_WHITE, clamp(pulse, 0.0, 1.0));
    float a = (0.085 + 0.05 * vInf.w + pulse * 0.8) * uFade;
    /* Dream sweep: a QuoxDream consolidation wave rolls up the web in violet,
       spatially matched to the neuron dreamWave via vH (~6s). */
    float dreamSweep = fract(uDreamT * 0.18);
    float dreamWave = exp(-pow((vH - dreamSweep) * 3.5, 2.0)) * (1.0 - step(6.0, uDreamT));
    col = mix(col, C_DREAM, clamp(dreamWave * 0.55, 0.0, 1.0));
    a += dreamWave * 0.30 * uFade;
    /* Index/embed spark: a global white crackle races the whole web on a real
       embedding event (kept a crackle, not a blowout). */
    float spark = exp(-uSparkT * 1.5) * (1.0 - step(3.0, uSparkT));
    col = mix(col, C_WHITE, clamp(spark * 0.40, 0.0, 1.0));
    a += spark * 0.22 * uFade;
    /* Ingest flush: the whole axon web goes gold + brightens on a real ingest,
       so the "new knowledge" wave reads across the brain, not just the neurons. */
    float ingestGlow = exp(-uIngestT * 0.6) * (1.0 - step(7.0, uIngestT));
    col = mix(col, C_INGEST, clamp(ingestGlow * 0.9, 0.0, 1.0));
    a += ingestGlow * 0.18 * uFade;
    gl_FragColor = vec4(col, a);
  }`

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

// Deterministic PRNG for the ghost aRand field: same field every visit.
function makeRng(seed) {
  let s = seed
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 }
}

// FNV-1a 32-bit string hash → seed for per-note deterministic placement.
function hash32(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// mulberry32 PRNG, seeded purely from the note id hash, so a note's surface
// point never depends on the node set, ordering, or facet filters.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// react-force-graph mutates link source/target from id strings into node
// object references once a 2D/3D sim has run, so resolve either shape.
function linkEndId(end) {
  return (typeof end === 'object' && end !== null) ? end.id : end
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ))
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = () => setReduced(mq.matches)
    if (mq.addEventListener) mq.addEventListener('change', handler)
    else mq.addListener(handler)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler)
      else mq.removeListener(handler)
    }
  }, [])
  return reduced
}

// ─────────────────────────────────────────────────────────────────────────
// Scene (INSIDE <Canvas>, the only place R3F hooks may run)
// ─────────────────────────────────────────────────────────────────────────

function BrainScene({ reducedMotion, spinEnabled, nodes, links, onSelectNote, selectedNoteId, getNodeColor, onHoverNote, highlightIds, activity, autonomic }) {
  const { scene } = useGLTF(BRAIN_GLB_URL)
  const invalidate = useThree((s) => s.invalidate)
  const gl = useThree((s) => s.gl)
  const groupRef = useRef()
  // Living-brain: clock time (uTime seconds) at the last activity-phase change,
  // so useFrame can drive uPhaseT (seconds-since-phase-change) for the sweep/flare.
  const phaseChangedAtRef = useRef(0)
  // Autonomic: clock time at the last ingest-spark and the last dream pulse, so
  // useFrame drives uSparkT/uDreamT (seconds-since) for the flash/wave decay.
  const sparkStartedAtRef = useRef(-999)
  const dreamStartedAtRef = useRef(-999)
  const prevDreamPulseRef = useRef(0)
  const ingestStartedAtRef = useRef(-999)
  const prevIngestPulseRef = useRef(0)

  // Build the ghost vessel + shared materials ONCE per mesh. Also expose the
  // sampler + coordinate transform so the neuron layer can project real notes
  // into the SAME normalized space.
  const built = useMemo(() => {
    let mesh = null
    scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj })
    if (!mesh) return null
    scene.updateMatrixWorld(true)

    const rng = makeRng(20260720)

    // Area-weighted surface sampling for the dim vessel. Seed the sampler's
    // random generator so the ghost field, its centroid, and the normalization
    // scale are exactly reproducible per glb asset. This makes the derived
    // neuron positions fully deterministic across page loads (same field every
    // visit), not just within a single session.
    const sampler = new MeshSurfaceSampler(mesh)
    sampler.build()
    sampler.setRandomGenerator(rng)
    const positions = new Float32Array(GHOST_POINTS * 3)
    const p = new THREE.Vector3()
    for (let i = 0; i < GHOST_POINTS; i++) {
      sampler.sample(p)
      p.applyMatrix4(mesh.matrixWorld) // bake the glb's node scale/offset
      positions[i * 3] = p.x
      positions[i * 3 + 1] = p.y
      positions[i * 3 + 2] = p.z
    }

    // Recenter on the sampled centroid + normalize to BRAIN_SCALE.
    let cx = 0, cy = 0, cz = 0
    for (let i = 0; i < GHOST_POINTS; i++) { cx += positions[i * 3]; cy += positions[i * 3 + 1]; cz += positions[i * 3 + 2] }
    cx /= GHOST_POINTS; cy /= GHOST_POINTS; cz /= GHOST_POINTS
    let maxR = 0
    for (let i = 0; i < GHOST_POINTS; i++) {
      const dx = positions[i * 3] - cx, dy = positions[i * 3 + 1] - cy, dz = positions[i * 3 + 2] - cz
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (r > maxR) maxR = r
    }
    const s = maxR > 0 ? BRAIN_SCALE / maxR : 1
    for (let i = 0; i < GHOST_POINTS; i++) {
      positions[i * 3] = (positions[i * 3] - cx) * s
      positions[i * 3 + 1] = (positions[i * 3 + 1] - cy) * s
      positions[i * 3 + 2] = (positions[i * 3 + 2] - cz) * s
    }

    const aRand = new Float32Array(GHOST_POINTS * 4)
    for (let i = 0; i < aRand.length; i++) aRand[i] = rng()

    const pointsGeo = new THREE.BufferGeometry()
    pointsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    pointsGeo.setAttribute('aRand', new THREE.BufferAttribute(aRand, 4))

    // Shared uniforms: one object, all materials, one write per frame.
    // uSelected is only read by the neuron shader (ghost/axon ignore it).
    const uniforms = {
      uTime: { value: 0 },
      uFade: { value: 0 },
      uPx: { value: 600 },
      uSelected: { value: -1 },
      uHighlightActive: { value: 0 },
      // BRAIN2-CORTEX P1b living brain: real-activity reactivity. uPhase 0=idle
      // 1=searching 2=answering (driven from the Cortex turn state, never a
      // script). uPhaseT = seconds since the phase changed (drives the scan-wave
      // sweep + the answer flare decay). uYMin/uYRange normalise neuron height
      // for the spatial scan band (set from neuronData's real extent).
      uPhase: { value: 0 },
      uPhaseT: { value: 0 },
      uYMin: { value: 0 },
      uYRange: { value: 1 },
      // Autonomic (real /brain/activity): uSparkT/uDreamT start large so the
      // decay/step gates keep the birth-flash and dream wave inert until an
      // actual event resets them to 0. uShimmer 0 = no indexing twinkle.
      uSparkT: { value: 999 },
      uDreamT: { value: 999 },
      uShimmer: { value: 0 },
      // Ambient ingest glow: a whole-brain swell when any real note is ingested
      // (even one not in the render). Large default = inert until an event.
      uIngestT: { value: 999 },
    }
    const pointsMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    const neuronMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: NEURON_VERT,
      fragmentShader: NEURON_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    const axonMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: AXON_VERT,
      fragmentShader: AXON_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })

    return {
      pointsGeo, pointsMat, neuronMat, axonMat, uniforms,
      sampler, matrixWorld: mesh.matrixWorld.clone(), center: [cx, cy, cz], scale: s,
    }
  }, [scene])

  // Real neurons: one bright point per note at a deterministic surface point.
  const neuronData = useMemo(() => {
    if (!built || !nodes || nodes.length === 0) return null
    const { sampler, matrixWorld, center, scale } = built
    const [cx, cy, cz] = center
    const n = nodes.length
    const position = new Float32Array(n * 3)
    const aColor = new Float32Array(n * 3)
    const aSize = new Float32Array(n)
    const aRand = new Float32Array(n * 4)
    const aIndex = new Float32Array(n)
    // Search-match flag (BRAIN2-PRODUCT P1e), all-zero until the highlightIds
    // effect below fills it in — kept as a real attribute (not derived) so the
    // shader never has to branch on whether a search is active vs empty.
    const aMatch = new Float32Array(n)
    // Autonomic birth-flash flag: set to 1 for neurons whose note was just
    // ingested (real /brain/activity), decayed in-shader via uSparkT. All-zero
    // until the autonomic effect below fills it, same idiom as aMatch.
    const aSpark = new Float32Array(n)
    const idToIndex = new Map()
    const p = new THREE.Vector3()
    const col = new THREE.Color()
    // Track the real vertical extent of the neurons so the living-brain scan
    // band (shader) can normalise height to 0..1 without hardcoding a range.
    let yMin = Infinity
    let yMax = -Infinity
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      const id = String(node.id)
      idToIndex.set(id, i)
      // Seed purely from the id: deterministic placement, membership-independent.
      const prng = mulberry32(hash32(id))
      sampler.setRandomGenerator(prng)
      sampler.sample(p)
      p.applyMatrix4(matrixWorld)
      position[i * 3] = (p.x - cx) * scale
      const py = (p.y - cy) * scale
      position[i * 3 + 1] = py
      position[i * 3 + 2] = (p.z - cz) * scale
      if (py < yMin) yMin = py
      if (py > yMax) yMax = py
      let hex = DEFAULT_NEURON_HEX
      if (typeof getNodeColor === 'function') {
        const c = getNodeColor(node)
        if (typeof c === 'string' && c) hex = c
      } else {
        hex = SCOPE_COLORS[node.scope] || '#94a3b8'
      }
      try { col.set(hex) } catch { col.set(DEFAULT_NEURON_HEX) }
      aColor[i * 3] = col.r; aColor[i * 3 + 1] = col.g; aColor[i * 3 + 2] = col.b
      const deg = node.degree || 0
      aSize[i] = 0.10 + Math.min(deg, 24) * 0.012
      aRand[i * 4] = prng(); aRand[i * 4 + 1] = prng(); aRand[i * 4 + 2] = prng(); aRand[i * 4 + 3] = prng()
      aIndex[i] = i
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1))
    geo.setAttribute('aRand', new THREE.BufferAttribute(aRand, 4))
    geo.setAttribute('aIndex', new THREE.BufferAttribute(aIndex, 1))
    geo.setAttribute('aMatch', new THREE.BufferAttribute(aMatch, 1))
    geo.setAttribute('aSpark', new THREE.BufferAttribute(aSpark, 1))
    const yRange = Number.isFinite(yMin) && yMax > yMin ? yMax - yMin : 1
    return { geo, idToIndex, positions: position, yMin: Number.isFinite(yMin) ? yMin : 0, yRange }
  }, [built, nodes, getNodeColor])

  // Real axons: one additive line per resolvable graph link.
  const axonData = useMemo(() => {
    if (!neuronData || !links || links.length === 0) return null
    const { idToIndex, positions } = neuronData
    const segPos = []
    const segT = []
    const segInf = []
    for (let k = 0; k < links.length; k++) {
      const link = links[k]
      const a = String(linkEndId(link.source))
      const b = String(linkEndId(link.target))
      const ia = idToIndex.get(a)
      const ib = idToIndex.get(b)
      if (ia === undefined || ib === undefined) continue
      const prng = mulberry32(hash32(a + '::' + b))
      const phase = prng(), speed = prng(), r4 = prng()
      segPos.push(positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2])
      segT.push(0)
      segInf.push(phase, speed, 0, r4)
      segPos.push(positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2])
      segT.push(1)
      segInf.push(phase, speed, 0, r4)
    }
    if (segPos.length === 0) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segPos), 3))
    geo.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(segT), 1))
    geo.setAttribute('aInf', new THREE.BufferAttribute(new Float32Array(segInf), 4))
    return { geo }
  }, [neuronData, links])

  // Dispose the shared build (ghost geo + all three materials) on unmount.
  useEffect(() => {
    if (!built) return
    return () => {
      try {
        built.pointsGeo.dispose()
        built.pointsMat.dispose(); built.neuronMat.dispose(); built.axonMat.dispose()
      } catch { /* already gone */ }
    }
  }, [built])

  // Dispose the per-data geometries when they rebuild / unmount.
  useEffect(() => {
    if (!neuronData) return
    return () => { try { neuronData.geo.dispose() } catch { /* already gone */ } }
  }, [neuronData])
  useEffect(() => {
    if (!axonData) return
    return () => { try { axonData.geo.dispose() } catch { /* already gone */ } }
  }, [axonData])

  // A fresh geometry needs a repaint under the reduced-motion demand loop.
  useEffect(() => { invalidate() }, [neuronData, axonData, invalidate])

  // Sync the selected note to the shader (white flash + larger point).
  useEffect(() => {
    if (!built) return
    let idx = -1
    if (neuronData && selectedNoteId != null) {
      const found = neuronData.idToIndex.get(String(selectedNoteId))
      if (found !== undefined) idx = found
    }
    built.uniforms.uSelected.value = idx
    invalidate()
  }, [built, neuronData, selectedNoteId, invalidate])

  // Sync the search-match set to the shader (dim non-matches, pulse matches).
  // Only touches the aMatch array when a search is actually active — when it
  // isn't, uHighlightActive drops to 0 and the shader ignores stale aMatch
  // values entirely, so there's no need to zero them out on every clear.
  useEffect(() => {
    if (!built || !neuronData) return
    const attr = neuronData.geo.getAttribute('aMatch')
    const active = Boolean(highlightIds) && highlightIds.size > 0
    if (attr && active) {
      const arr = attr.array
      arr.fill(0)
      for (const id of highlightIds) {
        const idx = neuronData.idToIndex.get(String(id))
        if (idx !== undefined) arr[idx] = 1
      }
      attr.needsUpdate = true
    }
    built.uniforms.uHighlightActive.value = active ? 1 : 0
    invalidate()
  }, [built, neuronData, highlightIds, invalidate])

  // Living-brain: feed the real neuron height extent into the scan-band
  // normaliser so the searching sweep covers the actual brain, not a guess.
  useEffect(() => {
    if (!built || !neuronData) return
    built.uniforms.uYMin.value = neuronData.yMin
    built.uniforms.uYRange.value = neuronData.yRange
    invalidate()
  }, [built, neuronData, invalidate])

  // Living-brain: map the REAL Cortex turn phase (idle/searching/answering) to
  // the shader. Stamp the current uTime as the phase-change moment so uPhaseT
  // (driven in useFrame) restarts the sweep/flare from zero each transition.
  useEffect(() => {
    if (!built) return
    const phase = activity && activity.phase
    built.uniforms.uPhase.value = phase === 'searching' ? 1 : phase === 'answering' ? 2 : 0
    phaseChangedAtRef.current = built.uniforms.uTime.value
    built.uniforms.uPhaseT.value = 0
    invalidate()
  }, [built, activity, invalidate])

  // Autonomic ingest spark: mark the just-ingested neurons (real note ids that
  // are in the rendered graph) and restart the birth-flash clock. Only fires when
  // there are new ones — an empty/absent set leaves prior sparks to decay out.
  useEffect(() => {
    if (!built || !neuronData) return
    const sparkIds = autonomic && autonomic.sparkIds
    if (!sparkIds || sparkIds.size === 0) return
    const attr = neuronData.geo.getAttribute('aSpark')
    if (!attr) return
    const arr = attr.array
    arr.fill(0)
    for (const id of sparkIds) {
      const idx = neuronData.idToIndex.get(String(id))
      if (idx !== undefined) arr[idx] = 1
    }
    attr.needsUpdate = true
    sparkStartedAtRef.current = built.uniforms.uTime.value
    built.uniforms.uSparkT.value = 0
    invalidate()
  }, [built, neuronData, autonomic, invalidate])

  // Autonomic dream wave (on a new QuoxDream run) + indexing shimmer (embedding
  // work in progress). dreamPulse is a monotonic counter; a change restarts the
  // wave clock. shimmer maps straight to a uniform.
  useEffect(() => {
    if (!built) return
    const pulse = (autonomic && autonomic.dreamPulse) || 0
    if (pulse !== prevDreamPulseRef.current) {
      prevDreamPulseRef.current = pulse
      if (pulse > 0) {
        dreamStartedAtRef.current = built.uniforms.uTime.value
        built.uniforms.uDreamT.value = 0
      }
    }
    const ingestPulse = (autonomic && autonomic.ingestPulse) || 0
    if (ingestPulse !== prevIngestPulseRef.current) {
      prevIngestPulseRef.current = ingestPulse
      if (ingestPulse > 0) {
        ingestStartedAtRef.current = built.uniforms.uTime.value
        built.uniforms.uIngestT.value = 0
      }
    }
    built.uniforms.uShimmer.value = (autonomic && autonomic.shimmer) || 0
    invalidate()
  }, [built, autonomic, invalidate])

  // Reduced motion: one static, fully-eased frame, no rotation, no pulse.
  useEffect(() => {
    if (!built || !reducedMotion) return
    built.uniforms.uTime.value = 12.34
    built.uniforms.uFade.value = 1
    if (groupRef.current) groupRef.current.rotation.set(0.15, -0.5, 0)
    invalidate()
  }, [built, reducedMotion, invalidate])

  useFrame((state, delta) => {
    if (!built) return
    const u = built.uniforms
    // uPx: world-size → pixel-size conversion for gl_PointSize (fov 42 → half-angle 21°).
    u.uPx.value = (state.size.height * state.viewport.dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(21)))
    if (reducedMotion) return
    const dt = Math.min(delta, 0.05)
    const t = state.clock.elapsedTime
    u.uTime.value = t
    // Living-brain: seconds since the last Cortex phase change drives the search
    // sweep position and the answer-flare decay in the neuron shader.
    u.uPhaseT.value = t - phaseChangedAtRef.current
    // Autonomic: seconds since the last ingest spark / dream pulse drive the
    // birth-flash decay and the consolidation-wave sweep.
    u.uSparkT.value = t - sparkStartedAtRef.current
    u.uDreamT.value = t - dreamStartedAtRef.current
    u.uIngestT.value = t - ingestStartedAtRef.current
    u.uFade.value = Math.min(u.uFade.value + dt * 0.8, 1)
    // Ambient life: slow rotation, gentle drift, a barely-there breath. Spin
    // toggle (BRAIN2-PRODUCT P1c) only freezes THIS block — shader time
    // (uTime/uFade), pulses and sparks above keep running, and hover/click
    // stay live, so a paused brain still reads as alive, just not rotating.
    // "Freeze" means stop advancing, not reset: the group simply keeps
    // whatever rotation/scale it had on the frame spin was turned off.
    if (spinEnabled && groupRef.current) {
      groupRef.current.rotation.y = -0.45 + t * 0.075
      groupRef.current.rotation.x = 0.14 + 0.03 * Math.sin(t * 0.23)
      groupRef.current.scale.setScalar(1 + 0.006 * Math.sin(t * 0.85))
    }
  })

  if (!built) return null

  const handleClick = (e) => {
    e.stopPropagation()
    const node = nodes && nodes[e.index]
    if (node) onSelectNote?.(node)
  }
  const handleOver = (e) => {
    e.stopPropagation()
    const node = nodes && nodes[e.index]
    if (node) {
      onHoverNote?.(node)
      if (gl?.domElement) gl.domElement.style.cursor = 'pointer'
    }
  }
  const handleOut = () => {
    onHoverNote?.(null)
    if (gl?.domElement) gl.domElement.style.cursor = ''
  }

  return (
    <group ref={groupRef}>
      {/* Dim anatomical vessel, never pickable. */}
      <points geometry={built.pointsGeo} material={built.pointsMat} frustumCulled={false} raycast={() => null} />
      {/* Real note neurons, the only pickable layer. */}
      {neuronData && (
        <points
          geometry={neuronData.geo}
          material={built.neuronMat}
          frustumCulled={false}
          onClick={handleClick}
          onPointerOver={handleOver}
          onPointerOut={handleOut}
        />
      )}
      {/* Real graph links, never pickable. */}
      {axonData && (
        <lineSegments geometry={axonData.geo} material={built.axonMat} frustumCulled={false} raycast={() => null} />
      )}
    </group>
  )
}

useGLTF.preload(BRAIN_GLB_URL)

// ─────────────────────────────────────────────────────────────────────────
// Error boundary: a WebGL/loader failure degrades to a quiet message,
// never a blank page (the parent view stays fully usable in 2D/3D modes).
// ─────────────────────────────────────────────────────────────────────────

class BrainErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err) {
    console.warn('BrainOrgan3D failed, falling back:', err?.message || err)
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="qx-empty" style={{ height: '100%' }}>
          <p className="qx-empty__title">Living brain unavailable</p>
          <p className="qx-empty__body">
            This device could not start the WebGL brain view. Switch to the 2D or 3D graph above.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public component (default export, lazy-load me)
// ─────────────────────────────────────────────────────────────────────────

export default function BrainOrgan3D({
  noteCount = 0,
  status = 'dormant',
  milestone = null,
  nodes = [],
  links = [],
  onSelectNote = null,
  selectedNoteId = null,
  getNodeColor = null,
  spinEnabled = true,
  highlightIds = null,
  activity = null,
  autonomic = null,
}) {
  const reducedMotion = useReducedMotion()
  const [hoveredNote, setHoveredNote] = useState(null)
  const bandLabel = BAND_LABELS[status] || status

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <BrainErrorBoundary>
        <Canvas
          dpr={[1, 1.75]}
          gl={{ antialias: false, powerPreference: 'high-performance' }}
          camera={{ position: [0, 0.4, 18], fov: 42, near: 0.1, far: 120 }}
          frameloop={reducedMotion ? 'demand' : 'always'}
          raycaster={{ params: { Points: { threshold: 0.16 } } }}
        >
          <color attach="background" args={['#080b14']} />
          {/* Fly the brain: zoom in past the surface, pan, and orbit. minDistance
              is small so the camera can move fully inside the point cloud. */}
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.08}
            rotateSpeed={0.55}
            zoomSpeed={0.9}
            panSpeed={0.7}
            minDistance={0.6}
            maxDistance={60}
            target={[0, 0.4, 0]}
          />
          <Suspense fallback={null}>
            <BrainScene
              reducedMotion={reducedMotion}
              spinEnabled={spinEnabled}
              nodes={nodes}
              links={links}
              onSelectNote={onSelectNote}
              selectedNoteId={selectedNoteId}
              getNodeColor={getNodeColor}
              onHoverNote={setHoveredNote}
              highlightIds={highlightIds}
              activity={activity}
              autonomic={autonomic}
            />
            <EffectComposer>
              <Bloom intensity={0.7} luminanceThreshold={0.18} luminanceSmoothing={0.6} mipmapBlur />
            </EffectComposer>
          </Suspense>
        </Canvas>
      </BrainErrorBoundary>

      {/* Hover chip: the plain title of the note under the cursor. */}
      {hoveredNote && (
        <div
          style={{
            position: 'absolute',
            right: 16,
            top: 14,
            maxWidth: 260,
            pointerEvents: 'none',
            userSelect: 'none',
            zIndex: 3,
            font: '500 12px/1.4 var(--qx-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            color: '#e2e8f0',
            background: 'rgba(8,11,20,0.72)',
            border: '1px solid rgba(56,189,248,0.28)',
            borderRadius: 8,
            padding: '6px 10px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {hoveredNote.title || hoveredNote.id}
        </div>
      )}

      {/* Milestone caption: REAL band + count from /brain/status, mono like
          the website's. aria-hidden: the same numbers live in the header. */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', left: 20, bottom: 18, pointerEvents: 'none', userSelect: 'none', zIndex: 2 }}
      >
        <div
          style={{
            font: '500 10px/1.4 var(--qx-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            letterSpacing: '0.24em',
            textTransform: 'uppercase',
            color: 'rgba(148,163,184,0.72)',
          }}
        >
          {bandLabel}
        </div>
        <div
          style={{
            marginTop: 5,
            font: '600 19px/1.2 var(--qx-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            fontVariantNumeric: 'tabular-nums',
            color: '#38bdf8',
            textShadow: '0 0 18px rgba(56,189,248,0.35)',
          }}
        >
          {Math.round(noteCount).toLocaleString('en-US')} notes
        </div>
        {milestone?.remaining > 0 && (
          <div style={{ marginTop: 3, font: '500 10px/1.4 var(--qx-font-mono, ui-monospace, monospace)', color: 'rgba(148,163,184,0.6)' }}>
            {milestone.remaining.toLocaleString('en-US')} to {milestone.label || 'next milestone'}
          </div>
        )}
      </div>
    </div>
  )
}
