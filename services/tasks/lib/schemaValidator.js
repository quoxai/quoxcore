/**
 * Schema Validator — Lightweight JSON Schema subset validator
 *
 * Stream OE Phase OE-4: QuoxEngine structured output validation
 *
 * Supports: type, required, properties, items (array).
 * No external dependencies — handles the common cases needed for
 * agent output validation without pulling in ajv or similar.
 */

/**
 * Validate data against a JSON Schema subset.
 *
 * @param {*} data — the value to validate
 * @param {Object} schema — JSON Schema object (type, required, properties, items)
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSchema(data, schema) {
  const errors = []
  validate(data, schema, '', errors)
  return { valid: errors.length === 0, errors }
}

function validate(data, schema, path, errors) {
  if (!schema) return

  // Type check
  if (schema.type) {
    const actualType = getType(data)
    if (schema.type !== actualType) {
      errors.push(`${path || 'root'}: expected type '${schema.type}', got '${actualType}'`)
      return // no point checking further if type is wrong
    }
  }

  // Object: required + properties
  if (schema.type === 'object' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    // Required fields
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push(`${path || 'root'}: missing required field '${field}'`)
        }
      }
    }

    // Property validation
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          validate(data[key], propSchema, path ? `${path}.${key}` : key, errors)
        }
      }
    }
  }

  // Array: items
  if (schema.type === 'array' && Array.isArray(data) && schema.items) {
    for (let i = 0; i < data.length; i++) {
      validate(data[i], schema.items, `${path || 'root'}[${i}]`, errors)
    }
  }
}

/**
 * Get the JSON Schema type name for a value.
 */
function getType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value // 'string', 'number', 'boolean', 'object', 'undefined'
}
