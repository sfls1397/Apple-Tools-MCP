/**
 * Real Transformers.js/sharp idx tests must skip on Linux (and any host without
 * the platform sharp native). This package is darwin-only.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { embedderAvailable, checkDataSources } from '../helpers/real-data.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

describe('embedderAvailable', () => {
  it('is false on non-darwin hosts so real embedding idx tests skip', () => {
    if (process.platform !== 'darwin') {
      expect(embedderAvailable()).toBe(false)
      expect(checkDataSources().embedder).toBe(false)
    } else {
      expect(typeof embedderAvailable()).toBe('boolean')
    }
  })

  it('real embedding idx suites skip when the embedder is unavailable', () => {
    const files = [
      'tests/indexing/caching/real-embedding-cache.test.js',
      'tests/indexing/accuracy/real-data-correctness.test.js',
      'tests/indexing/integration/real-data-indexing.test.js',
      'tests/indexing/edge-cases/real-data-edge-cases.test.js',
      'tests/indexing/performance/real-data-throughput.test.js',
      'tests/indexing/resource/real-data-resources.test.js'
    ]
    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8')
      expect(src).toContain('skipIf(!sources.embedder)')
      expect(src).not.toMatch(/import\s*\{[^}]*buildProductionIndex/)
    }
  })
})
