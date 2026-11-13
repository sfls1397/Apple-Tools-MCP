import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/*
 * macOS Background Task Management tracks a LaunchAgent by its first program
 * (ProgramArguments[0]). When that is a file the npm package rewrites (a bin
 * symlink such as ~/.local/node/bin/apple-tools-indexer, or a package script),
 * every `npm install -g` posts another "App Background Activity ... can run in
 * the background" notice. Start through node (or /usr/bin/env node) and pass the
 * package script as an argument: node never changes, so the identity holds.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const args = (xml) => {
  const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)
  return [...(block?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
}

describe('LaunchAgent examples start through node, never a package file', () => {
  const plists = fs.readdirSync(path.join(root, 'examples')).filter((f) => f.endsWith('.plist'))

  it('has an indexer LaunchAgent example', () => {
    expect(plists).toContain('com.apple-tools-indexer.plist')
  })

  it('starts the indexer with node and the package bin as an argument', () => {
    const a = args(read('examples/com.apple-tools-indexer.plist'))
    expect(a[0]).toMatch(/(^|\/)node$/)
    expect(a[1]).toMatch(/bin\/apple-tools-indexer\.js$/)
  })

  it('never uses a package file as the first program', () => {
    for (const f of plists) {
      const first = args(read(`examples/${f}`))[0]
      expect(first, f).toMatch(/(^\/usr\/bin\/env$|(^|\/)node$)/)
    }
  })

  it('README plist example starts through node as well', () => {
    const xml = read('README.md').match(/<plist version="1.0">[\s\S]*?<\/plist>/)[0]
    expect(args(xml)[0]).toMatch(/node$/)
  })
})
