/**
 * RequiredToolSpec — QSKL-6
 *
 * Canonical type for entries in the required_tools JSONB column of quox_skills.
 * Defines which tools a skill depends on, with optional version constraints and
 * policy satisfaction requirements.
 */

export interface RequiredToolSpec {
  name: string;
  version_constraint?: string;
  must_satisfy_policy?: string[];
}

/**
 * Runtime sentinel exported so the module is never silently erased by
 * type-stripping transforms. Also serves as a schema version tag for
 * future migration checks.
 */
export const REQUIRED_TOOL_SPEC_SCHEMA_VERSION = '1.0.0';
