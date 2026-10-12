/**
 * Custom Services Configuration
 *
 * Allows users to add their own services to monitor on the dashboard.
 * Stored in localStorage for persistence.
 *
 * Usage:
 *   import { getCustomServices, addCustomService, removeCustomService } from './customServices'
 *
 *   // Add a service
 *   addCustomService({
 *     key: 'pinecone',
 *     name: 'Pinecone',
 *     description: 'Vector database',
 *     port: 8080,
 *     healthEndpoint: '/health'
 *   })
 */

import { orgGet, orgSet } from './orgScopedStorage'

/**
 * Default structure for a custom service
 */
const DEFAULT_SERVICE = {
  key: '',
  name: '',
  shortName: '',
  description: '',
  longDescription: '',
  port: 80,
  baseUrl: '',
  healthEndpoint: '/health',
  healthTimeout: 5000,
  category: 'custom',
  critical: false,
  thresholds: {
    responseTime: { warning: 500, critical: 2000 },
    uptimePercent: { warning: 95, critical: 90 }
  },
  docs: {},
  troubleshooting: [],
  links: []
}

/**
 * Get all custom services
 */
export function getCustomServices() {
  try {
    const stored = orgGet('custom-services')
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

/**
 * Save custom services to storage
 */
function saveCustomServices(services) {
  try {
    orgSet('custom-services', JSON.stringify(services))
    return true
  } catch (err) {
    console.error('Failed to save custom services:', err)
    return false
  }
}

/**
 * Add or update a custom service
 */
export function addCustomService(service) {
  if (!service.key || !service.name || !service.port) {
    throw new Error('Service must have key, name, and port')
  }

  // Prevent overwriting core services
  const coreServices = ['quoxagent', 'collector', 'auth', 'n8n', 'qdrant', 'orchestrator', 'nginx', 'bastion']
  if (coreServices.includes(service.key)) {
    throw new Error(`Cannot override core service: ${service.key}`)
  }

  const services = getCustomServices()

  // Merge with defaults
  services[service.key] = {
    ...DEFAULT_SERVICE,
    ...service,
    shortName: service.shortName || service.name,
    baseUrl: service.baseUrl || `http://localhost:${service.port}`,
    isCustom: true
  }

  return saveCustomServices(services)
}

/**
 * Remove a custom service
 */
export function removeCustomService(key) {
  const services = getCustomServices()
  if (services[key]) {
    delete services[key]
    return saveCustomServices(services)
  }
  return false
}

/**
 * Update a custom service
 */
export function updateCustomService(key, updates) {
  const services = getCustomServices()
  if (!services[key]) {
    throw new Error(`Service not found: ${key}`)
  }

  services[key] = {
    ...services[key],
    ...updates
  }

  return saveCustomServices(services)
}

/**
 * Get a single custom service
 */
export function getCustomService(key) {
  const services = getCustomServices()
  return services[key] || null
}

/**
 * Check if a service key is available (not used by core or custom)
 */
export function isKeyAvailable(key) {
  const coreServices = ['quoxagent', 'collector', 'auth', 'n8n', 'qdrant', 'orchestrator', 'nginx', 'bastion']
  if (coreServices.includes(key)) return false

  const customServices = getCustomServices()
  return !customServices[key]
}

/**
 * Generate a unique key from a name
 */
export function generateKey(name) {
  let baseKey = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  let key = baseKey
  let counter = 1

  while (!isKeyAvailable(key)) {
    key = `${baseKey}_${counter}`
    counter++
  }

  return key
}

/**
 * Validate a service configuration
 */
export function validateService(service) {
  const errors = []

  if (!service.name?.trim()) {
    errors.push('Name is required')
  }

  if (!service.port || service.port < 1 || service.port > 65535) {
    errors.push('Port must be between 1 and 65535')
  }

  if (service.healthEndpoint && !service.healthEndpoint.startsWith('/')) {
    errors.push('Health endpoint must start with /')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

export default {
  getCustomServices,
  addCustomService,
  removeCustomService,
  updateCustomService,
  getCustomService,
  isKeyAvailable,
  generateKey,
  validateService
}
