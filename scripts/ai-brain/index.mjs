#!/usr/bin/env node

import { main } from '../../apps/cli/index.mjs';

console.warn('[brain] scripts/ai-brain/index.mjs is a legacy compatibility shim. Use apps/cli/index.mjs or npm run brain:* commands instead.');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});