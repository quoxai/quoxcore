/**
 * Output formatter for QuoxCLI
 *
 * All commands pass results through this module.
 * Supports: table, json, csv, quiet output modes.
 */

import chalk from 'chalk';
import Table from 'cli-table3';

/**
 * Format and print tabular data
 *
 * @param {Object} result - { columns, headers, rows } or array of objects
 * @param {Object} options - { format, title, emptyMessage }
 */
export function formatOutput(result, options = {}) {
  const format = options.format || getOutputFormat();
  const rows = result.rows || result;
  const columns = result.columns || (rows.length > 0 ? Object.keys(rows[0]) : []);
  const headers = result.headers || columns;

  // options.raw: the untransformed API records behind the display rows.
  // --json exists for scripting, and scripts want DATA keys (name, state,
  // holder_session), not the humanised table cells (NAME, HOLDER, "2d") the
  // display rows carry -- `quox --json slot list` emitting NAME/STATE bit a
  // live harness on 2026-08-20. Table/csv/quiet still render the display
  // rows; json prefers raw when the caller provides it.
  if (!Array.isArray(rows) || rows.length === 0) {
    if (format === 'json') {
      console.log(JSON.stringify(Array.isArray(options.raw) ? options.raw : []));
    } else if (format === 'csv') {
      console.log(headers.join(','));
    } else if (format !== 'quiet') {
      console.log(chalk.dim(options.emptyMessage || 'No results.'));
    }
    return;
  }

  switch (format) {
    case 'json':
      console.log(JSON.stringify(Array.isArray(options.raw) ? options.raw : rows, null, 2));
      break;
    case 'csv':
      formatCsv(rows, columns, headers);
      break;
    case 'quiet':
      formatQuiet(rows, columns);
      break;
    default:
      formatTable(rows, columns, headers, options);
  }
}

/**
 * Format and print a single object (detail view)
 */
export function formatDetail(obj, options = {}) {
  const format = options.format || getOutputFormat();

  if (format === 'json') {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }

  if (format === 'quiet') {
    console.log(obj.id || obj.name || '');
    return;
  }

  // Key-value display
  const fields = options.fields || Object.keys(obj);
  const labels = options.labels || {};

  if (options.title) {
    console.log(chalk.bold(options.title));
    console.log(chalk.dim('─'.repeat(Math.min(options.title.length + 10, 60))));
  }

  const maxLabel = Math.max(...fields.map(f => (labels[f] || f).length));

  for (const field of fields) {
    const label = (labels[field] || field).padEnd(maxLabel + 2);
    const raw = obj[field];
    if (raw !== null && typeof raw === 'object') {
      console.log(`  ${chalk.dim(label)}${formatNestedValue(raw)}`);
    } else {
      const value = formatValue(raw);
      console.log(`  ${chalk.dim(label)} ${value}`);
    }
  }
}

/**
 * Recursively render a nested object/array value for formatDetail, instead
 * of falling through to formatValue's String(value) -> "[object Object]".
 * Kept local to formatDetail (not folded into formatValue) so formatTable /
 * formatCsv output is unchanged.
 */
function formatNestedValue(value, indent = 4) {
  if (value == null) return ` ${chalk.dim('-')}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return ` ${chalk.dim('[]')}`;
    const allPrimitive = value.every(v => v === null || typeof v !== 'object');
    if (allPrimitive) return ` ${value.map(v => formatValue(v)).join(', ')}`;
    return '\n' + value
      .map(v => `${' '.repeat(indent)}- ${typeof v === 'object' && v !== null ? formatNestedValue(v, indent + 2).trimStart() : formatValue(v)}`)
      .join('\n');
  }

  const keys = Object.keys(value);
  if (keys.length === 0) return ` ${chalk.dim('{}')}`;
  return '\n' + keys
    .map(k => {
      const v = value[k];
      if (v !== null && typeof v === 'object') {
        return `${' '.repeat(indent)}${chalk.dim(k + ':')}${formatNestedValue(v, indent + 2)}`;
      }
      return `${' '.repeat(indent)}${chalk.dim(k + ':')} ${formatValue(v)}`;
    })
    .join('\n');
}

/**
 * Print a success message
 */
export function printSuccess(message) {
  const format = getOutputFormat();
  if (format === 'json') {
    console.log(JSON.stringify({ success: true, message }));
  } else if (format !== 'quiet') {
    console.log(chalk.green(message));
  }
}

/**
 * Print a warning message
 */
export function printWarning(message) {
  if (getOutputFormat() !== 'quiet') {
    console.error(chalk.yellow(message));
  }
}

/**
 * Print info message (suppressed in quiet/json mode)
 */
export function printInfo(message) {
  const format = getOutputFormat();
  if (format !== 'quiet' && format !== 'json') {
    console.log(chalk.dim(message));
  }
}

// -- Internal helpers --

function formatTable(rows, columns, headers, options) {
  const table = new Table({
    head: headers.map(h => chalk.bold(h)),
    style: { head: [], border: [] },
    chars: {
      'top': '', 'top-mid': '', 'top-left': '', 'top-right': '',
      'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      'left': '', 'left-mid': '', 'mid': '', 'mid-mid': '',
      'right': '', 'right-mid': '', 'middle': '  ',
    },
  });

  for (const row of rows) {
    table.push(columns.map(col => formatValue(row[col])));
  }

  console.log(table.toString());

  // Show count
  if (rows.length > 10) {
    console.log(chalk.dim(`\n${rows.length} items`));
  }
}

function formatCsv(rows, columns, headers) {
  console.log(headers.map(csvEscape).join(','));
  for (const row of rows) {
    console.log(columns.map(col => csvEscape(row[col])).join(','));
  }
}

function formatQuiet(rows, columns) {
  // Print first column (usually ID) of each row
  const idCol = columns[0];
  for (const row of rows) {
    console.log(row[idCol] ?? '');
  }
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatValue(value) {
  if (value == null) return chalk.dim('-');
  if (typeof value === 'boolean') return value ? chalk.green('yes') : chalk.dim('no');

  const str = String(value);

  // Color status values
  const lower = str.toLowerCase();
  if (['active', 'healthy', 'operational', 'approved', 'online', 'success'].includes(lower)) {
    return chalk.green(str);
  }
  if (['degraded', 'warning', 'pending', 'in_progress', 'draft', 'stale'].includes(lower)) {
    return chalk.yellow(str);
  }
  if (['error', 'down', 'failed', 'rejected', 'retired', 'offline', 'suspended', 'dead'].includes(lower)) {
    return chalk.red(str);
  }

  // Truncate long values in table mode
  if (str.length > 60) return str.slice(0, 57) + '...';

  return str;
}

export function getOutputFormat() {
  if (process.argv.includes('--json')) return 'json';
  if (process.argv.includes('-q') || process.argv.includes('--quiet')) return 'quiet';

  const idx = process.argv.indexOf('-o');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const idx2 = process.argv.indexOf('--output');
  if (idx2 !== -1 && process.argv[idx2 + 1]) return process.argv[idx2 + 1];

  return 'table';
}
