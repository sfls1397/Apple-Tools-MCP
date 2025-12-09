#!/usr/bin/env node

/**
 * CLI Script for Auditing Index
 *
 * Usage:
 *   node scripts/audit-index.js
 *   node scripts/audit-index.js --sources emails,messages
 *   node scripts/audit-index.js --max-items 50
 *   node scripts/audit-index.js --sources calendar --max-items 0
 */

import { auditAll, formatAuditReport } from '../lib/audit.js';

// Parse command-line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    sources: ['emails', 'messages', 'calendar'],
    maxItems: 100
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--sources' && i + 1 < args.length) {
      options.sources = args[i + 1].split(',').map(s => s.trim());
      i++;
    } else if (arg === '--max-items' && i + 1 < args.length) {
      options.maxItems = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Audit Index - Check index integrity against source data

Usage:
  npm run audit
  npm run audit -- --sources emails,messages
  npm run audit -- --max-items 50
  npm run audit -- --sources calendar --max-items 0

Options:
  --sources <list>    Comma-separated list of sources to audit
                      Options: emails, messages, calendar
                      Default: emails,messages,calendar

  --max-items <num>   Maximum items to show per discrepancy category
                      Use 0 for unlimited
                      Default: 100

  --help, -h          Show this help message

Examples:
  npm run audit                                    # Audit all sources
  npm run audit -- --sources emails                # Audit emails only
  npm run audit -- --sources emails,messages       # Audit emails and messages
  npm run audit -- --max-items 50                  # Show max 50 items per category
  npm run audit -- --sources calendar --max-items 0  # Show all calendar discrepancies
`);
}

// Main execution
async function main() {
  try {
    const options = parseArgs();

    console.error('Starting index audit...');
    console.error(`Sources: ${options.sources.join(', ')}`);
    console.error(`Max items per category: ${options.maxItems === 0 ? 'unlimited' : options.maxItems}`);
    console.error('');

    const results = await auditAll(options);
    const report = formatAuditReport(results);

    // Print report to stdout
    console.log(report);

  } catch (error) {
    console.error('Error running audit:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
