#!/usr/bin/env node
/**
 * npm bin for the HTTP transport.
 * Dedicated wrapper so npm 12 pack/publish keeps the CLI — `index.js` as a
 * bin target is rewritten with "script name index.js was invalid and removed".
 * Injects `--transport=http` so a realpath to this file still starts the
 * HTTP server. `permissions` / `http-token` still win (same contract as the
 * apple-tools-indexer bin name for `--mode=indexer`).
 */
if (!process.argv.includes('--transport=http')) {
  const transportIdx = process.argv.indexOf('--transport');
  if (transportIdx === -1 || process.argv[transportIdx + 1] !== 'http') {
    process.argv.splice(2, 0, '--transport=http');
  }
}
await import('../index.js');
