/**
 * Vitest global setup for apple-tools-mcp tests
 *
 * Uses REAL data sources - no mocking.
 */

import { beforeAll } from 'vitest'

// Set up test environment
beforeAll(() => {
  // Ensure HOME is set for tests
  if (!process.env.HOME) {
    throw new Error('HOME environment variable must be set for real data tests')
  }
})
