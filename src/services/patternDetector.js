/**
 * Request Pattern Detector
 * Detects repeated requests and suggests automation opportunities
 */

import { queueSync } from './serverSyncQueue'

const STORAGE_KEY = 'quox-request-patterns'
const SIMILARITY_THRESHOLD = 0.7
const MIN_OCCURRENCES = 3
const LOOKBACK_DAYS = 7

// Get stored patterns
function getPatterns() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"requests": [], "suggestions": []}')
  } catch {
    return { requests: [], suggestions: [] }
  }
}

// Save patterns
function savePatterns(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  queueSync('requestPatterns', data)
}

// Normalize a request for comparison
function normalizeRequest(text) {
  return text
    .toLowerCase()
    .replace(/\b(on|for|in|at|the|a|an)\b/g, '')
    .replace(/\b\d+\b/g, '{NUM}')  // Replace numbers with placeholder
    .replace(/\b(docker\d+|pve\d+|nas\d+|proxmox\d+)\b/gi, '{HOST}')
    .replace(/\s+/g, ' ')
    .trim()
}

// Calculate similarity between two strings (Jaccard similarity)
function calculateSimilarity(str1, str2) {
  const words1 = new Set(str1.split(' '))
  const words2 = new Set(str2.split(' '))
  const intersection = [...words1].filter(w => words2.has(w)).length
  const union = new Set([...words1, ...words2]).size
  return union > 0 ? intersection / union : 0
}

// Extract the operation type from a request
function extractOperationType(text) {
  const lower = text.toLowerCase()

  if (lower.includes('disk') || lower.includes('storage') || lower.includes('space')) return 'disk_check'
  if (lower.includes('cpu') || lower.includes('load') || lower.includes('memory')) return 'resource_check'
  if (lower.includes('docker') && (lower.includes('list') || lower.includes('status'))) return 'docker_status'
  if (lower.includes('container') || lower.includes('restart')) return 'container_ops'
  if (lower.includes('vm') || lower.includes('proxmox') || lower.includes('cluster')) return 'vm_ops'
  if (lower.includes('log') || lower.includes('error')) return 'log_check'
  if (lower.includes('backup')) return 'backup_check'
  if (lower.includes('alert') || lower.includes('prometheus')) return 'alert_check'
  if (lower.includes('uptime') || lower.includes('status') || lower.includes('health')) return 'health_check'

  return 'general'
}

// Track a new request
export function trackRequest(request, cost = 0, duration = 0) {
  const data = getPatterns()
  const normalized = normalizeRequest(request)
  const opType = extractOperationType(request)

  // Add to history
  data.requests.push({
    original: request,
    normalized,
    opType,
    cost,
    duration,
    timestamp: Date.now()
  })

  // Keep only last 7 days
  const cutoff = Date.now() - (LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  data.requests = data.requests.filter(r => r.timestamp > cutoff)

  // Analyze patterns
  analyzePatterns(data)

  savePatterns(data)

  return data.suggestions
}

// Analyze patterns and generate suggestions
function analyzePatterns(data) {
  const patterns = {}

  // Group by operation type first
  data.requests.forEach(req => {
    if (!patterns[req.opType]) {
      patterns[req.opType] = []
    }
    patterns[req.opType].push(req)
  })

  // Find repeated patterns within each type
  const suggestions = []

  Object.entries(patterns).forEach(([opType, requests]) => {
    if (requests.length < MIN_OCCURRENCES) return

    // Group similar requests
    const groups = []
    requests.forEach(req => {
      let matched = false
      for (const group of groups) {
        if (calculateSimilarity(req.normalized, group[0].normalized) >= SIMILARITY_THRESHOLD) {
          group.push(req)
          matched = true
          break
        }
      }
      if (!matched) {
        groups.push([req])
      }
    })

    // Generate suggestions for groups with enough occurrences
    groups.forEach(group => {
      if (group.length >= MIN_OCCURRENCES) {
        const totalCost = group.reduce((sum, r) => sum + (r.cost || 0), 0)
        const avgDuration = group.reduce((sum, r) => sum + (r.duration || 0), 0) / group.length

        suggestions.push({
          id: `${opType}-${Date.now()}`,
          opType,
          pattern: group[0].original,
          normalized: group[0].normalized,
          occurrences: group.length,
          totalCost,
          avgDuration,
          potentialSavings: totalCost * 0.9, // 90% savings with automation
          suggestion: generateSuggestion(opType, group[0].original),
          lastSeen: Math.max(...group.map(r => r.timestamp)),
          dismissed: false
        })
      }
    })
  })

  // Keep only top 5 suggestions, sorted by potential savings
  data.suggestions = suggestions
    .filter(s => !s.dismissed)
    .sort((a, b) => b.potentialSavings - a.potentialSavings)
    .slice(0, 5)
}

// Generate automation suggestion
function generateSuggestion(opType, originalRequest) {
  const suggestions = {
    disk_check: {
      title: 'Create Disk Space Monitor',
      description: 'Set up a workflow to check disk space automatically and alert when low',
      workflow: 'Schedule: Every 6 hours\nAction: SSH to hosts, check df -h\nAlert: If usage > 80%',
      script: `#!/bin/bash
# Disk space check script
for host in docker01 docker02 docker03; do
  ssh $host "df -h / | tail -1 | awk '{print \\$5}'"
done`
    },
    resource_check: {
      title: 'Create Resource Monitor',
      description: 'Use Prometheus queries instead of SSH for faster, cheaper monitoring',
      workflow: 'Direct PromQL: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes',
      script: `curl -s "http://prometheus:9090/api/v1/query?query=node_load1" | jq '.data.result'`
    },
    docker_status: {
      title: 'Create Docker Status Dashboard',
      description: 'Add a dedicated panel for Docker container status',
      workflow: 'Schedule: Every 5 minutes\nAction: docker ps --format json\nStore results',
      script: `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`
    },
    container_ops: {
      title: 'Create Container Control Workflow',
      description: 'Build a workflow for common container operations',
      workflow: 'Use docker tools to start, stop, restart containers, or view logs',
      script: null
    },
    vm_ops: {
      title: 'Use Direct Proxmox API',
      description: 'VM operations are faster through the Proxmox panel in INFRA view',
      workflow: 'Already available in INFRA view - no AI needed!',
      script: null
    },
    health_check: {
      title: 'Use StatusBar',
      description: 'System health is shown in the StatusBar - click to expand',
      workflow: 'StatusBar shows Proxmox, Prometheus, and Uptime Kuma status live',
      script: null
    },
    log_check: {
      title: 'Create Log Aggregator',
      description: 'Set up centralized logging with Loki or ship to Grafana',
      workflow: 'Use promtail to ship logs to Loki, query in Grafana',
      script: `journalctl -u nginx --since "1 hour ago" | grep -i error`
    },
    backup_check: {
      title: 'Create Backup Monitor',
      description: 'Schedule automated backup verification',
      workflow: 'Check PBS/Proxmox backup status daily, alert on failures',
      script: `pvesh get /nodes/hyp-01/storage/pbs/content --output-format json`
    },
    alert_check: {
      title: 'Use Alert Badge',
      description: 'Alerts are shown in real-time in the header AlertBadge',
      workflow: 'Already implemented! Check the red badge in the header',
      script: null
    },
    general: {
      title: 'Consider Custom Workflow',
      description: 'This request pattern could be automated with a workflow',
      workflow: 'Create a webhook endpoint that performs this operation directly',
      script: null
    }
  }

  return suggestions[opType] || suggestions.general
}

// Get current suggestions
export function getSuggestions() {
  const data = getPatterns()
  return data.suggestions.filter(s => !s.dismissed)
}

// Dismiss a suggestion
export function dismissSuggestion(suggestionId) {
  const data = getPatterns()
  const suggestion = data.suggestions.find(s => s.id === suggestionId)
  if (suggestion) {
    suggestion.dismissed = true
    savePatterns(data)
  }
}

// Get request history stats
export function getRequestStats() {
  const data = getPatterns()
  const requests = data.requests

  if (requests.length === 0) {
    return { total: 0, uniquePatterns: 0, totalCost: 0, topOperations: [] }
  }

  // Count by operation type
  const opCounts = {}
  requests.forEach(r => {
    opCounts[r.opType] = (opCounts[r.opType] || 0) + 1
  })

  const topOperations = Object.entries(opCounts)
    .map(([op, count]) => ({ operation: op, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  return {
    total: requests.length,
    uniquePatterns: new Set(requests.map(r => r.normalized)).size,
    totalCost: requests.reduce((sum, r) => sum + (r.cost || 0), 0),
    topOperations,
    period: `Last ${LOOKBACK_DAYS} days`
  }
}

// Clear all data
export function clearPatterns() {
  localStorage.removeItem(STORAGE_KEY)
}

export default {
  trackRequest,
  getSuggestions,
  dismissSuggestion,
  getRequestStats,
  clearPatterns
}
