/**
 * Vitest global setup for apple-tools-mcp tests
 *
 * Uses REAL data sources - no mocking.
 */

import { beforeAll } from 'vitest'

// Must run during setupFiles (before test files import indexer.js).
// DAYS_BACK is a module-level const; production default is unlimited.
// Tests keep a 30-day cap so they stay fast.
process.env.APPLE_TOOLS_INDEX_DAYS_BACK = process.env.APPLE_TOOLS_INDEX_DAYS_BACK || '30'

// Set up test environment
beforeAll(() => {
  // Ensure HOME is set for tests
  if (!process.env.HOME) {
    throw new Error('HOME environment variable must be set for real data tests')
  }
})
