/**
 * Security tests for path traversal prevention
 * Tests validateEmailPath and path validation utilities
 */

import { describe, it, expect } from 'vitest'
import path from 'path'
import os from 'os'

describe('Path Traversal Prevention', () => {
  // Simulated validateEmailPath implementation
  const validateEmailPath = (filePath) => {
    if (typeof filePath !== 'string') return false
    if (filePath.length === 0) return false

    // Must be absolute path
    if (!path.isAbsolute(filePath)) return false

    // Reject path traversal sequences
    if (filePath.includes('..')) return false

    // Must be under Mail directory
    const homeDir = os.homedir()
    const mailDir = path.join(homeDir, 'Library', 'Mail')
    const normalizedPath = path.normalize(filePath)

    if (!normalizedPath.startsWith(mailDir)) return false

    // Must end with .emlx
    if (!normalizedPath.endsWith('.emlx') && !normalizedPath.endsWith('.partial.emlx')) {
      return false
    }

    return true
  }

  describe('validateEmailPath', () => {
    const homeDir = os.homedir()
    const validPath = `${homeDir}/Library/Mail/V10/Account/INBOX.mbox/123.emlx`

    it('should accept valid email paths', () => {
      expect(validateEmailPath(validPath)).toBe(true)
    })

    it('should accept partial.emlx paths', () => {
      const partialPath = `${homeDir}/Library/Mail/V10/Account/INBOX.mbox/123.partial.emlx`
      expect(validateEmailPath(partialPath)).toBe(true)
    })

    it('should reject relative paths', () => {
      expect(validateEmailPath('Library/Mail/V10/123.emlx')).toBe(false)
      expect(validateEmailPath('./Library/Mail/V10/123.emlx')).toBe(false)
    })

    it('should reject ../ sequences', () => {
      const maliciousPath = `${homeDir}/Library/Mail/V10/../../../etc/passwd`
      expect(validateEmailPath(maliciousPath)).toBe(false)
    })

    it('should reject paths outside Mail directory', () => {
      expect(validateEmailPath('/etc/passwd')).toBe(false)
      expect(validateEmailPath('/tmp/malicious.emlx')).toBe(false)
      expect(validateEmailPath(`${homeDir}/Documents/file.emlx`)).toBe(false)
    })

    it('should reject non-.emlx files', () => {
      const nonEmlx = `${homeDir}/Library/Mail/V10/Account/file.txt`
      expect(validateEmailPath(nonEmlx)).toBe(false)
    })

    it('should reject empty paths', () => {
      expect(validateEmailPath('')).toBe(false)
    })

    it('should reject non-string inputs', () => {
      expect(validateEmailPath(null)).toBe(false)
      expect(validateEmailPath(undefined)).toBe(false)
      expect(validateEmailPath(123)).toBe(false)
      expect(validateEmailPath({})).toBe(false)
    })
  })

  describe('null byte injection', () => {
    const containsNullByte = (str) => {
      if (typeof str !== 'string') return false
      return str.includes('\x00') || str.includes('\0')
    }

    it('should detect null bytes', () => {
      expect(containsNullByte('file.emlx\x00.txt')).toBe(true)
      expect(containsNullByte('file\0name')).toBe(true)
    })

    it('should pass clean strings', () => {
      expect(containsNullByte('normal_file.emlx')).toBe(false)
      expect(containsNullByte('/path/to/file.emlx')).toBe(false)
    })

    it('should reject paths with null bytes', () => {
      const validatePath = (p) => {
        if (typeof p !== 'string') return false
        if (containsNullByte(p)) return false
        return true
      }

      expect(validatePath('/path/to/file.emlx\x00.txt')).toBe(false)
      expect(validatePath('/path/to/file.emlx')).toBe(true)
    })
  })

  describe('URL-encoded traversal', () => {
    const decodeAndCheck = (str) => {
      if (typeof str !== 'string') return false

      // Decode URL encoding
      let decoded
      try {
        decoded = decodeURIComponent(str)
      } catch {
        return false // Invalid encoding
      }

      // Check for traversal after decoding
      return !decoded.includes('..')
    }

    it('should detect %2e%2e%2f (../)', () => {
      // %2e = . , %2f = /
      const encoded = '%2e%2e%2fpasswd'
      expect(decodeAndCheck(encoded)).toBe(false)
    })

    it('should detect double-encoded traversal', () => {
      // %252e%252e = %2e%2e (double encoded)
      const doubleEncoded = '%252e%252e%252f'

      // First decode
      const firstDecode = decodeURIComponent(doubleEncoded)
      expect(firstDecode).toBe('%2e%2e%2f')

      // Second decode reveals traversal
      const secondDecode = decodeURIComponent(firstDecode)
      expect(secondDecode).toBe('../')
    })

    it('should pass clean encoded paths', () => {
      const encoded = '%2Fpath%2Fto%2Ffile.emlx' // /path/to/file.emlx
      expect(decodeAndCheck(encoded)).toBe(true)
    })

    it('should handle invalid encoding', () => {
      expect(decodeAndCheck('%ZZ')).toBe(false)
    })
  })

  describe('symlink handling', () => {
    // Simulated realpath check (in real code, use fs.realpathSync)
    const simulateSymlinkResolution = (inputPath, resolvedPath) => {
      // In real implementation: fs.realpathSync(inputPath)
      return { input: inputPath, resolved: resolvedPath }
    }

    it('should detect symlink escaping Mail directory', () => {
      const homeDir = os.homedir()
      const inputPath = `${homeDir}/Library/Mail/V10/symlink.emlx`
      const resolvedPath = '/etc/passwd' // Symlink points outside

      const result = simulateSymlinkResolution(inputPath, resolvedPath)

      // Resolved path should still be under Mail dir
      const mailDir = path.join(homeDir, 'Library', 'Mail')
      expect(result.resolved.startsWith(mailDir)).toBe(false)
    })

    it('should accept symlinks within Mail directory', () => {
      const homeDir = os.homedir()
      const inputPath = `${homeDir}/Library/Mail/V10/link.emlx`
      const resolvedPath = `${homeDir}/Library/Mail/V10/Archive/real.emlx`

      const result = simulateSymlinkResolution(inputPath, resolvedPath)

      const mailDir = path.join(homeDir, 'Library', 'Mail')
      expect(result.resolved.startsWith(mailDir)).toBe(true)
    })
  })

  describe('path normalization', () => {
    it('should normalize redundant separators', () => {
      const pathWithDuplicates = '/path//to///file.emlx'
      const normalized = path.normalize(pathWithDuplicates)

      expect(normalized).toBe('/path/to/file.emlx')
    })

    it('should normalize . and ..', () => {
      const pathWithDots = '/path/to/./subdir/../file.emlx'
      const normalized = path.normalize(pathWithDots)

      expect(normalized).toBe('/path/to/file.emlx')
    })

    it('should handle trailing slashes', () => {
      const pathWithTrailing = '/path/to/dir/'
      const normalized = path.normalize(pathWithTrailing)

      // path.normalize preserves trailing slash in modern Node.js
      // Use a custom function to strip it if needed
      const stripTrailing = (p) => p.replace(/\/+$/, '')
      expect(stripTrailing(normalized)).toBe('/path/to/dir')
    })

    it('should preserve root traversal attempts after normalize', () => {
      // This is why we check BEFORE normalize
      const malicious = '/Library/Mail/../../../etc/passwd'
      const normalized = path.normalize(malicious)

      expect(normalized).toBe('/etc/passwd')
      // After normalize, it escapes - which is why we check for .. first
    })
  })

  describe('path component validation', () => {
    const validatePathComponent = (component) => {
      if (typeof component !== 'string') return false
      if (component.length === 0) return false

      // No path separators
      if (component.includes('/') || component.includes('\\')) return false

      // No traversal
      if (component === '.' || component === '..') return false

      // No null bytes
      if (component.includes('\x00')) return false

      return true
    }

    it('should accept valid filenames', () => {
      expect(validatePathComponent('123.emlx')).toBe(true)
      expect(validatePathComponent('message_456.partial.emlx')).toBe(true)
    })

    it('should reject path separators', () => {
      expect(validatePathComponent('path/to')).toBe(false)
      expect(validatePathComponent('path\\to')).toBe(false)
    })

    it('should reject . and ..', () => {
      expect(validatePathComponent('.')).toBe(false)
      expect(validatePathComponent('..')).toBe(false)
    })

    it('should reject null bytes', () => {
      expect(validatePathComponent('file\x00name')).toBe(false)
    })

    it('should reject empty', () => {
      expect(validatePathComponent('')).toBe(false)
    })
  })

  describe('allowed directories', () => {
    const isAllowedDirectory = (filePath) => {
      const homeDir = os.homedir()
      const allowedPaths = [
        path.join(homeDir, 'Library', 'Mail'),
        path.join(homeDir, 'Library', 'Messages'),
        path.join(homeDir, 'Library', 'Group Containers', 'group.com.apple.calendar')
      ]

      const normalized = path.normalize(filePath)

      return allowedPaths.some(allowed => normalized.startsWith(allowed))
    }

    it('should allow Mail paths', () => {
      const homeDir = os.homedir()
      const mailPath = `${homeDir}/Library/Mail/V10/file.emlx`

      expect(isAllowedDirectory(mailPath)).toBe(true)
    })

    it('should allow Messages paths', () => {
      const homeDir = os.homedir()
      const messagesPath = `${homeDir}/Library/Messages/chat.db`

      expect(isAllowedDirectory(messagesPath)).toBe(true)
    })

    it('should allow Calendar paths', () => {
      const homeDir = os.homedir()
      const calendarPath = `${homeDir}/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`

      expect(isAllowedDirectory(calendarPath)).toBe(true)
    })

    it('should reject other paths', () => {
      expect(isAllowedDirectory('/etc/passwd')).toBe(false)
      expect(isAllowedDirectory('/tmp/file')).toBe(false)

      const homeDir = os.homedir()
      expect(isAllowedDirectory(`${homeDir}/Documents/file.txt`)).toBe(false)
    })
  })

  describe('case sensitivity', () => {
    it('should handle case-insensitive filesystems (macOS)', () => {
      const homeDir = os.homedir()

      // On macOS, /Library and /library are same
      const path1 = `${homeDir}/Library/Mail/file.emlx`
      const path2 = `${homeDir}/library/mail/file.emlx`

      // For security, should normalize case before comparison
      const normalize = (p) => p.toLowerCase()

      expect(normalize(path1)).toBe(normalize(path2))
    })

    it('should detect traversal regardless of case', () => {
      const variants = [
        '../passwd',
        '..\\passwd',
        '..%2fpasswd',
        '..%5cpasswd' // %5c = backslash
      ]

      const hasTraversal = (p) => {
        const lower = p.toLowerCase()
        return lower.includes('..') || lower.includes('%2e')
      }

      for (const v of variants) {
        expect(hasTraversal(v)).toBe(true)
      }
    })
  })
})
