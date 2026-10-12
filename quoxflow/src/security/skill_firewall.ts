/**
 * Quox Skill Firewall — skill_firewall.ts
 *
 * Static-analysis scanner for skill content. Runs on every skill at publish
 * time, subscribe time, and (optionally) load time.
 *
 * Default-on: the firewall is always active unless QSKL_FIREWALL_DISABLED=true
 * is set in the environment. There is NO enable flag — the firewall cannot be
 * "turned on", only "turned off" for exceptional cases.
 *
 * Public API:
 *   createSkillFirewall(deps?) → SkillFirewall
 *
 * The returned firewall exposes a single method:
 *   scan(skill) → Promise<SkillFirewallReport>
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jsYaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Public interfaces (exported as part of the module's public surface)
// ---------------------------------------------------------------------------

export interface SkillFirewallFinding {
  rule_id: string;
  severity: 'low' | 'medium' | 'high' | 'block';
  /** 1-indexed line number in the scanned text where the match was found */
  line: number;
  /** Matched substring, truncated to ≤80 characters */
  snippet: string;
  surface: 'body_md' | 'references' | 'scripts' | 'metadata';
  /** Set when surface is references or scripts — the key (filename) in the map */
  reference_key?: string;
  category?: string;
  remediation?: string;
}

export interface SkillFirewallReport {
  allow: boolean;
  findings: SkillFirewallFinding[];
  /** 'disabled' | 'blocked' | 'clean' */
  reason?: string;
  /** ISO timestamp */
  scanned_at: string;
  rule_set_version: number;
}

export interface SkillInput {
  body_md?: string;
  references?: Record<string, string>;
  scripts?: Record<string, string>;
  metadata?: Record<string, unknown>;
  author_id?: string;
  tags?: string[];
}

export interface SkillFirewall {
  scan(skill: SkillInput): Promise<SkillFirewallReport>;
}

// ---------------------------------------------------------------------------
// Internal rule types loaded from YAML
// ---------------------------------------------------------------------------

type PatternType = 'regex' | 'regex_i';
type Severity = 'low' | 'medium' | 'high' | 'block';
type Surface = 'body_md' | 'references' | 'scripts' | 'metadata';

interface FirewallRule {
  id: string;
  name: string;
  category: string;
  severity: Severity;
  surfaces: Surface[];
  pattern?: string;
  pattern_type?: PatternType;
  remediation?: string;
  exempt_authors?: string[];
  exempt_tags?: string[];
  // Compiled regex — populated at load time
  _regex?: RegExp;
}

interface RuleSet {
  version: number;
  rules: FirewallRule[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES_PATH = join(__dirname, 'skill_firewall_rules.yaml');

/**
 * Load and compile a rule set from a YAML string or file path.
 * The `rules` parameter accepts raw YAML text (used in tests for inline
 * override rulesets). If omitted, the bundled rules YAML is loaded from disk.
 */
function loadRuleSet(yamlText?: string): RuleSet {
  const text = yamlText ?? readFileSync(DEFAULT_RULES_PATH, 'utf8');
  const raw = jsYaml.load(text) as { version?: number; rules?: unknown[] };

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rules)) {
    throw new Error('skill_firewall_rules.yaml: missing or invalid rules array');
  }

  const rules: FirewallRule[] = (raw.rules as FirewallRule[]).map((r) => {
    const rule: FirewallRule = {
      id: r.id,
      name: r.name,
      category: r.category,
      severity: r.severity,
      surfaces: r.surfaces ?? [],
      pattern: r.pattern,
      pattern_type: r.pattern_type,
      remediation: r.remediation,
      exempt_authors: r.exempt_authors ?? [],
      exempt_tags: r.exempt_tags ?? [],
    };

    if (rule.pattern && rule.pattern_type) {
      const flags = rule.pattern_type === 'regex_i' ? 'gi' : 'g';
      rule._regex = new RegExp(rule.pattern, flags);
    }

    return rule;
  });

  return { version: typeof raw.version === 'number' ? raw.version : 1, rules };
}

/**
 * Truncate a string to ≤80 characters, appending "…" if truncated.
 */
function truncate80(s: string): string {
  if (s.length <= 80) return s;
  return s.slice(0, 79) + '…';
}

/**
 * Scan a single text string against a compiled regex.
 * Returns an array of { line, snippet } for each match found.
 * Line numbers are 1-indexed within the provided text.
 */
function scanText(
  text: string,
  regex: RegExp,
): Array<{ line: number; snippet: string }> {
  const results: Array<{ line: number; snippet: string }> = [];
  const lines = text.split('\n');

  // Reset regex state (it has 'g' flag)
  regex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const matchStart = match.index;
    // Compute 1-indexed line number by counting newlines up to match start
    const textBefore = text.slice(0, matchStart);
    const lineNumber = textBefore.split('\n').length;

    // Build snippet: the line that contains the match
    const lineText = lines[lineNumber - 1] ?? '';
    const snippet = truncate80(lineText.trim() || match[0]);

    results.push({ line: lineNumber, snippet });

    // Prevent infinite loop on zero-length matches
    if (match[0].length === 0) {
      regex.lastIndex++;
    }
  }

  // Reset again so the regex is reusable
  regex.lastIndex = 0;

  return results;
}

/**
 * Check whether a rule is exempted for the given skill author / tags.
 */
function isExempt(rule: FirewallRule, skill: SkillInput): boolean {
  if (skill.author_id && rule.exempt_authors && rule.exempt_authors.includes(skill.author_id)) {
    return true;
  }
  if (skill.tags && rule.exempt_tags && rule.exempt_tags.length > 0) {
    for (const tag of skill.tags) {
      if (rule.exempt_tags.includes(tag)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Apply a single rule to one surface string and return findings.
 */
function applyRule(
  rule: FirewallRule,
  surface: Surface,
  text: string,
  referenceKey?: string,
): SkillFirewallFinding[] {
  if (!rule._regex) return [];

  const hits = scanText(text, rule._regex);
  return hits.map(({ line, snippet }) => {
    const finding: SkillFirewallFinding = {
      rule_id: rule.id,
      severity: rule.severity,
      line,
      snippet,
      surface,
    };
    if (referenceKey !== undefined) {
      finding.reference_key = referenceKey;
    }
    if (rule.category) finding.category = rule.category;
    if (rule.remediation) finding.remediation = rule.remediation;
    return finding;
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSkillFirewall(deps?: {
  env?: NodeJS.ProcessEnv;
  /** Raw YAML text for the rule set (override for testing). */
  rules?: string;
}): SkillFirewall {
  const env = deps?.env ?? process.env;
  const ruleSet = loadRuleSet(deps?.rules);

  return {
    async scan(skill: SkillInput): Promise<SkillFirewallReport> {
      const scanned_at = new Date().toISOString();

      // Short-circuit when explicitly disabled
      if (env['QSKL_FIREWALL_DISABLED'] === 'true') {
        return {
          allow: true,
          findings: [],
          reason: 'disabled',
          scanned_at,
          rule_set_version: ruleSet.version,
        };
      }

      const findings: SkillFirewallFinding[] = [];

      for (const rule of ruleSet.rules) {
        // Skip rules with no compiled pattern
        if (!rule._regex) continue;

        // Skip exempted rules
        if (isExempt(rule, skill)) continue;

        // Scan each surface the rule applies to
        for (const surface of rule.surfaces) {
          switch (surface) {
            case 'body_md': {
              if (skill.body_md) {
                const hits = applyRule(rule, 'body_md', skill.body_md);
                findings.push(...hits);
              }
              break;
            }
            case 'references': {
              if (skill.references) {
                for (const [key, text] of Object.entries(skill.references)) {
                  const hits = applyRule(rule, 'references', text, key);
                  findings.push(...hits);
                }
              }
              break;
            }
            case 'scripts': {
              if (skill.scripts) {
                for (const [key, text] of Object.entries(skill.scripts)) {
                  const hits = applyRule(rule, 'scripts', text, key);
                  findings.push(...hits);
                }
              }
              break;
            }
            case 'metadata': {
              if (skill.metadata) {
                // Scan the JSON-serialised metadata for pattern matching
                const text = JSON.stringify(skill.metadata);
                const hits = applyRule(rule, 'metadata', text);
                findings.push(...hits);
              }
              break;
            }
          }
        }
      }

      const hasBlock = findings.some((f) => f.severity === 'block');
      const allow = !hasBlock;
      const reason = hasBlock ? 'blocked' : 'clean';

      return {
        allow,
        findings,
        reason,
        scanned_at,
        rule_set_version: ruleSet.version,
      };
    },
  };
}
