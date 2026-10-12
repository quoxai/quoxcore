#!/usr/bin/env node

/**
 * ward-verify — CLI tool for WARD chain integrity verification.
 * VERIFICATION.md §6
 *
 * Usage:
 *   ward-verify --store <sqlite_path> --chain <chain_id>
 *   ward-verify --store <sqlite_path> --all
 *   ward-verify --store <sqlite_path> --chain <chain_id> --pubkey <pem_path>
 *   ward-verify --store <sqlite_path> --stats
 *
 * Exit codes:
 *   0 = INTACT (all chains verified)
 *   1 = BROKEN (at least one chain failed)
 *   2 = ERROR (bad arguments, store not readable)
 *   3 = PARTIAL (chain incomplete)
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initWardStore, closeWardStore, getDb, getStats } from '../lib/store.js';
import { verifyChain } from '../lib/verify.js';

const EXIT_INTACT = 0;
const EXIT_BROKEN = 1;
const EXIT_ERROR = 2;
const EXIT_PARTIAL = 3;

function usage() {
  console.log(`ward-verify — WARD chain integrity verification (v0.1)

Usage:
  ward-verify --store <path> --chain <chain_id>   Verify a single chain
  ward-verify --store <path> --all                 Verify all chains
  ward-verify --store <path> --stats               Show store statistics
  ward-verify --store <path> --chain <id> --pubkey <pem>  Verify with signature check

Options:
  --store   <path>      Path to WARD SQLite database (required)
  --chain   <chain_id>  Chain ID to verify
  --all                 Verify all chains in the store
  --pubkey  <path>      Path to Ed25519 public key PEM (for tip signature verification)
  --stats               Show store statistics (chains, entries, tips)
  --json                Output results as JSON
  --help                Show this help message

Exit codes:
  0  INTACT   — all verified chains are intact
  1  BROKEN   — at least one chain is broken
  2  ERROR    — invalid arguments or store not readable
  3  PARTIAL  — at least one chain is incomplete`);
}

function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        store:  { type: 'string' },
        chain:  { type: 'string' },
        all:    { type: 'boolean', default: false },
        pubkey: { type: 'string' },
        stats:  { type: 'boolean', default: false },
        json:   { type: 'boolean', default: false },
        help:   { type: 'boolean', default: false },
      },
      strict: true,
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    usage();
    process.exit(EXIT_ERROR);
  }

  const { store, chain, all, pubkey, stats, json, help } = args.values;

  if (help) {
    usage();
    process.exit(0);
  }

  if (!store) {
    console.error('Error: --store <path> is required');
    usage();
    process.exit(EXIT_ERROR);
  }

  if (!existsSync(store)) {
    console.error(`Error: store not found: ${store}`);
    process.exit(EXIT_ERROR);
  }

  if (!chain && !all && !stats) {
    console.error('Error: specify --chain <id>, --all, or --stats');
    usage();
    process.exit(EXIT_ERROR);
  }

  // Load public key if provided
  let publicKey = null;
  if (pubkey) {
    if (!existsSync(pubkey)) {
      console.error(`Error: public key not found: ${pubkey}`);
      process.exit(EXIT_ERROR);
    }
    try {
      publicKey = createPublicKey(readFileSync(pubkey, 'utf8'));
    } catch (err) {
      console.error(`Error: failed to load public key: ${err.message}`);
      process.exit(EXIT_ERROR);
    }
  }

  // Open store
  try {
    initWardStore(store);
  } catch (err) {
    console.error(`Error: failed to open store: ${err.message}`);
    process.exit(EXIT_ERROR);
  }

  try {
    if (stats) {
      runStats(json);
      process.exit(0);
    }

    if (chain) {
      const result = runVerifyOne(chain, publicKey, json);
      process.exit(exitCodeFor(result.status));
    }

    if (all) {
      const exitCode = runVerifyAll(publicKey, json);
      process.exit(exitCode);
    }
  } finally {
    closeWardStore();
  }
}

function runStats(json) {
  const db = getDb();
  const s = getStats();
  const chains = db.prepare('SELECT chain_id, scope, entry_count, head_seq, status FROM ward_chains ORDER BY chain_id').all();

  if (json) {
    console.log(JSON.stringify({ chain_count: s.chains, entries: s.entries, tips: s.tips, chains }, null, 2));
    return;
  }

  console.log(`WARD Store Statistics`);
  console.log(`  Chains:  ${s.chains}`);
  console.log(`  Entries: ${s.entries}`);
  console.log(`  Tips:    ${s.tips}`);
  if (chains.length > 0) {
    console.log(`\nChains:`);
    for (const c of chains) {
      console.log(`  ${c.chain_id}  entries=${c.entry_count}  head=${c.head_seq}  status=${c.status}`);
    }
  }
}

function runVerifyOne(chainId, publicKey, json) {
  const result = verifyChain(chainId, { publicKey });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  printResult(result);
  return result;
}

function runVerifyAll(publicKey, json) {
  const db = getDb();
  const chains = db.prepare('SELECT chain_id FROM ward_chains ORDER BY chain_id').all();

  if (chains.length === 0) {
    if (json) {
      console.log(JSON.stringify({ message: 'No chains found', results: [] }));
    } else {
      console.log('No chains found in store.');
    }
    return EXIT_ERROR;
  }

  const results = [];
  let worstExit = EXIT_INTACT;

  for (const { chain_id } of chains) {
    const result = verifyChain(chain_id, { publicKey });
    results.push(result);
    const code = exitCodeFor(result.status);
    if (code > worstExit) worstExit = code;
  }

  if (json) {
    console.log(JSON.stringify({ total: results.length, results }, null, 2));
  } else {
    console.log(`Verifying ${results.length} chain(s)...\n`);
    for (const r of results) {
      printResult(r);
      console.log('');
    }
    const intact = results.filter(r => r.status === 'INTACT').length;
    const broken = results.filter(r => r.status === 'BROKEN').length;
    const partial = results.filter(r => r.status === 'PARTIAL').length;
    console.log(`Summary: ${intact} INTACT, ${broken} BROKEN, ${partial} PARTIAL`);
  }

  return worstExit;
}

function printResult(result) {
  const icon = result.status === 'INTACT' ? '\u2713' : result.status === 'BROKEN' ? '\u2717' : '~';

  console.log(`${icon} ${result.chain_id}  ${result.status}`);

  if (result.status === 'INTACT') {
    console.log(`  entries: ${result.entry_count}  head_seq: ${result.head_seq}`);
    console.log(`  genesis: verified  tips: ${result.tips_verified}  sigs: ${result.signatures_verified}`);
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.log(`  warning: ${w}`);
      }
    }
  } else if (result.status === 'BROKEN') {
    console.log(`  reason: ${result.reason}`);
    if (result.details) {
      for (const [k, v] of Object.entries(result.details)) {
        console.log(`  ${k}: ${v}`);
      }
    }
  } else if (result.status === 'PARTIAL') {
    console.log(`  reason: ${result.reason}`);
    if (result.details) {
      for (const [k, v] of Object.entries(result.details)) {
        console.log(`  ${k}: ${v}`);
      }
    }
  }
}

function exitCodeFor(status) {
  if (status === 'INTACT') return EXIT_INTACT;
  if (status === 'BROKEN') return EXIT_BROKEN;
  if (status === 'PARTIAL') return EXIT_PARTIAL;
  return EXIT_ERROR;
}

main();
