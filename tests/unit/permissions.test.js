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
  detectExecPathMismatch,
  formatExecPathMismatchWarn,
  probeFullDiskAccess,
  runPermissionsCommand
} from '../../lib/permissions.js'
import { postinstallReminderText } from '../../scripts/postinstall.js'
import { SYSTEM_EVENTS_STICKY_DENY_GUIDANCE } from '../../lib/appleScript.js'
import {
  buildMailAutomationProbeScript,
  buildSystemEventsProbeScript,
  buildSystemEventsAutomationProbeScript,
  isSystemEventsAutomationProbeScript
} from '../../lib/mailWrite.js'
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

    expect(pkg.bin['apple-tools-mcp']).toBe('bin/apple-tools-mcp.js')
    expect(pkg.scripts.permissions).toBe('node index.js permissions')
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall.js')
    expect(pkg.files).toContain('scripts/postinstall.js')

    expect(indexSrc).toContain('isPermissionsMode')
    expect(indexSrc).toContain('runPermissionsCommand')
    expect(indexSrc).toContain('argv: process.argv')
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
    expect(permSrc).toContain('probeSystemEventsAutomation')

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

  it('System Events uses process / GUI scripting, not a soft application name get', () => {
    const cheap = buildSystemEventsProbeScript()
    expect(cheap).toContain('set atmName to name')

    const script = buildSystemEventsAutomationProbeScript()
    expect(isSystemEventsAutomationProbeScript(script)).toBe(true)
    expect(script).toContain('tell application "System Events"')
    expect(script).toContain('tell process "System Events"')
    expect(script).toContain('unix id')
    expect(script).toContain('count of UI elements')
    expect(script).toContain('UI elements enabled')
    expect(script).not.toContain('set atmName to name')
    expect(script).not.toContain('keystroke')
    expect(script).not.toContain('key code')
    expect(script).not.toContain('dry_run')
  })
})

describe('grant classification and fail-closed exit', () => {
  it('prints the required surfaces as granted | missing | error', () => {
    expect(REQUIRED_SURFACES).toEqual(['Contacts', 'Calendar', 'Mail', 'Messages', 'System Events'])
    expect(formatGrantReport({
      Contacts: 'granted',
      Calendar: 'missing',
      Mail: 'error',
      Messages: 'granted',
      'System Events': 'granted'
    })).toEqual([
      'Contacts = granted',
      'Calendar = missing',
      'Mail = error',
      'Messages = granted',
      'System Events = granted'
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
    expect(classifyGrantStatus({
      ok: false,
      message: 'system_events_automation_probe failed — ACCESSIBILITY_DENIED'
    })).toBe('missing')
    expect(classifyGrantStatus({
      ok: false,
      message: 'GUI_SCRIPTING_UNAVAILABLE'
    })).toBe('missing')
    expect(classifyGrantStatus({
      ok: false,
      kind: 'tcc',
      message: `system_events_automation_probe failed — ${SYSTEM_EVENTS_STICKY_DENY_GUIDANCE}`
    })).toBe('missing')
    expect(classifyGrantStatus({ ok: false, kind: 'unknown', message: 'disk full' })).toBe('error')
    expect(classifyGrantStatus({ ok: false, kind: 'app_not_running', message: 'Contacts.app was not running' })).toBe('error')
  })

  it('exits non-zero unless every required grant is present', () => {
    expect(exitCodeForGrants({
      Contacts: 'granted', Calendar: 'granted', Mail: 'granted', Messages: 'granted', 'System Events': 'granted'
    })).toBe(0)
    expect(exitCodeForGrants({
      Contacts: 'granted', Calendar: 'granted', Mail: 'granted', Messages: 'granted', 'System Events': 'missing'
    })).toBe(1)
    expect(exitCodeForGrants({
      Contacts: 'granted', Calendar: 'granted', Mail: 'granted', Messages: 'missing'
    })).toBe(1)
    expect(exitCodeForGrants({
      Contacts: 'granted', Calendar: 'error', Mail: 'granted', Messages: 'granted', 'System Events': 'granted'
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
  const granted = () => ({ ok: true, message: 'already allowed' })
  const allGrantedProbes = {
    Contacts: granted,
    Calendar: granted,
    Mail: granted,
    Messages: granted,
    'System Events': granted
  }

  it('prints next-dialog UX, the probed binary, and a fail-closed report', async () => {
    const lines = []
    const execPath = '/Users/petercoates/.local/node/bin/node'
    const code = await runPermissionsCommand({
      execPath,
      argv: [execPath, '/Users/petercoates/.local/node/bin/apple-tools-mcp', 'permissions'],
      existsSync: () => false,
      realpathSync: (p) => p,
      version: '2.0.10',
      stdout: (line) => lines.push(line),
      probes: {
        Contacts: () => ({ ok: true, message: 'Contacts ok' }),
        Calendar: () => ({ ok: true, message: 'Calendar ok' }),
        Mail: () => ({ ok: true, message: 'Mail ok' }),
        Messages: () => ({ ok: false, kind: 'tcc', message: 'Messages Automation denied' }),
        'System Events': () => ({ ok: true, message: 'System Events ok' })
      },
      fdaProbe: () => ({ status: 'readable', message: 'FDA ok' })
    })

    const text = lines.join('\n')
    expect(code).toBe(1)
    expect(text).toContain('Apple Tools MCP permissions (v2.0.10)')
    expect(text).toContain('Probing node binary: /Users/petercoates/.local/node/bin/node')
    expect(text).toContain(EXAMPLE_MINI_NODE)
    expect(text).toContain(EXAMPLE_MACBOOK_NVM_NODE)
    expect(text).toContain('not Homebrew')
    expect(text).toContain('click Allow for THIS node')
    expect(text).toContain('Do not add node via +')
    expect(text).toContain('dry_run of mail_send / messages_send does not count')
    expect(text).toContain('Next dialog: click Allow for node → Contacts')
    expect(text).toContain('Next dialog: click Allow for node → Messages')
    expect(text).toContain('process / GUI scripting')
    expect(text).toContain('A soft tell System Events to get name is not enough')
    expect(text).toContain('Next dialog: click Allow for node → System Events')
    expect(text).toContain('[granted] Contacts:')
    expect(text).toContain('[missing] Messages:')
    expect(text).toContain('[granted] System Events:')
    expect(text).toContain('Grant report')
    expect(text).toContain('Contacts = granted')
    expect(text).toContain('Messages = missing')
    expect(text).toContain('System Events = granted')
    expect(text).toContain('INCOMPLETE')
    expect(text).toContain('fail closed')
    expect(text).toContain('[readable] FDA ok')
    expect(text).not.toContain('WARN: Allow dialogs attach to process.execPath')
    expect(text).toContain('Terminal.app')
    expect(text).toContain('Do not start apple-tools-indexer')
    expect(text).toContain('System Events')
    expect(text).not.toMatch(/LaunchAgent/)
    expect(text).not.toContain('write-bridge')
  })

  it('is idempotent when every surface is already granted', async () => {
    const lines = []
    const execPath = '/Users/petercoates/.nvm/versions/node/v22.21.1/bin/node'
    const code = await runPermissionsCommand({
      execPath,
      argv: [execPath, '/Users/petercoates/.nvm/versions/node/v22.21.1/bin/apple-tools-mcp', 'permissions'],
      existsSync: () => false,
      realpathSync: (p) => p,
      version: '2.0.10',
      stdout: (line) => lines.push(line),
      probes: allGrantedProbes,
      fdaProbe: () => ({ status: 'skipped', message: 'no FDA paths' })
    })
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('Result: PASS')
    expect(lines.join('\n')).toContain('System Events')
    expect(lines.join('\n')).toContain('without another click')
  })

  it('prints a loud WARN when the invoked CLI node differs from execPath', async () => {
    const execPath = '/Users/peter/.nvm/versions/node/v22.22.2/bin/node'
    const cli = '/Users/peter/.nvm/versions/node/v22.21.1/bin/apple-tools-mcp'
    const sibling = '/Users/peter/.nvm/versions/node/v22.21.1/bin/node'
    const lines = []
    await runPermissionsCommand({
      execPath,
      argv: [execPath, cli, 'permissions'],
      existsSync: (p) => p === sibling,
      realpathSync: (p) => p,
      readFileSync: () => '#!/usr/bin/env node\n',
      version: '2.0.10',
      stdout: (line) => lines.push(line),
      probes: allGrantedProbes,
      fdaProbe: () => ({ status: 'skipped', message: 'no FDA paths' })
    })
    const text = lines.join('\n')
    expect(text).toContain('WARN: Allow dialogs attach to process.execPath')
    expect(text).toContain(cli)
    expect(text).toContain(sibling)
    expect(text).toContain(execPath)
    expect(text).toContain('Allows attach HERE')
    expect(text).toContain(`${execPath} ${cli} permissions`)
    expect(text).toContain('$(which node) $(which apple-tools-mcp) permissions')
  })

  it('uses Mini write-bridge copy only when writer.sock is present', async () => {
    const execPath = '/Users/petercoates/.local/node/bin/node'
    const lines = []
    await runPermissionsCommand({
      execPath,
      argv: [execPath, '/Users/petercoates/.local/node/bin/apple-tools-mcp', 'permissions'],
      existsSync: (p) => String(p).endsWith('writer.sock'),
      realpathSync: (p) => p,
      version: '2.0.10',
      stdout: (line) => lines.push(line),
      probes: {
        Contacts: () => ({ ok: false, kind: 'tcc', message: 'Contacts denied' }),
        Calendar: () => ({ ok: true, message: 'Calendar ok' }),
        Mail: () => ({ ok: true, message: 'Mail ok' }),
        Messages: () => ({ ok: true, message: 'Messages ok' }),
        'System Events': () => ({ ok: true, message: 'System Events ok' })
      },
      fdaProbe: () => ({ status: 'skipped', message: 'no FDA paths' })
    })
    const text = lines.join('\n')
    expect(text).toContain('write-bridge / LaunchAgent')
    expect(text).toContain('[missing] Contacts:')
  })

  it('fails closed when System Events Automation is missing', async () => {
    const lines = []
    const execPath = '/Users/petercoates/.nvm/versions/node/v22.21.1/bin/node'
    const code = await runPermissionsCommand({
      execPath,
      argv: [execPath, '/Users/petercoates/.nvm/versions/node/v22.21.1/bin/apple-tools-mcp', 'permissions'],
      existsSync: () => false,
      realpathSync: (p) => p,
      version: '2.1.4',
      stdout: (line) => lines.push(line),
      probes: {
        ...allGrantedProbes,
        'System Events': () => ({ ok: false, kind: 'tcc', message: 'System Events Automation denied' })
      },
      fdaProbe: () => ({ status: 'skipped', message: 'no FDA paths' })
    })
    const text = lines.join('\n')
    expect(code).toBe(1)
    expect(text).toContain('[missing] System Events:')
    expect(text).toContain('System Events = missing')
    expect(text).toContain('INCOMPLETE')
    expect(text).toContain(SYSTEM_EVENTS_STICKY_DENY_GUIDANCE)
    expect(text).toContain('process / GUI scripting')
    expect(text).toContain('A soft tell System Events to get name is not enough')
    expect(text).not.toContain('System Events is asked for its process name')
  })
})

describe('execPath vs invoked CLI mismatch', () => {
  const identity = (p) => p

  it('fires when argv[0] is a different node than execPath', () => {
    const info = detectExecPathMismatch({
      execPath: '/nvm/v22.22.2/bin/node',
      argv: ['/nvm/v22.21.1/bin/node', '/nvm/v22.21.1/bin/apple-tools-mcp', 'permissions'],
      existsSync: () => false,
      realpathSync: identity,
      readFileSync: () => '#!/usr/bin/env node\n'
    })
    expect(info.mismatch).toBe(true)
    expect(info.reasons).toContain('argv0')
    const warn = formatExecPathMismatchWarn(info).join('\n')
    expect(warn).toContain('WARN:')
    expect(warn).toContain('/nvm/v22.22.2/bin/node')
    expect(warn).toContain('/nvm/v22.21.1/bin/node')
  })

  it('fires when the node next to apple-tools-mcp differs from execPath', () => {
    const cli = '/nvm/v22.21.1/bin/apple-tools-mcp'
    const sibling = '/nvm/v22.21.1/bin/node'
    const execPath = '/nvm/v22.22.2/bin/node'
    const info = detectExecPathMismatch({
      execPath,
      argv: [execPath, cli, 'permissions'],
      existsSync: (p) => p === sibling,
      realpathSync: identity,
      readFileSync: () => '#!/usr/bin/env node\n'
    })
    expect(info.mismatch).toBe(true)
    expect(info.reasons).toContain('sibling')
    expect(info.siblingNode).toBe(sibling)
    expect(formatExecPathMismatchWarn(info).join('\n')).toContain(sibling)
  })

  it('fires when the CLI shebang target differs from execPath', () => {
    const cli = '/usr/local/bin/apple-tools-mcp'
    const info = detectExecPathMismatch({
      execPath: '/nvm/v22.22.2/bin/node',
      argv: ['/nvm/v22.22.2/bin/node', cli, 'permissions'],
      existsSync: () => false,
      realpathSync: identity,
      readFileSync: (p) => (p === cli ? '#!/nvm/v22.21.1/bin/node\n' : '')
    })
    expect(info.mismatch).toBe(true)
    expect(info.reasons).toContain('shebang')
    expect(info.shebangTarget).toBe('/nvm/v22.21.1/bin/node')
  })

  it('does not warn when argv[0], sibling node, and execPath resolve equal', () => {
    const execPath = '/nvm/v22.21.1/bin/node'
    const cli = '/nvm/v22.21.1/bin/apple-tools-mcp'
    const info = detectExecPathMismatch({
      execPath,
      argv: [execPath, cli, 'permissions'],
      existsSync: (p) => p === execPath,
      realpathSync: identity,
      readFileSync: () => '#!/usr/bin/env node\n'
    })
    expect(info.mismatch).toBe(false)
    expect(formatExecPathMismatchWarn(info)).toEqual([])
  })
})

describe('postinstall reminder', () => {
  it('only prints a reminder and never claims a silent grant', () => {
    const text = postinstallReminderText()
    expect(text).toContain('apple-tools-mcp permissions')
    expect(text).toContain('npx apple-tools-mcp permissions')
    expect(text).toContain('$(which node) $(which apple-tools-mcp) permissions')
    expect(text).toContain('does not grant anything')
    expect(text).toContain('does not run the probes')
    expect(text).not.toMatch(/Grok/i)
  })
})
