#!/usr/bin/env node
if (!process.argv.includes('--mode=indexer')) {
  const modeIdx = process.argv.indexOf('--mode');
  if (modeIdx === -1 || process.argv[modeIdx + 1] !== 'indexer') {
    process.argv.splice(2, 0, '--mode=indexer');
  }
}
await import('../index.js');
