/**
 * Off-main-thread SQLite reads for heavy dashboard status probes.
 *
 * CORTEX-BENCH 2026-10-08: a live CPU profile of the collector showed the
 * dashboard's status probes (VOLT stats over a 91GB volt db, AEE stats) running
 * synchronous better-sqlite3 aggregates on the MAIN thread, each miss blocking
 * the event loop for 1.5-3s and stalling every other request (agent tool
 * calls, LLM reranks, slot waits). These reads now run in a worker thread on
 * its own READ-ONLY connection, so a slow aggregate costs only its caller.
 *
 * runProbe(dbPath, sql, params) -> Promise<row>   (one long-lived worker)
 * createAsyncProbeCache({ ttlMs }) -> { get(key, loader) }: fresh value from
 *   cache; stale value returned immediately while ONE background refresh runs;
 *   no value -> await the loader. Errors are never cached.
 */
'use strict';

const { Worker } = require('node:worker_threads');

const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
const dbs = new Map();
parentPort.on('message', ({ id, dbPath, sql, params, mode }) => {
  try {
    let db = dbs.get(dbPath);
    if (!db) { db = new Database(dbPath, { readonly: true, fileMustExist: true }); dbs.set(dbPath, db); }
    const st = db.prepare(sql);
    const fn = mode === 'all' ? st.all.bind(st) : st.get.bind(st);
    const row = Array.isArray(params) ? fn(...params) : fn(params);
    parentPort.postMessage({ id, row });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err && err.message || err) });
  }
});
`;

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  const self = new Worker(WORKER_SRC, { eval: true });
  worker = self;
  worker.unref();
  worker.on('message', ({ id, row, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error)); else p.resolve(row);
  });
  const fail = (err) => {
    if (worker !== self) return; // superseded (terminated after a timeout)
    for (const p of pending.values()) p.reject(err instanceof Error ? err : new Error(String(err)));
    pending.clear();
    worker = null; // the next probe starts a fresh worker
  };
  worker.on('error', fail);
  worker.on('exit', (code) => { if (code !== 0) fail(new Error(`probe worker exited ${code}`)); else if (worker === self) worker = null; });
  return worker;
}

function runProbe(dbPath, sql, params, { timeoutMs = 60000, mode = 'get' } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('probe timeout'));
      // A worker stuck inside a synchronous SQLite call cannot be interrupted
      // cooperatively and would queue every later probe behind it: kill it so
      // the next probe starts a fresh worker. Other in-flight probes on the
      // dead worker are rejected (they are retried by their callers).
      const w = worker;
      if (w) {
        worker = null;
        for (const [pid, p] of pending) { p.reject(new Error('probe worker restarted after timeout')); pending.delete(pid); }
        w.terminate().catch(() => {});
      }
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      getWorker().postMessage({ id, dbPath, sql, params, mode });
    } catch (err) {
      pending.delete(id); clearTimeout(timer); reject(err);
    }
  });
}

function createAsyncProbeCache({ ttlMs = 60000, max = 500, now = () => Date.now() } = {}) {
  const entries = new Map(); // key -> { value, at }
  const refreshing = new Map(); // key -> Promise
  function refresh(key, loader) {
    if (refreshing.has(key)) return refreshing.get(key);
    const p = Promise.resolve().then(loader).then((value) => {
      entries.set(key, { value, at: now() });
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return value;
    }).finally(() => refreshing.delete(key));
    refreshing.set(key, p);
    return p;
  }
  return {
    async get(key, loader) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      if (hit) { refresh(key, loader).catch(() => {}); return hit.value; } // stale-while-revalidate
      return refresh(key, loader);
    },
    _size: () => entries.size,
  };
}

module.exports = { runProbe, createAsyncProbeCache };
