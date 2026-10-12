/**
 * templateVariables — Auto-detect variables in objective task prompts and results.
 *
 * WC-4: Variable parameterisation for objective templates.
 * Scans for values that likely change between runs (IPs, hostnames, paths, URLs, ports).
 */

// Detection patterns — order matters (more specific first)
const PATTERNS = [
  { type: 'ip', regex: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g, label: 'IP Address', preChecked: true },
  { type: 'hostname', regex: /\b((?:docker|pve|kuma|access|gitea|wazuh|quox)\d*[-\w]*)\b/gi, label: 'Hostname', preChecked: true },
  { type: 'url', regex: /https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?/gi, label: 'URL', preChecked: true },
  { type: 'path', regex: /(?:\/(?:home|opt|var|etc|tmp)\/[\w./-]+)/g, label: 'File Path', preChecked: false },
  { type: 'port', regex: /(?:port\s+)(\d{2,5})\b/gi, label: 'Port', preChecked: true },
]

/**
 * Generate a suggested variable name from a detected value.
 * E.g. "192.0.2.59" -> "target_ip", "docker01" -> "target_hostname"
 */
function suggestName(value, type, existingNames) {
  const basenames = {
    ip: 'target_ip',
    hostname: 'target_host',
    url: 'target_url',
    path: 'file_path',
    port: 'target_port',
  }

  let base = basenames[type] || 'variable'

  // Make unique if collision
  if (!existingNames.has(base)) {
    existingNames.add(base)
    return base
  }

  let counter = 2
  while (existingNames.has(`${base}_${counter}`)) counter++
  const name = `${base}_${counter}`
  existingNames.add(name)
  return name
}

/**
 * Auto-detect variables in objective task prompts.
 *
 * @param {Array} tasks — array of { title, prompt, result }
 * @returns {Array} — array of { value, type, label, suggestedName, preChecked, occurrences }
 */
export function detectVariables(tasks) {
  if (!tasks || tasks.length === 0) return []

  const found = new Map() // value -> { type, label, preChecked, occurrences }

  // Combine all text fields for scanning
  for (const task of tasks) {
    const texts = [task.title, task.prompt, task.result].filter(Boolean)

    for (const text of texts) {
      for (const pattern of PATTERNS) {
        // Reset regex state
        pattern.regex.lastIndex = 0
        let match
        while ((match = pattern.regex.exec(text)) !== null) {
          // For port pattern, capture group 1 is the port number
          const value = match[1] || match[0]

          // Skip trivial values
          if (pattern.type === 'port' && (parseInt(value) < 20 || parseInt(value) > 65535)) continue
          if (pattern.type === 'ip' && value === '0.0.0.0') continue

          const existing = found.get(value)
          if (existing) {
            existing.occurrences++
          } else {
            found.set(value, {
              type: pattern.type,
              label: pattern.label,
              preChecked: pattern.preChecked,
              occurrences: 1,
            })
          }
        }
      }
    }
  }

  // Deduplicate and assign suggested names
  const usedNames = new Set()
  const results = []

  for (const [value, info] of found) {
    results.push({
      value,
      type: info.type,
      label: info.label,
      suggestedName: suggestName(value, info.type, usedNames),
      preChecked: info.preChecked,
      occurrences: info.occurrences,
    })
  }

  // Sort: IPs first, then hostnames, then URLs, then ports, then paths
  const typeOrder = { ip: 0, hostname: 1, url: 2, port: 3, path: 4 }
  results.sort((a, b) => (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99))

  return results
}

/**
 * Replace detected values with {{variable_name}} placeholders in template JSON.
 *
 * @param {Object} templateJson — parsed template object with title, description, tasks[]
 * @param {Array} variables — array of { value, suggestedName } (only checked ones)
 * @returns {Object} — modified template JSON with placeholders + variables array
 */
export function parameteriseTemplate(templateJson, variables) {
  if (!variables || variables.length === 0) return templateJson

  let json = JSON.stringify(templateJson)

  // Build the variables metadata array
  const variablesDef = []

  for (const v of variables) {
    // Escape special regex chars in the value
    const escaped = v.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, 'g')
    json = json.replace(re, `{{${v.suggestedName}}}`)

    variablesDef.push({
      name: v.suggestedName,
      type: v.type,
      defaultValue: v.value,
      label: v.label || v.suggestedName,
    })
  }

  const result = JSON.parse(json)
  result.variables = variablesDef
  return result
}

/**
 * Replace {{variable_name}} placeholders with actual values.
 *
 * @param {Object} templateJson — parsed template with {{...}} placeholders
 * @param {Object} variableValues — { variable_name: "actual_value", ... }
 * @returns {Object} — template JSON ready for objective creation
 */
export function instantiateWithVariables(templateJson, variableValues) {
  if (!variableValues || Object.keys(variableValues).length === 0) return templateJson

  let json = JSON.stringify(templateJson)

  for (const [name, value] of Object.entries(variableValues)) {
    const placeholder = `{{${name}}}`
    // Replace all occurrences
    while (json.includes(placeholder)) {
      json = json.replace(placeholder, value)
    }
  }

  const result = JSON.parse(json)
  // Remove the variables definition from the instantiated version
  delete result.variables
  return result
}

/**
 * Extract variable definitions from template_json (for UI rendering).
 *
 * @param {string|Object} templateJson — raw or parsed template JSON
 * @returns {Array} — array of { name, type, defaultValue, label }
 */
export function extractVariables(templateJson) {
  try {
    const parsed = typeof templateJson === 'string' ? JSON.parse(templateJson) : templateJson
    return parsed.variables || []
  } catch {
    return []
  }
}

/**
 * Detect if a template has any {{...}} placeholders (quick check).
 *
 * @param {string|Object} templateJson
 * @returns {boolean}
 */
export function hasVariables(templateJson) {
  const str = typeof templateJson === 'string' ? templateJson : JSON.stringify(templateJson)
  return /\{\{[\w]+\}\}/.test(str)
}
