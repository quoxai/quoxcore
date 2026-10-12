const { cases } = require('./cases.js');

function runAll({ text, ctx }) {
  const results = cases.map(c => ({
    case_id: c.id,
    description: c.description,
    ...c.evaluate({ text, ctx }),
  }));
  const failures = results.filter(r => !r.passed);
  return {
    total: results.length,
    passed: results.length - failures.length,
    failures,
    results,
  };
}

module.exports = { cases, runAll, default: runAll };
