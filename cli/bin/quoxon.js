#!/usr/bin/env node
import '../lib/core/prodEnv.js'; // first: production React unless NODE_ENV is set (before anything loads React)
import { main } from '../lib/quoxon/main.js';

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
