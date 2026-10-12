/**
 * n8n Expression Converter
 *
 * Converts n8n expression syntax to Quoxflow expressions.
 *
 * n8n expressions:
 *   {{ $json.field }}           → ${input.field}
 *   {{ $node["Name"].json }}    → ${nodes.Name.output}
 *   {{ $input.first() }}        → ${$.first(input)}
 *   {{ $now }}                  → ${$.now()}
 *   {{ $env.VAR }}              → ${env.VAR}
 *   {{ $execution.id }}         → ${execution.id}
 *   {{ $workflow.id }}          → ${workflow.id}
 */

// n8n expression pattern: {{ ... }} or ={{ ... }} (= indicates expression mode)
const N8N_EXPR_PATTERN = /=?\{\{\s*(.+?)\s*\}\}/g;

// Common n8n variable mappings
const VARIABLE_MAPPINGS: Record<string, string> = {
  '$json': 'input',
  '$input.item.json': 'input',
  '$input.first().json': 'input',
  '$input.last().json': 'input',
  '$binary': 'input._binary',
  '$now': '$.now()',
  '$today': '$.now().split("T")[0]',
  '$runIndex': 'vars._runIndex || 0',
  '$itemIndex': 'vars._itemIndex || 0',
  '$position': 'vars._position || 0',
  '$env': 'env',
  '$execution.id': 'execution.id',
  '$execution.resumeUrl': 'execution.resumeUrl',
  '$workflow.id': 'workflow.id',
  '$workflow.name': 'workflow.name',
  '$workflow.active': 'workflow.active',
  '$parameter': 'vars',
  '$parameters': 'vars',
  '$prevNode.json': 'input',
};

export interface ConversionResult {
  converted: string;
  warnings: string[];
  expressionCount: number;
}

/**
 * Convert a single n8n expression to Quoxflow syntax
 */
export function convertExpression(n8nExpr: string): { expr: string; warnings: string[] } {
  const warnings: string[] = [];
  let expr = n8nExpr.trim();

  // Direct variable mappings
  for (const [n8nVar, quoxVar] of Object.entries(VARIABLE_MAPPINGS)) {
    if (expr === n8nVar) {
      return { expr: quoxVar, warnings };
    }
    // Replace as part of larger expression
    expr = expr.replace(new RegExp(escapeRegex(n8nVar), 'g'), quoxVar);
  }

  // $json.field → input.field
  expr = expr.replace(/\$json\.(\w+)/g, 'input.$1');
  expr = expr.replace(/\$json\[["'](.+?)["']\]/g, 'input["$1"]');

  // $node["NodeName"].json.field → nodes.NodeName.output.field
  expr = expr.replace(
    /\$node\[["'](.+?)["']\]\.json\.?/g,
    (_, nodeName) => `nodes["${nodeName}"].output.`
  );
  expr = expr.replace(
    /\$node\[["'](.+?)["']\]\.json/g,
    (_, nodeName) => `nodes["${nodeName}"].output`
  );

  // $items() → input (when iterating)
  expr = expr.replace(/\$items\(\)/g, 'input');
  expr = expr.replace(/\$items\(["'](.+?)["']\)/g, 'nodes["$1"].output');

  // Modern n8n $('NodeName') function syntax
  expr = expr.replace(/\$\(["'](.+?)["']\)\.item\.json\.?/g, (_, name) => `nodes["${name}"].output.`);
  expr = expr.replace(/\$\(["'](.+?)["']\)\.first\(\)\.json\.?/g, (_, name) => `nodes["${name}"].output.`);
  expr = expr.replace(/\$\(["'](.+?)["']\)\.all\(\)/g, (_, name) => `nodes["${name}"].output`);
  expr = expr.replace(/\$\(["'](.+?)["']\)\.item/g, (_, name) => `nodes["${name}"].output`);

  // $input.first() / $input.last() / $input.all()
  expr = expr.replace(/\$input\.first\(\)\.json/g, 'input');
  expr = expr.replace(/\$input\.last\(\)\.json/g, 'input');
  expr = expr.replace(/\$input\.all\(\)/g, 'input');
  expr = expr.replace(/\$input\.first\(\)/g, '$.first(input)');
  expr = expr.replace(/\$input\.last\(\)/g, '$.last(input)');

  // $item methods
  expr = expr.replace(/\$item\.json/g, 'input');
  expr = expr.replace(/\$item/g, 'input');

  // Date/time functions
  // Note: $now is already converted to $.now() by VARIABLE_MAPPINGS, so match the converted form
  expr = expr.replace(/\$\.now\(\)\.toISO\(\)/g, '$.now()');
  expr = expr.replace(/\$\.now\(\)\.format\(["'](.+?)["']\)/g, (_, fmt) => {
    if (fmt === 'yyyy-MM-dd' || fmt === 'YYYY-MM-DD') return '$.now().split("T")[0]';
    if (fmt.includes('HH:mm')) return '$.now().split("T")[1].split(".")[0]';
    return '$.now()';
  });
  // Also catch the unconverted form (in case called before variable mapping)
  expr = expr.replace(/\$now\.toISO\(\)/g, '$.now()');
  expr = expr.replace(/\$now\.format\(["'](.+?)["']\)/g, (_, fmt) => {
    if (fmt === 'yyyy-MM-dd' || fmt === 'YYYY-MM-DD') return '$.now().split("T")[0]';
    if (fmt.includes('HH:mm')) return '$.now().split("T")[1].split(".")[0]';
    return '$.now()';
  });
  expr = expr.replace(/\$today/g, '$.now().split("T")[0]');

  // isEmpty / isNotEmpty
  expr = expr.replace(/(\w[\w.[\]"']*?)\.isEmpty\(\)/g, '$.isEmpty($1)');
  expr = expr.replace(/(\w[\w.[\]"']*?)\.isNotEmpty\(\)/g, '!$.isEmpty($1)');

  // Math methods (these work as-is in JS)
  // String methods (mostly work as-is)

  // Handle if() ternary - n8n uses {{$if(cond, true, false)}}
  expr = expr.replace(/\$if\((.+?),\s*(.+?),\s*(.+?)\)/g, '($1 ? $2 : $3)');

  // Handle jmespath (warn, not supported)
  if (expr.includes('$jmespath')) {
    warnings.push('JMESPath expressions are not directly supported. Consider using native JS.');
    expr = expr.replace(/\$jmespath\(.+?\)/g, 'null /* JMESPath not supported */');
  }

  // Handle Object.entries/keys/values
  expr = expr.replace(/Object\.entries\((.+?)\)/g, '$.entries($1)');
  expr = expr.replace(/Object\.keys\((.+?)\)/g, '$.keys($1)');
  expr = expr.replace(/Object\.values\((.+?)\)/g, '$.values($1)');

  // Clean up any remaining $ prefixes that weren't caught
  if (expr.includes('$') && !expr.includes('$.')) {
    // Check for unknown n8n variables
    const unknownVars = expr.match(/\$[a-zA-Z_]\w*/g);
    if (unknownVars) {
      for (const v of unknownVars) {
        if (!['$', '$.'].some(p => v.startsWith(p))) {
          warnings.push(`Unknown n8n variable: ${v}`);
        }
      }
    }
  }

  return { expr, warnings };
}

/**
 * Convert all n8n expressions in a string to Quoxflow syntax
 */
export function convertString(input: string): ConversionResult {
  const warnings: string[] = [];
  let expressionCount = 0;

  const converted = input.replace(N8N_EXPR_PATTERN, (match, expr) => {
    expressionCount++;
    const { expr: convertedExpr, warnings: exprWarnings } = convertExpression(expr);
    warnings.push(...exprWarnings);
    return `\${${convertedExpr}}`;
  });

  return { converted, warnings, expressionCount };
}

/**
 * Recursively convert expressions in an object
 */
export function convertObject(obj: unknown): { result: unknown; warnings: string[]; count: number } {
  const allWarnings: string[] = [];
  let totalCount = 0;

  function convert(value: unknown): unknown {
    if (typeof value === 'string') {
      if (value.includes('{{')) {
        const { converted, warnings, expressionCount } = convertString(value);
        allWarnings.push(...warnings);
        totalCount += expressionCount;
        return converted;
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(convert);
    }

    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = convert(val);
      }
      return result;
    }

    return value;
  }

  return {
    result: convert(obj),
    warnings: allWarnings,
    count: totalCount,
  };
}

/**
 * Check if a string contains n8n expressions
 */
export function hasN8nExpressions(value: string): boolean {
  N8N_EXPR_PATTERN.lastIndex = 0;
  return N8N_EXPR_PATTERN.test(value);
}

/**
 * Extract all n8n expressions from a string
 */
export function extractN8nExpressions(value: string): string[] {
  const expressions: string[] = [];
  let match;

  N8N_EXPR_PATTERN.lastIndex = 0;
  while ((match = N8N_EXPR_PATTERN.exec(value)) !== null) {
    expressions.push(match[1].trim());
  }

  return expressions;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
