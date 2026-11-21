#!/usr/bin/env node
if (!process.argv.includes('--transport=http')) {
  const transportIdx = process.argv.indexOf('--transport');
  if (transportIdx === -1 || process.argv[transportIdx + 1] !== 'http') {
    process.argv.splice(2, 0, '--transport=http');
  }
}
await import('../index.js');
