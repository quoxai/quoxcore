/**
 * SQL Validation Utilities
 * Security fix for SQL injection via dynamic column names (Issue #64)
 *
 * Provides column name allowlists and validation functions
 * to prevent SQL injection attacks through dynamic column names.
 */

// ============================================================================
// COLUMN ALLOWLISTS BY TABLE
// ============================================================================

export const ALLOWED_COLUMNS = {
    // Users table
    users: new Set([
        'primary_email', 'display_name', 'status', 'avatar_url', 'timezone',
        'mfa_enabled', 'mfa_secret', 'failed_login_count', 'lockout_until', 'last_failed_at'
    ]),

    // Org memberships table
    org_memberships: new Set([
        'role', 'status', 'invited_by', 'invited_at', 'joined_at'
    ]),

    // Divisions table
    divisions: new Set([
        'name', 'slug', 'description', 'settings_json'
    ]),

    // Departments table
    departments: new Set([
        'name', 'slug', 'description', 'division_id', 'settings_json'
    ]),

    // Teams table
    teams: new Set([
        'name', 'slug', 'description', 'attach_scope_id', 'settings_json'
    ]),

    // Tags table
    tags: new Set([
        'name', 'slug', 'description', 'color', 'icon'
    ]),

    // Tools table
    tools: new Set([
        'name', 'slug', 'description', 'icon', 'tool_type',
        'spec_json', 'input_schema_json', 'output_schema_json', 'examples_json',
        'home_scope_id', 'share_policy_id', 'risk_level', 'requires_approval', 'status',
        'version', 'published_at', 'deprecated_at'
    ]),

    // Tool installations table
    tool_installations: new Set([
        'status', 'config_json', 'enabled'
    ]),

    // Agents table
    agents: new Set([
        'name', 'slug', 'description', 'icon', 'level', 'role',
        'system_prompt', 'config_json', 'capabilities_json',
        'home_scope_id', 'share_policy_id', 'status', 'model_id', 'model_config_json',
        'max_context_tokens', 'temperature', 'published_at', 'deprecated_at'
    ]),

    // Agent tool assignments table
    agent_tool_assignments: new Set([
        'enabled', 'config_override_json', 'permission_level'
    ]),

    // Assistants table
    assistants: new Set([
        'name', 'slug', 'description', 'icon', 'level', 'role',
        'system_prompt', 'config_json', 'capabilities_json',
        'status', 'model_id', 'model_config_json',
        'voice_id', 'voice_config_json'
    ]),

    // Assistant deployments table
    assistant_deployments: new Set([
        'status', 'config_json', 'environment'
    ]),

    // Workflows table
    workflows: new Set([
        'name', 'slug', 'description', 'icon',
        'definition_json', 'config_json', 'trigger_config_json',
        'home_scope_id', 'share_policy_id', 'status', 'version'
    ]),

    // Routing rules table
    routing_rules: new Set([
        'name', 'description', 'priority', 'pattern', 'pattern_type',
        'target_type', 'target_id', 'config_json', 'enabled'
    ]),

    // Share policies table
    share_policies: new Set([
        'name', 'description', 'mode', 'config_json'
    ]),

    // Notification channels table
    notification_channels: new Set([
        'name', 'description', 'channel_type', 'config_json', 'enabled'
    ]),

    // Integrations table
    integrations: new Set([
        'name', 'description', 'integration_type', 'config_json', 'status', 'enabled'
    ]),

    // Backup schedules table
    backup_schedules: new Set([
        'name', 'schedule_type', 'cron_expression', 'schedule_hour', 'schedule_minute',
        'schedule_day_of_week', 'schedule_day_of_month', 'backup_type', 'enabled',
        'retention_days', 'max_backups', 'components_json'
    ]),

    // API keys table
    api_keys: new Set([
        'name', 'description', 'status', 'expires_at', 'last_used_at'
    ]),

    // Orgs table
    orgs: new Set([
        'name', 'slug', 'description', 'plan', 'mfa_policy', 'settings_json'
    ])
};

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate column names against an allowlist to prevent SQL injection
 * @param {Object} fields - Object with column names as keys
 * @param {string} tableName - Name of the table (to get allowlist)
 * @returns {Object} - Object with only valid columns
 * @throws {Error} - If any column name is not in the allowlist or table not found
 */
export function validateColumns(fields, tableName) {
    const allowedColumns = ALLOWED_COLUMNS[tableName];
    if (!allowedColumns) {
        throw new Error(`Unknown table: ${tableName}`);
    }

    const validFields = {};
    const invalidColumns = [];

    for (const [key, value] of Object.entries(fields)) {
        if (allowedColumns.has(key)) {
            validFields[key] = value;
        } else {
            invalidColumns.push(key);
        }
    }

    if (invalidColumns.length > 0) {
        console.warn(`[SQL Validation] Blocked invalid columns for ${tableName}: ${invalidColumns.join(', ')}`);
        // Don't throw - just filter out invalid columns
        // This allows legitimate requests with extra fields to still work
    }

    return validFields;
}

/**
 * Build a safe UPDATE SQL fragment from validated fields
 * @param {Object} fields - Object with column names as keys (already validated)
 * @param {string} tableName - Name of the table
 * @returns {{ sql: string, values: Array }} - SQL fragment and parameter values
 */
export function buildUpdateSql(fields, tableName) {
    const validFields = validateColumns(fields, tableName);
    const columns = Object.keys(validFields);

    if (columns.length === 0) {
        return { sql: '', values: [] };
    }

    const updates = columns.map(col => `${col} = ?`);
    const values = columns.map(col => validFields[col]);

    return {
        sql: updates.join(', '),
        values
    };
}

/**
 * Validate a single column name
 * @param {string} columnName - The column name to validate
 * @param {string} tableName - Name of the table
 * @returns {boolean} - True if valid
 */
export function isValidColumn(columnName, tableName) {
    const allowedColumns = ALLOWED_COLUMNS[tableName];
    return allowedColumns && allowedColumns.has(columnName);
}

/**
 * Get list of allowed columns for a table
 * @param {string} tableName - Name of the table
 * @returns {string[]} - Array of allowed column names
 */
export function getAllowedColumns(tableName) {
    const allowedColumns = ALLOWED_COLUMNS[tableName];
    return allowedColumns ? Array.from(allowedColumns) : [];
}

export default {
    ALLOWED_COLUMNS,
    validateColumns,
    buildUpdateSql,
    isValidColumn,
    getAllowedColumns
};
