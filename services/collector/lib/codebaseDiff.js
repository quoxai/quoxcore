/**
 * Codebase Diff Engine
 */

function diffScans(previous, current) {
  if (!previous || !current) return [];
  const changes = [];
  changes.push(...diffRegistries(previous.registries, current.registries));
  changes.push(...diffRoutes(previous.routes, current.routes));
  changes.push(...diffServices(previous.services, current.services));
  changes.push(...diffSchemas(previous.schemas, current.schemas));
  changes.push(...diffInvariants(previous.invariantChecks, current.invariantChecks));
  changes.push(...diffMetrics(previous.metrics, current.metrics));
  return changes;
}

function diffRegistries(prev = [], curr = []) {
  const changes = [];
  const prevMap = new Map(prev.map((r) => [r.name, r]));
  const currMap = new Map(curr.map((r) => [r.name, r]));

  for (const [name, reg] of currMap) {
    if (!prevMap.has(name)) {
      changes.push({ changeType: 'added', elementType: 'registry', elementName: name, details: { entryCount: reg.entryCount } });
      continue;
    }
    const prevReg = prevMap.get(name);
    const prevIds = new Set(prevReg.entries.map((e) => e.id));
    const currIds = new Set(reg.entries.map((e) => e.id));

    for (const entry of reg.entries) {
      if (!prevIds.has(entry.id)) changes.push({ changeType: 'added', elementType: name.replace(/s$/, ''), elementName: entry.id, details: { registry: name } });
    }
    for (const entry of prevReg.entries) {
      if (!currIds.has(entry.id)) changes.push({ changeType: 'removed', elementType: name.replace(/s$/, ''), elementName: entry.id, details: { registry: name } });
    }
    if (prevReg.entryCount !== reg.entryCount) {
      changes.push({ changeType: 'modified', elementType: 'registry', elementName: name, details: { from: prevReg.entryCount, to: reg.entryCount } });
    }
  }
  for (const [name] of prevMap) {
    if (!currMap.has(name)) changes.push({ changeType: 'removed', elementType: 'registry', elementName: name });
  }
  return changes;
}

function diffRoutes(prev = [], curr = []) {
  const changes = [];
  const prevPaths = new Set(prev.map((r) => r.path));
  const currPaths = new Set(curr.map((r) => r.path));
  for (const r of curr) { if (!prevPaths.has(r.path)) changes.push({ changeType: 'added', elementType: 'route', elementName: r.path, details: { protected: r.protected, minRole: r.minRole } }); }
  for (const r of prev) { if (!currPaths.has(r.path)) changes.push({ changeType: 'removed', elementType: 'route', elementName: r.path }); }
  for (const cr of curr) {
    const pr = prev.find((r) => r.path === cr.path);
    if (pr && pr.minRole !== cr.minRole) changes.push({ changeType: 'modified', elementType: 'route', elementName: cr.path, details: { field: 'minRole', from: pr.minRole, to: cr.minRole } });
  }
  return changes;
}

function diffServices(prev = [], curr = []) {
  const changes = [];
  const prevNames = new Set(prev.map((s) => s.name));
  const currNames = new Set(curr.map((s) => s.name));
  for (const s of curr) { if (!prevNames.has(s.name)) changes.push({ changeType: 'added', elementType: 'service', elementName: s.name, details: { port: s.port } }); }
  for (const s of prev) { if (!currNames.has(s.name)) changes.push({ changeType: 'removed', elementType: 'service', elementName: s.name }); }
  for (const cs of curr) {
    const ps = prev.find((s) => s.name === cs.name);
    if (ps && ps.port !== cs.port) changes.push({ changeType: 'modified', elementType: 'service', elementName: cs.name, details: { field: 'port', from: ps.port, to: cs.port } });
  }
  return changes;
}

function diffSchemas(prev = [], curr = []) {
  const changes = [];
  const prevMap = new Map(prev.map((s) => [s.name, s]));
  for (const [name, schema] of new Map(curr.map((s) => [s.name, s]))) {
    if (!prevMap.has(name)) { changes.push({ changeType: 'added', elementType: 'schema', elementName: name, details: { tableCount: schema.tableCount } }); continue; }
    const ps = prevMap.get(name);
    if (ps.tableCount !== schema.tableCount) changes.push({ changeType: 'modified', elementType: 'schema', elementName: name, details: { from: ps.tableCount, to: schema.tableCount } });
    const prevTables = new Set(ps.tableNames || []);
    const currTables = new Set(schema.tableNames || []);
    for (const t of currTables) { if (!prevTables.has(t)) changes.push({ changeType: 'added', elementType: 'table', elementName: `${name}.${t}` }); }
    for (const t of prevTables) { if (!currTables.has(t)) changes.push({ changeType: 'removed', elementType: 'table', elementName: `${name}.${t}` }); }
  }
  return changes;
}

function diffInvariants(prev = [], curr = []) {
  const changes = [];
  const prevMap = new Map(prev.map((c) => [c.name, c]));
  for (const check of curr) {
    const pc = prevMap.get(check.name);
    if (pc && pc.status !== check.status) changes.push({ changeType: 'modified', elementType: 'invariant', elementName: check.name, details: { from: pc.status, to: check.status, message: check.message } });
  }
  return changes;
}

function diffMetrics(prev = {}, curr = {}) {
  const changes = [];
  for (const key of ['routeCount', 'serviceCount', 'testFileCount']) {
    if (prev[key] !== undefined && curr[key] !== undefined && prev[key] !== curr[key]) {
      changes.push({ changeType: 'modified', elementType: 'metric', elementName: key, details: { from: prev[key], to: curr[key] } });
    }
  }
  return changes;
}

module.exports = { diffScans };
