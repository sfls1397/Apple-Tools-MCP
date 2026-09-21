import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

const PRODUCT_SOURCES = [
  'index.js',
  'indexer.js',
  'search.js',
  'contacts.js',
  'lib',
  'scripts/postinstall.js',
  'scripts/smoke-writes.js',
  'scripts/audit-index.js'
]

const TOAST_PATTERNS = [
  /display notification/i,
  /UserNotifications/,
  /UNUserNotification/,
  /NSUserNotification/,
  /APPLE_TOOLS_NOTIFY/,
  /maybeNotifyIndexerRunning/,
  /postUserNotification/
]

function walkFiles(rel) {
  const abs = path.join(root, rel)
  const st = fs.statSync(abs)
  if (st.isFile()) return [abs]
  return fs.readdirSync(abs)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(abs, name))
}

describe('no product Notification Center toasts', () => {
  it('ships no display notification / UserNotifications poster', () => {
    const files = PRODUCT_SOURCES.flatMap(walkFiles)
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8')
      for (const pattern of TOAST_PATTERNS) {
        expect(src, `${path.relative(root, file)} matches ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('does not claim to silence OS Background Items or Allow dialogs', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    const permSrc = fs.readFileSync(path.join(root, 'lib/permissions.js'), 'utf8')

    expect(readme).toContain('does **not** post product Notification Center')
    expect(readme).toContain('does **not** silence macOS Background Items')
    expect(readme).toContain('running in the background')
    expect(readme).toContain('does not suppress them')
    expect(readme).toContain('does not suppress OS Allow dialogs')
    expect(readme).not.toContain('APPLE_TOOLS_NOTIFY')
    expect(readme).not.toContain('--notify')
    expect(readme).not.toContain('<string>Background</string>')
    expect(readme).not.toMatch(/quiet by default/)

    expect(permSrc).not.toMatch(/display notification/i)
    expect(permSrc).toContain('Next dialog: click Allow')
  })
})
