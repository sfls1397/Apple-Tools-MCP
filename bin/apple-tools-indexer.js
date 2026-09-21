#!/usr/bin/env node
/**
 * npm bin for the indexer daemon.
 * Dedicated wrapper so npm 12 pack/publish keeps the CLI — `index.js` as a
 * bin target is rewritten with "script name index.js was invalid and removed".
 * Injects `--mode=indexer` so a realpath to this file still starts the daemon.
 * `permissions` still wins (same contract as the apple-tools-indexer bin name).
 */
if (!process.argv.includes('--mode=indexer')) {
  const modeIdx = process.argv.indexOf('--mode');
  if (modeIdx === -1 || process.argv[modeIdx + 1] !== 'indexer') {
    process.argv.splice(2, 0, '--mode=indexer');
  }
}
await import('../index.js');
