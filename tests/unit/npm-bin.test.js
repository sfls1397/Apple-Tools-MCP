/**
 * npm 12 publish strips / rewrites bin entries whose path is not already
 * unix-normalized. Live v2.0.2 evidence:
 *
 *   npm warn publish "bin[apple-tools-mcp]" script name index.js was invalid and removed
 *   npm warn publish "bin[apple-tools-indexer]" script name index.js was invalid and removed
 *
 * That warning fires when `secureAndUnixifyPath(binTarget) !== binTarget`
 * (typically a leading `./`, or using `index.js` as the script name).
 * Two CLIs cannot use npm's string-form `bin`, so we ship dedicated
 * `bin/*.js` wrappers — the EdgeCore pattern, object form without `./`.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { isIndexerMode, isPermissionsMode } from '../../lib/processMode.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const CLI_BINS = {
  'apple-tools-mcp': 'bin/apple-tools-mcp.js',
  'apple-tools-indexer': 'bin/apple-tools-indexer.js'
}

/** Mirror of npm's `@npmcli/package-json` `unixifyPath` + `secureAndUnixifyPath`. */
function unixifyPath(ref) {
  return String(ref).replace(/\\|:/g, '/')
}

function secureAndUnixifyPath(ref) {
  const secured = unixifyPath(path.join('.', path.join('/', unixifyPath(ref))))
  return secured.startsWith('./') ? '' : secured
}

/**
 * Mirror of npm 12 `normalizePackageBin` — the step that emits
 * `"bin[name]" script name … was invalid and removed` and can drop keys.
 */
function normalizePackageBin(binField, name) {
  const changes = []
  let bin = binField
  if (!bin) {
    return { bin: undefined, changes }
  }
  if (typeof bin === 'string' && name) {
    changes.push('"bin" was converted to an object')
    bin = { [name]: bin }
  }
  if (typeof bin !== 'object' || Array.isArray(bin)) {
    return { bin: undefined, changes: [...changes, 'empty "bin" was removed'] }
  }
  const next = {}
  for (const binKey of Object.keys(bin)) {
    if (typeof bin[binKey] !== 'string') {
      changes.push(`removed invalid "bin[${binKey}]"`)
      continue
    }
    const base = path.basename(secureAndUnixifyPath(binKey))
    if (!base) {
      changes.push(`removed invalid "bin[${binKey}]"`)
      continue
    }
    const binTarget = secureAndUnixifyPath(bin[binKey])
    if (!binTarget) {
      changes.push(`removed invalid "bin[${binKey}]"`)
      continue
    }
    if (binTarget !== bin[binKey]) {
      changes.push(`"bin[${base}]" script name ${binTarget} was invalid and removed`)
    }
    next[base] = binTarget
  }
  if (Object.keys(next).length === 0) {
    changes.push('empty "bin" was removed')
    return { bin: undefined, changes }
  }
  return { bin: next, changes }
}

describe('npm 12 bin publish contract', () => {
  it('uses dedicated wrappers (not index.js) so both CLIs survive pack/publish', () => {
    expect(pkg.name).toBe('apple-tools-mcp')
    expect(pkg.bin).toEqual(CLI_BINS)
    expect(pkg.files).toContain('bin/')

    for (const [cli, rel] of Object.entries(CLI_BINS)) {
      expect(rel, `${cli} must not use index.js (npm 12 strips it)`).not.toMatch(/(^|\/)index\.js$/)
      expect(rel, `${cli} must not use a ./ prefix (npm 12 rewrites it)`).not.toMatch(/^\.\//)
      expect(secureAndUnixifyPath(rel)).toBe(rel)

      const abs = path.join(root, rel)
      expect(fs.existsSync(abs), `${rel} must exist`).toBe(true)
      const src = fs.readFileSync(abs, 'utf8')
      expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true)
      expect(src).toMatch(/from ['"]\.\.\/index\.js['"]|import\(['"]\.\.\/index\.js['"]\)/)
    }

    const indexerSrc = fs.readFileSync(path.join(root, CLI_BINS['apple-tools-indexer']), 'utf8')
    expect(indexerSrc).toContain('--mode=indexer')
  })

  it('fails if npm 12 normalize would strip or rewrite either bin', () => {
    const { bin, changes } = normalizePackageBin(pkg.bin, pkg.name)
    expect(bin).toEqual(CLI_BINS)
    expect(changes.filter((c) => /invalid and removed|empty "bin" was removed/.test(c))).toEqual([])
    expect(bin['apple-tools-mcp']).toBe('bin/apple-tools-mcp.js')
    expect(bin['apple-tools-indexer']).toBe('bin/apple-tools-indexer.js')
  })

  it('docs name both CLIs and the wrapper paths npm pack must keep', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    expect(readme).toContain('apple-tools-mcp')
    expect(readme).toContain('apple-tools-indexer')
    expect(readme).toContain('bin/apple-tools-indexer.js')
    expect(readme).not.toMatch(/Convenience bin:\*\* `apple-tools-indexer` \(same file/)
  })

  it('packed package.json keeps both bins and the wrapper files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-tools-npm-bin-'))
    try {
      const packed = spawnSync('npm', ['pack', '--pack-destination', tmp], {
        cwd: root,
        encoding: 'utf8'
      })
      expect(packed.status, packed.stderr || packed.stdout).toBe(0)
      expect(`${packed.stdout}${packed.stderr}`).not.toMatch(/script name .* was invalid and removed/)

      const tgzName = fs.readdirSync(tmp).find((name) => name.endsWith('.tgz'))
      expect(tgzName).toBeTruthy()
      execFileSync('tar', ['-xzf', path.join(tmp, tgzName), '-C', tmp], { encoding: 'utf8' })

      const packedPkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package', 'package.json'), 'utf8'))
      expect(packedPkg.bin).toEqual(CLI_BINS)
      expect(fs.existsSync(path.join(tmp, 'package', 'bin', 'apple-tools-mcp.js'))).toBe(true)
      expect(fs.existsSync(path.join(tmp, 'package', 'bin', 'apple-tools-indexer.js'))).toBe(true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('wrapper argv still distinguishes MCP, indexer, and permissions', () => {
    expect(isIndexerMode(['node', path.join(root, CLI_BINS['apple-tools-indexer'])])).toBe(true)
    expect(isIndexerMode(['node', path.join(root, CLI_BINS['apple-tools-mcp'])])).toBe(false)
    expect(isPermissionsMode(['node', path.join(root, CLI_BINS['apple-tools-mcp']), 'permissions'])).toBe(true)
    expect(isIndexerMode(['node', path.join(root, CLI_BINS['apple-tools-indexer']), 'permissions'])).toBe(false)
  })
})
