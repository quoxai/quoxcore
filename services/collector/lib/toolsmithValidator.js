/**
 * TOOLSMITH Slice 3a — Tool Definition Validator
 *
 * Validates the five-file Quox Tool Definition artefact set:
 *   tool.json, script.py, tests.json, requirements.txt, README.md
 *
 * Returns: { valid: boolean, errors: [{file, line?, severity, code, message}], warnings: [...] }
 *
 * Does NOT require ajv — performs structural JSON Schema validation inline
 * to avoid adding a heavy dependency. Validates:
 *   - tool.json parses + has required Quox fields
 *   - inputs_schema + outputs_schema are valid JSON Schema objects (type must be valid)
 *   - script.py has callable quox_tool_main
 *   - requirements.txt lines are valid pip specifiers
 *   - tests.json parses + matches { tests: [{name, inputs, expected_outputs}] }
 */

'use strict';

// Valid JSON Schema primitive types (draft 2020-12)
const VALID_JSON_SCHEMA_TYPES = new Set([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);

// Valid pip specifier regex: package name optionally followed by version constraint
// Handles: requests, requests==2.31.0, urllib3>=1.26, numpy~=1.24, pkg!=1.0
const PIP_SPECIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]*(==|>=|<=|~=|!=|<|>)[a-zA-Z0-9_.\-+*]+$|^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/;
// Lines starting with # or empty are allowed
const PIP_COMMENT_RE = /^\s*#|^\s*$/;

/**
 * Check whether a value is a structurally valid JSON Schema object.
 * Validates that if "type" is present, it's a known type or array of known types.
 * Does not do deep validation — just catches obvious errors.
 *
 * @param {unknown} schema
 * @returns {{ valid: boolean, reason?: string }}
 */
function isValidJsonSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { valid: false, reason: 'must be a JSON object' };
  }

  // If "type" is present, validate it
  if ('type' in schema) {
    const t = schema.type;
    if (Array.isArray(t)) {
      for (const item of t) {
        if (!VALID_JSON_SCHEMA_TYPES.has(item)) {
          return { valid: false, reason: `invalid type value "${item}" in type array` };
        }
      }
    } else if (typeof t === 'string') {
      if (!VALID_JSON_SCHEMA_TYPES.has(t)) {
        return { valid: false, reason: `invalid type value "${t}"` };
      }
    }
  }

  return { valid: true };
}

/**
 * Build an error entry.
 */
function mkError(file, code, message, line) {
  const entry = { file, severity: 'error', code, message };
  if (line != null) entry.line = line;
  return entry;
}

/**
 * Build a warning entry.
 */
function mkWarn(file, code, message, line) {
  const entry = { file, severity: 'warning', code, message };
  if (line != null) entry.line = line;
  return entry;
}

/**
 * Validate the five-file Quox Tool Definition artefact set.
 *
 * @param {{ [filename: string]: string }} files
 * @returns {{ valid: boolean, errors: object[], warnings: object[] }}
 */
function validate(files) {
  const errors = [];
  const warnings = [];

  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    errors.push(mkError('files', 'MISSING_FILES', 'files must be a key-value object'));
    return { valid: false, errors, warnings };
  }

  // ── tool.json ────────────────────────────────────────────────────────────

  if (!files['tool.json']) {
    errors.push(mkError('tool.json', 'MISSING_FILE', 'tool.json is required'));
  } else {
    let toolDef;
    try {
      toolDef = JSON.parse(files['tool.json']);
    } catch (e) {
      errors.push(mkError('tool.json', 'PARSE_ERROR', `tool.json is not valid JSON: ${e.message}`));
    }

    if (toolDef !== undefined) {
      // Required top-level fields
      for (const field of ['name', 'description', 'inputs_schema', 'outputs_schema']) {
        if (!(field in toolDef)) {
          errors.push(mkError('tool.json', 'MISSING_REQUIRED_FIELD', `tool.json missing required field: ${field}`));
        }
      }

      // inputs_schema must be a valid JSON Schema
      if ('inputs_schema' in toolDef) {
        const check = isValidJsonSchema(toolDef.inputs_schema);
        if (!check.valid) {
          errors.push(mkError('tool.json', 'INVALID_INPUTS_SCHEMA', `tool.json inputs_schema is not a valid JSON Schema: ${check.reason}`));
        }
      }

      // outputs_schema must be a valid JSON Schema
      if ('outputs_schema' in toolDef) {
        const check = isValidJsonSchema(toolDef.outputs_schema);
        if (!check.valid) {
          errors.push(mkError('tool.json', 'INVALID_OUTPUTS_SCHEMA', `tool.json outputs_schema is not a valid JSON Schema: ${check.reason}`));
        }
      }

      // version is recommended but not required
      if (!toolDef.version) {
        warnings.push(mkWarn('tool.json', 'MISSING_VERSION', 'tool.json should include a version field (e.g. "1.0.0")'));
      }
    }
  }

  // ── script.py ────────────────────────────────────────────────────────────

  if (!files['script.py']) {
    errors.push(mkError('script.py', 'MISSING_FILE', 'script.py is required'));
  } else {
    const scriptLines = files['script.py'].split('\n');
    // Detect def quox_tool_main( or async def quox_tool_main(
    const hasMain = scriptLines.some(line =>
      /^\s*(async\s+)?def\s+quox_tool_main\s*\(/.test(line)
    );
    if (!hasMain) {
      errors.push(mkError('script.py', 'MISSING_ENTRYPOINT',
        'script.py must define a callable named quox_tool_main (e.g. def quox_tool_main(inputs: dict) -> dict:)'));
    }

    // TOOLSMITH E-fix-4 (Error 3): Scan for bare JSON literals (false/true/null)
    // in Python source. These cause NameError at runtime. Strip comments and
    // string literals first (same strategy as toolsmithAnalyser.js) so we
    // don't flag occurrences inside strings or comments.
    let stripped = files['script.py'];
    stripped = stripped.replace(/"""[\s\S]*?"""/g, '""');
    stripped = stripped.replace(/'''[\s\S]*?'''/g, "''");
    stripped = stripped.replace(/"[^"\n\\]*(?:\\.[^"\n\\]*)*"/g, '""');
    stripped = stripped.replace(/'[^'\n\\]*(?:\\.[^'\n\\]*)*'/g, "''");
    stripped = stripped.replace(/#[^\n]*/g, '');

    // Match bare false/true/null (word boundary — excludes False/True/None)
    // \b ensures we don't match substrings (e.g. "falsehood" would NOT match)
    if (/\bfalse\b|\btrue\b|\bnull\b/.test(stripped)) {
      warnings.push(mkWarn('script.py', 'JSON_LITERAL_IN_PYTHON',
        'script.py contains JSON-style literal(s) (false/true/null). ' +
        'Python requires False/True/None (capitalised). These will cause a NameError at runtime. ' +
        'Use json.loads(\'{"key": false}\') to parse JSON, or replace bare literals with Python equivalents.'));
    }
  }

  // ── tests.json ───────────────────────────────────────────────────────────

  if (!files['tests.json']) {
    errors.push(mkError('tests.json', 'MISSING_FILE', 'tests.json is required'));
  } else {
    let testsData;
    try {
      testsData = JSON.parse(files['tests.json']);
    } catch (e) {
      errors.push(mkError('tests.json', 'PARSE_ERROR', `tests.json is not valid JSON: ${e.message}`));
    }

    if (testsData !== undefined) {
      if (!Array.isArray(testsData.tests)) {
        errors.push(mkError('tests.json', 'MISSING_TESTS_ARRAY',
          'tests.json must have a "tests" array: { tests: [{name, inputs, expected_outputs}] }'));
      } else {
        testsData.tests.forEach((test, idx) => {
          if (typeof test !== 'object' || test === null) {
            errors.push(mkError('tests.json', 'INVALID_TEST_ITEM',
              `tests[${idx}] must be an object`));
            return;
          }
          if (!test.name) {
            errors.push(mkError('tests.json', 'TEST_MISSING_NAME',
              `tests[${idx}] is missing required field "name"`));
          }
          if (!('inputs' in test)) {
            errors.push(mkError('tests.json', 'TEST_MISSING_INPUTS',
              `tests[${idx}] (${test.name || 'unnamed'}) is missing required field "inputs"`));
          }
          // expected_outputs is recommended but not strictly required (test may just check no-throw)
          if (!('expected_outputs' in test)) {
            warnings.push(mkWarn('tests.json', 'TEST_MISSING_EXPECTED_OUTPUTS',
              `tests[${idx}] (${test.name || 'unnamed'}) is missing "expected_outputs" — outputs will not be validated`));
          }
        });
      }
    }
  }

  // ── requirements.txt (optional) ──────────────────────────────────────────

  if (files['requirements.txt'] !== undefined && files['requirements.txt'] !== null) {
    const lines = files['requirements.txt'].split('\n');
    lines.forEach((rawLine, idx) => {
      const line = rawLine.trim();
      if (PIP_COMMENT_RE.test(line)) return; // skip blanks and comments
      if (!PIP_SPECIFIER_RE.test(line)) {
        errors.push(mkError('requirements.txt', 'INVALID_PIP_SPECIFIER',
          `requirements.txt line ${idx + 1} is not a valid pip specifier: "${rawLine.trim()}"`, idx + 1));
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = { validate };
