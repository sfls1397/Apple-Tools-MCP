/**
 * rebuild_index (rebuildIndex) records lastIndexPassTime like indexAll does,
 * but only for a clean rebuild of all three sources: a partial rebuild leaves
 * the other sources as old as they were (fake HOME, mocked embedder, no data).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (texts) => {
    const list = Array.isArray(texts) ? texts : [texts]
    return { data: new Float32Array(list.length * 384) }
  }
}))

const saved = {}
let tmp
let metaFile
let indexer
let origError

function readMeta () {
  return fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {}
}

describe('rebuildIndex records the index pass time', () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-rebuild-pass-'))
    for (const k of ['HOME', 'APPLE_TOOLS_INDEX_DIR', 'APPLE_TOOLS_META_FILE']) saved[k] = process.env[k]
    process.env.HOME = tmp
    process.env.APPLE_TOOLS_INDEX_DIR = path.join(tmp, 'index')
    metaFile = path.join(tmp, 'index-meta.json')
    process.env.APPLE_TOOLS_META_FILE = metaFile
    origError = console.error
    console.error = () => {}
    vi.resetModules()
    indexer = await import('../../indexer.js')
  })

  afterAll(() => {
    console.error = origError
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('isFullIndexPass needs all three sources and no errors', () => {
    expect(indexer.isFullIndexPass(['emails', 'messages', 'calendar'], [])).toBe(true)
    expect(indexer.isFullIndexPass(['calendar', 'emails', 'messages'])).toBe(true)
    expect(indexer.isFullIndexPass(['emails', 'messages'], [])).toBe(false)
    expect(indexer.isFullIndexPass(['emails', 'messages', 'calendar'], [{ source: 'emails' }])).toBe(false)
    expect(indexer.isFullIndexPass(undefined, [])).toBe(false)
  })

  it('a partial rebuild leaves the pass time alone', async () => {
    fs.writeFileSync(metaFile, JSON.stringify({ lastIndexPassTime: 1000 }))
    const result = await indexer.rebuildIndex(['calendar'])
    expect(result.errors).toEqual([])
    expect(readMeta().lastIndexPassTime).toBe(1000)
  })

  it('a clean full rebuild records it, keeping the other meta fields', async () => {
    fs.writeFileSync(metaFile, JSON.stringify({ lastIndexPassTime: 1000, lastIndexOptimizeTime: 7 }))
    const before = Date.now()
    const result = await indexer.rebuildIndex()
    expect(result.errors).toEqual([])
    const meta = readMeta()
    expect(meta.lastIndexPassTime).toBeGreaterThanOrEqual(before)
    expect(meta.lastIndexOptimizeTime).toBe(7)
    expect(indexer.getLastIndexPassTime()).toBe(meta.lastIndexPassTime)
  })
})
