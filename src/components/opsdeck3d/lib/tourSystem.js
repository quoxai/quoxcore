/**
 * CC3D Tour System — Pre-defined and custom camera path tours.
 *
 * V2-QFY-3: Schedulable Tours.
 * Tours are sequences of camera stops with narration text.
 * Can be saved as templates and scheduled via objectives API.
 *
 * Usage:
 *   import { TOURS, runTour, saveTourAsTemplate } from '../lib/tourSystem'
 *   const cancel = runTour('welcome', { onStop, onComplete })
 */

// ─── Built-in Tour Definitions ──────────────────────────

export const TOURS = {
  welcome: {
    id: 'welcome',
    name: 'Welcome Tour',
    description: 'Fly through all zones of the Cognitive Core (60s)',
    duration: 60,
    stops: [
      { position: [0, 4, 8],    label: 'Nucleus',       narration: 'The nucleus — the beating heart of QUOX. System health pulses here.', dwell: 6 },
      { position: [10, 4, 0],   label: 'Implants',      narration: 'Cognitive implants — 12 modules that give QUOX its mind. Memory, focus, prediction.', dwell: 6 },
      { position: [0, 7, 30],   label: 'Agents',        narration: 'The agent mesh — 16 specialists working in parallel. Each octahedron is an AI agent.', dwell: 7 },
      { position: [20, 8, 42],  label: 'Teams',         narration: 'Agentic teams — clusters of agents working toward shared objectives.', dwell: 6 },
      { position: [40, 12, 88], label: 'Execution',     narration: 'The execution layer — objectives and tasks orbiting as they run.', dwell: 7 },
      { position: [0, 16, 115], label: 'Memory',        narration: 'Memory lattice — knowledge crystals drifting on orbital tracks. Recent memories glow brighter.', dwell: 7 },
      { position: [0, 20, 140], label: 'Shell',         narration: 'The outer shell — network boundaries. Beyond here is the external world.', dwell: 6 },
    ],
  },

  health: {
    id: 'health',
    name: 'Health Check',
    description: 'Visit each service and implant, check status (45s)',
    duration: 45,
    stops: [
      { position: [4, 3, 6],    label: 'Services',      narration: 'Service mesh — collector, auth, memory, tasks. Checking health endpoints.', dwell: 8 },
      { position: [10, 4, 0],   label: 'Implants',      narration: 'Implant health scan — any degraded modules will pulse amber.', dwell: 8 },
      { position: [0, 7, 30],   label: 'Agent States',   narration: 'Agent status sweep — looking for blocked or stale agents.', dwell: 8 },
      { position: [40, 12, 88], label: 'Objectives',    narration: 'Execution check — any stalled objectives or failed tasks?', dwell: 8 },
      { position: [0, 4, 8],    label: 'Summary',       narration: 'Health check complete. HORUS continues watching.', dwell: 5 },
    ],
  },

  infra: {
    id: 'infra',
    name: 'Infrastructure Tour',
    description: 'Descend to the infra tower — Docker, hosts, fleet (45s)',
    duration: 45,
    stops: [
      { position: [0, 5, 60],    label: 'Equator',      narration: 'Starting from the equatorial plane — descending to infrastructure.', dwell: 5 },
      { position: [12, -8, 18],  label: 'Docker',        narration: 'Docker container layer — real containers from your local Docker daemon.', dwell: 8 },
      { position: [10, -14, 16], label: 'Hosts',         narration: 'Physical host layer — bastion, proxmox nodes, docker hosts.', dwell: 8 },
      { position: [8, -20, 14],  label: 'Monitors',      narration: 'Uptime monitoring layer — health checks for all services.', dwell: 7 },
      { position: [6, -26, 12],  label: 'Fleet',         narration: 'QuoxAgent fleet — claude1 through claude7, your autonomous workforce.', dwell: 8 },
      { position: [0, 5, 60],    label: 'Ascend',        narration: 'Returning to the equatorial plane. Infrastructure tour complete.', dwell: 5 },
    ],
  },

  investor: {
    id: 'investor',
    name: 'Investor Demo',
    description: 'Quick flythrough for demos and presentations (30s)',
    duration: 30,
    stops: [
      { position: [0, 30, 50],   label: 'Overview',     narration: 'Cognitive Core 3D — the spatial operating system for AI infrastructure.', dwell: 5 },
      { position: [0, 4, 8],     label: 'Brain',        narration: '12 cognitive implants. 16 AI agents. 4 governance protocols. One unified brain.', dwell: 5 },
      { position: [0, 7, 30],    label: 'Agents',       narration: 'Every octahedron is an autonomous agent. They coordinate, delegate, and execute.', dwell: 5 },
      { position: [40, 12, 88],  label: 'Execution',    narration: 'Objectives decompose into tasks. Tasks orbit. Results crystallise into memory.', dwell: 5 },
      { position: [0, 30, 50],   label: 'The Product',  narration: 'This is QuoxCORE. The AI that manages your AI. And you can see it thinking.', dwell: 6 },
    ],
  },
}

// ─── Tour Runner ────────────────────────────────────────

/**
 * Run a tour by driving camera through stops.
 * @param {string} tourId — key in TOURS
 * @param {Object} callbacks
 * @param {Function} callbacks.onStop — (stop, index) called at each stop
 * @param {Function} callbacks.onNavigate — (position) called to move camera
 * @param {Function} callbacks.onComplete — () called when tour finishes
 * @returns {Function} cancel — call to abort the tour
 */
export function runTour(tourId, { onStop, onNavigate, onComplete }) {
  const tour = TOURS[tourId]
  if (!tour) { onComplete?.(); return () => {} }

  let cancelled = false
  let currentTimeout = null

  function playStop(index) {
    if (cancelled || index >= tour.stops.length) {
      if (!cancelled) onComplete?.()
      return
    }

    const stop = tour.stops[index]
    onNavigate?.(stop.position)
    onStop?.(stop, index)

    currentTimeout = setTimeout(() => {
      playStop(index + 1)
    }, stop.dwell * 1000)
  }

  playStop(0)

  return () => {
    cancelled = true
    if (currentTimeout) clearTimeout(currentTimeout)
  }
}

// ─── Tour Template Storage ──────────────────────────────

const STORAGE_KEY = 'cc3d_tour_templates'

/**
 * Save a tour as a named template in localStorage.
 * @param {Object} tour — { id, name, stops: [{ position, label, narration, dwell }] }
 */
export function saveTourTemplate(tour) {
  try {
    const templates = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    templates[tour.id] = { ...tour, savedAt: Date.now() }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates))
    return true
  } catch { return false }
}

/**
 * Load all saved tour templates.
 * @returns {Object} — { id: tour }
 */
export function loadTourTemplates() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch { return {} }
}

/**
 * Create an objective from a tour (for scheduling).
 * Returns objective payload ready for POST /tasks/api/objectives.
 */
export function tourToObjective(tourId, scheduleCron = null) {
  const tour = TOURS[tourId] || loadTourTemplates()[tourId]
  if (!tour) return null

  return {
    title: `CC3D Tour: ${tour.name}`,
    description: `Automated ${tour.name} — ${tour.stops.length} stops, ~${tour.duration || 60}s`,
    type: 'automated',
    source: 'cc3d-tour',
    metadata: {
      tourId: tour.id,
      stopCount: tour.stops.length,
      scheduleCron,
    },
    tasks: tour.stops.map((stop, i) => ({
      title: `Stop ${i + 1}: ${stop.label}`,
      description: stop.narration,
      type: 'cc3d-tour-stop',
    })),
  }
}
