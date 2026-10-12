// Worker thread: loads + packs the dense vector set off the main event loop.
// Opens its OWN read-only connection (WAL permits concurrent readers).
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { loadDensePacked } from './denseLoader.js'

let db = null
try {
  if (workerData.testFail) throw new Error('test-injected worker failure')
  db = new Database(workerData.dbPath, { readonly: true })
  db.pragma('busy_timeout = 5000')
  if (workerData.testDelayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.testDelayMs) // test hook: simulate slow query
  const p = loadDensePacked(db, workerData.org_id, workerData.model, workerData.cfg)
  const { scopeIdx, ...rest } = p // Map rebuilt on the main side
  parentPort.postMessage({ packed: rest }, [rest.mat.buffer, rest.scopeCodes.buffer])
} catch (err) {
  parentPort.postMessage({ error: err && err.message ? err.message : String(err) })
} finally {
  if (db) db.close()
}
