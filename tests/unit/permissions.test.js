import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { isPermissionsMode, isIndexerMode } from '../../lib/processMode.js'
import {
  REQUIRED_SURFACES,
  EXAMPLE_MINI_NODE,
  EXAMPLE_MACBOOK_NVM_NODE,
  classifyGrantStatus,
  formatGrantReport,
  exitCodeForGrants,
  describeProbeBinary,
  probeFullDiskAccess,
  runPermissionsCommand
} from '../../lib/permissions.js'
import { postinstallReminderText } from '../../scripts/postinstall.js'
import { buildMailAutomationProbeScript } from '../../lib/mailWrite.js'
import { buildMessagesAutomationProbeScript } from '../../lib/messagesWrite.js'
import { buildContactsAutomationProbeScript } from '../../lib/contactsWrite.js'
import { buildCalendarAutomationProbeScript } from '../../lib/calendarWrite.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('permissions command wiring', () => {
  it('is a package-bin subcommand, not an unattended postinstall probe', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
    const permSrc = fs.readFileSync(path.join(root, 'lib/permissions.js'), 'utf8')
    const postSrc = fs.readFileSync(path.join(root, 'scripts/postinstall.js'), 'utf8')

    expect(pkg.bin['apple-tools-mcp']).toBe('./index.js')
    expect(pkg.scripts.permissions).toBe('node index.js permissions')
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall.js')
    expect(pkg.files).toContain('scripts/postinstall.js')

    expect(indexSrc).toContain('isPermissionsMode')
    expect(indexSrc).toContain('runPermissionsCommand')
    expect(indexSrc).toContain('PERMISSIONS_MODE')
    expect(indexSrc).toContain('version: PACKAGE_VERSION')
    expect(indexSrc).toContain('!PERMISSIONS_MODE && shouldConnectMcpStdio')
    expect(indexSrc).toContain('const wasRunning = Boolean(indexTimer || progressCheckTimer)')
    expect(indexSrc).toMatch(/if \(PERMISSIONS_MODE\) \{[\s\S]*runPermissionsCommand/)
    expect(indexSrc).toMatch(/if \(PERMISSIONS_MODE\) \{[\s\S]*initializeIndexing/)
    expect(permSrc).toContain('Apple Tools MCP permissions (v${version})')

    expect(permSrc).not.toContain('dispatchWriteTool')
    expect(permSrc).not.toContain('writeBridge')
    expect(permSrc).toContain('process.execPath')
    expect(permSrc).toContain('probeMailAutomation')
    expect(permSrc).toContain('probeMessagesAutomation')
    expect(permSrc).toContain('probeContactsAutomation')
    expect(permSrc).toContain('probeCalendarAutomation')

    expect(postSrc).toContain('does not run the probes')
    expect(postSrc).not.toContain('runPermissionsCommand')
    expect(postSrc).not.toContain('probeMailAutomation')
  })

  it('detects npx / global bin argv the way a user will type it', () => {
    expect(isPermissionsMode(['node', '/opt/homebrew/bin/apple-tools-mcp', 'permissions'])).toBe(true)
    expect(isIndexerMode(['node', '/opt/homebrew/bin/apple-tools-mcp', 'permissions'])).toBe(false)
    expect(isPermissionsMode(['node', '/opt/homebrew/bin/apple-tools-mcp'])).toBe(false)
  })
})

describe('probe scripts are live Apple Events, not dry_run', () => {
  it('Mail compose-and-discard never sends', () => {
    const script = buildMailAutomationProbeScript()
    expect(script).toContain('make new outgoing message')
    expect(script).toContain('delete probe')
    expect(script).not.toContain('send ')
    expect(script).not.toContain('dry_run')
  })

  it('Messages enumerates accounts and never sends', () => {
    const script = buildMessagesAutomationProbeScript()
    expect(script).toContain('tell application "Messages"')
    expect(script).toContain('service type of acc')
    expect(script).not.toContain('send ')
    expect(script).not.toContain('dry_run')
  })

  it('Contacts create-and-delete leaves no junk when the script completes', () => {
    const script = buildContactsAutomationProbeScript()
    expect(script).toContain('make new person')
    expect(script).toContain('delete probe')
    expect(script).toContain('save')
    expect(script).not.toContain('dry_run')
  })

  it('Calendar lists only and creates no events', () => {
    const script = buildCalendarAutomationProbeScript()
    expect(script).toContain('tell application "Calendar"')
    expect(script).toContain('get name of every calendar')
    expect(script).not.toContain('make new event')
    expect(script).not.toContain('dry_run')
  })
})

describe('grant classification and fail-closed exit', () => {
  it('prints the four required surfaces as granted | missing | error', () => {
    expect(REQUIRED_SURFACES).toEqual(['Contacts', 'Calendar', 'Mail', 'Messages'])
    expect(formatGrantReport({
      Contacts: 'granted',
      Calendar: 'missing',
      Mail: 'error',
      Messages: 'granted'
    })).toEqual([
      'Contacts = granted',
      'Calendar = missing',
      'Mail = error',
      'Messages = granted'
    ])
  })

  it('treats success as granted and TCC/timeout as missing', () => {
    expect(classifyGrantStatus({ ok: true, message: 'ok' })).toBe('granted')
    expect(classifyGrantStatus({ ok: false, kind: 'tcc', message: 'denied' })).toBe('missing')
    expect(classifyGrantStatus({ ok: false, kind: 'timeout', message: 'ETIMEDOUT' })).toBe('missing')
    expect(classifyGrantStatus({ ok: false, kind: 'attribution', message: 'refused' })).toBe('missing')
    expect(classifyGrantStatus({
      ok: false,
      message: 'mail_automation_probe failed — TCC / Automation deny for node → Mail'
    })).toBe('missing')
    expect(classifyGrantStatus({
      ok: false,
      kind: 'attribution',
      message: 'The app is installed, so this is an Automation / responsible-process problem rather than a missing app'
    })).toBe('missing')
    expect(classifyGrantStatus({
      ok: false,
      message: 'The app is installed, so this is an Automation / responsible-process problem rather than a missing app'
    })).toBe('missing')
    expect(classifyGrantStatus({ ok: false, kind: 'unknown', message: 'disk full' })).toBe('error')
  })

  it('exits non-zero unless every required grant is present', () => {
    expect(exitCodeForGrants({
      Contacts: 'granted', Calendar: 'granted', Mail: 'granted', Messages: 'granted'
    })).toBe(0)
    expect(exitCodeForGrants({
      Contacts: 'granted', Calendar: 'granted', Mail: 'granted', Messages: 'missing'
    })).toBe(1)
    expect(exitCodeForGrants({
      Contacts: 'granted', Calendar: 'error', Mail: 'granted', Messages: 'granted'
    })).toBe(1)
    expect(exitCodeForGrants({})).toBe(1)
  })
})

describe('probe binary and Full Disk Access advisory', () => {
  it('names process.execPath and the Mini / MacBook examples', () => {
    const described = describeProbeBinary('/tmp/product-node')
    expect(described.execPath).toBe('/tmp/product-node')
    expect(described.miniExample).toBe(EXAMPLE_MINI_NODE)
    expect(described.macbookExample).toBe(EXAMPLE_MACBOOK_NVM_NODE)
    expect(EXAMPLE_MINI_NODE).toBe('/Users/petercoates/.local/node/bin/node')
    expect(EXAMPLE_MACBOOK_NVM_NODE).toBe('/Users/petercoates/.nvm/versions/node/v22.21.1/bin/node')
  })

  it('reports FDA as advisory and never as a required grant', () => {
    expect(probeFullDiskAccess({ home: '' }).status).toBe('skipped')
    expect(probeFullDiskAccess({
      home: '/no/such/home',
      accessFn: () => { const err = new Error('missing'); err.code = 'ENOENT'; throw err }
    }).status).toBe('skipped')

    const denied = probeFullDiskAccess({
      home: '/Users/example',
      accessFn: () => { const err = new Error('denied'); err.code = 'EPERM'; throw err }
    })
    expect(denied.status).toBe('missing')
    expect(denied.message).toContain('Full Disk Access')

    const ok = probeFullDiskAccess({
      home: '/Users/example',
      accessFn: () => undefined
    })
    expect(ok.status).toBe('readable')
  })
})

describe('runPermissionsCommand', () => {
  it('prints next-dialog UX, the probed binary, and a fail-closed report', async () => {
    const lines = []
    const code = await runPermissionsCommand({
      execPath: '/Users/petercoates/.local/node/bin/node',
      version: '2.0.2',
      stdout: (line) => lines.push(line),
      probes: {
        Contacts: () => ({ ok: true, message: 'Contacts ok' }),
        Calendar: () => ({ ok: true, message: 'Calendar ok' }),
        Mail: () => ({ ok: true, message: 'Mail ok' }),
        Messages: () => ({ ok: false, kind: 'tcc', message: 'Messages Automation denied' })
      },
      fdaProbe: () => ({ status: 'readable', message: 'FDA ok' })
    })

    const text = lines.join('\n')
    expect(code).toBe(1)
    expect(text).toContain('Apple Tools MCP permissions (v2.0.2)')
    expect(text).toContain('Probing node binary: /Users/petercoates/.local/node/bin/node')
    expect(text).toContain(EXAMPLE_MINI_NODE)
    expect(text).toContain(EXAMPLE_MACBOOK_NVM_NODE)
    expect(text).toContain('not Homebrew')
    expect(text).toContain('click Allow for THIS node')
    expect(text).toContain('Do not add node via +')
    expect(text).toContain('dry_run of mail_send / messages_send does not count')
    expect(text).toContain('Next dialog: click Allow for node → Contacts')
    expect(text).toContain('Next dialog: click Allow for node → Messages')
    expect(text).toContain('[granted] Contacts:')
    expect(text).toContain('[missing] Messages:')
    expect(text).toContain('Grant report')
    expect(text).toContain('Contacts = granted')
    expect(text).toContain('Messages = missing')
    expect(text).toContain('INCOMPLETE')
    expect(text).toContain('fail closed')
    expect(text).toContain('[readable] FDA ok')
  })

  it('is idempotent when every surface is already granted', async () => {
    const lines = []
    const granted = () => ({ ok: true, message: 'already allowed' })
    const code = await runPermissionsCommand({
      execPath: '/Users/petercoates/.nvm/versions/node/v22.21.1/bin/node',
      version: '2.0.2',
      stdout: (line) => lines.push(line),
      probes: { Contacts: granted, Calendar: granted, Mail: granted, Messages: granted },
      fdaProbe: () => ({ status: 'skipped', message: 'no FDA paths' })
    })
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('Result: PASS')
    expect(lines.join('\n')).toContain('without another click')
  })
})

describe('postinstall reminder', () => {
  it('only prints a reminder and never claims a silent grant', () => {
    const text = postinstallReminderText()
    expect(text).toContain('apple-tools-mcp permissions')
    expect(text).toContain('npx apple-tools-mcp permissions')
    expect(text).toContain('does not grant anything')
    expect(text).toContain('does not run the probes')
    expect(text).not.toMatch(/Grok/i)
  })
})
