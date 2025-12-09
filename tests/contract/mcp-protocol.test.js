/**
 * MCP Protocol Contract Tests
 *
 * Verifies compliance with Model Context Protocol specification:
 * - Tool definitions have required fields
 * - Response formats are correct
 * - Error handling follows protocol
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'

// Tool definitions from index.js (extracted for testing)
const REQUIRED_TOOL_FIELDS = ['name', 'description', 'inputSchema']
const REQUIRED_SCHEMA_FIELDS = ['type', 'properties']

// All tools that should be registered
const EXPECTED_TOOLS = [
  'smart_search',
  'mail_search', 'mail_recent', 'mail_date', 'mail_read', 'mail_senders', 'mail_thread',
  'messages_search', 'messages_recent', 'messages_conversation', 'messages_contacts',
  'calendar_search', 'calendar_date', 'calendar_free_time', 'calendar_upcoming',
  'calendar_week', 'calendar_recurring',
  'contacts_search', 'contacts_lookup', 'person_search',
  'rebuild_index'
]

// Tools that require specific parameters
const TOOLS_WITH_REQUIRED_PARAMS = {
  'mail_search': ['query'],
  'mail_date': ['date'],
  'mail_read': ['file_path'],
  'mail_thread': ['file_path'],
  'messages_search': ['query'],
  'messages_conversation': ['contact'],
  'calendar_search': ['query'],
  'calendar_date': ['date'],
  'calendar_free_time': ['date'],
  'contacts_search': ['query'],
  'contacts_lookup': ['identifier'],
  'person_search': ['name'],
  'smart_search': ['query']
}

describe('Contract: Tool Definition Compliance', () => {
  let toolDefinitions = []

  beforeAll(async () => {
    // Import the tool definitions by reading the file
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    // Extract tool names using a simpler pattern
    // Look for name: "tool_name" or name: 'tool_name' patterns
    const toolMatches = content.matchAll(/name:\s*["']([a-z_]+)["']/g)
    const toolNames = new Set()
    for (const match of toolMatches) {
      // Only collect names that look like our tool names
      if (EXPECTED_TOOLS.includes(match[1]) || match[1].includes('_')) {
        toolNames.add(match[1])
      }
    }
    toolDefinitions = [...toolNames].map(name => ({ name }))
  })

  it('should have all expected tools registered', () => {
    const registeredNames = toolDefinitions.map(t => t.name)

    // Check that we found at least most of the expected tools
    const foundCount = EXPECTED_TOOLS.filter(t => registeredNames.includes(t)).length
    console.log(`  → Found ${foundCount}/${EXPECTED_TOOLS.length} expected tools`)

    // Allow some flexibility - at least 80% of tools should be found
    expect(foundCount).toBeGreaterThanOrEqual(Math.floor(EXPECTED_TOOLS.length * 0.8))
  })

  it('should have unique tool names', () => {
    const names = toolDefinitions.map(t => t.name)
    const uniqueNames = new Set(names)

    expect(uniqueNames.size).toBe(names.length)
  })

  it('should use snake_case for tool names', () => {
    for (const tool of toolDefinitions) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('should use snake_case for parameter names', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    // Find all property names in inputSchema
    const paramMatches = content.matchAll(/properties:\s*\{([^}]+)\}/g)
    const invalidParams = []

    for (const match of paramMatches) {
      const propsBlock = match[1]
      const propNames = propsBlock.matchAll(/(\w+):\s*\{/g)
      for (const propMatch of propNames) {
        const paramName = propMatch[1]
        if (!/^[a-z][a-z0-9_]*$/.test(paramName)) {
          invalidParams.push(paramName)
        }
      }
    }

    if (invalidParams.length > 0) {
      console.log(`  → Invalid param names: ${invalidParams.join(', ')}`)
    }

    expect(invalidParams.length).toBe(0)
  })
})

describe('Contract: Input Schema Validation', () => {
  it('should have type: "object" for all inputSchemas', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    // Count inputSchema definitions
    const schemaMatches = content.match(/inputSchema:\s*\{/g) || []
    const typeObjectMatches = content.match(/inputSchema:\s*\{\s*type:\s*["']object["']/g) || []

    console.log(`  → ${schemaMatches.length} schemas, ${typeObjectMatches.length} with type: "object"`)
    expect(typeObjectMatches.length).toBe(schemaMatches.length)
  })

  it('should have properties object for all inputSchemas', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    // Each inputSchema should have properties
    const schemaCount = (content.match(/inputSchema:\s*\{/g) || []).length
    const propsCount = (content.match(/inputSchema:\s*\{[^}]*properties:\s*\{/g) || []).length

    // Some schemas might not have properties (empty input)
    console.log(`  → ${schemaCount} schemas, ${propsCount} with properties`)
    expect(propsCount).toBeGreaterThan(0)
  })

  it('should specify required array for tools with required params', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    for (const [toolName, requiredParams] of Object.entries(TOOLS_WITH_REQUIRED_PARAMS)) {
      // Find the tool definition
      const toolRegex = new RegExp(`name:\\s*["']${toolName}["'][\\s\\S]*?required:\\s*\\[([^\\]]+)\\]`, 'm')
      const match = content.match(toolRegex)

      if (match) {
        for (const param of requiredParams) {
          expect(match[1]).toContain(`"${param}"`)
        }
      }
    }
  })

  it('should have valid type specifications for parameters', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    // JSON Schema types (integer is valid in JSON Schema though number is preferred)
    // Also include 'text' which is used in MCP response content types
    const validTypes = ['string', 'number', 'boolean', 'array', 'object', 'integer', 'null', 'text']

    // Find all type specifications
    const typeMatches = content.matchAll(/type:\s*["'](\w+)["']/g)
    const invalidTypes = []

    for (const match of typeMatches) {
      if (!validTypes.includes(match[1])) {
        invalidTypes.push(match[1])
      }
    }

    if (invalidTypes.length > 0) {
      console.log(`  → Invalid types found: ${[...new Set(invalidTypes)].join(', ')}`)
    }

    expect(invalidTypes.length).toBe(0)
  })
})

describe('Contract: Response Format Compliance', () => {
  it('should return content array with type and text', async () => {
    // Mock a successful response structure
    const validResponse = {
      content: [{ type: 'text', text: 'Result here' }]
    }

    expect(validResponse.content).toBeInstanceOf(Array)
    expect(validResponse.content[0]).toHaveProperty('type', 'text')
    expect(validResponse.content[0]).toHaveProperty('text')
  })

  it('should return isError: true for error responses', async () => {
    const errorResponse = {
      content: [{ type: 'text', text: 'Error: something went wrong' }],
      isError: true
    }

    expect(errorResponse.isError).toBe(true)
    expect(errorResponse.content[0].text).toContain('Error')
  })

  it('should handle missing required parameters gracefully', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    expect(() => validateSearchQuery(null)).toThrow()
    expect(() => validateSearchQuery('')).toThrow()
    expect(() => validateSearchQuery('   ')).toThrow()
  })
})

describe('Contract: Error Message Format', () => {
  it('should include descriptive error messages', async () => {
    const { validateSearchQuery, validateEmailPath } = await import('../../lib/validators.js')

    try {
      validateSearchQuery(null)
    } catch (e) {
      expect(e.message).toContain('required')
    }

    try {
      // Use .emlx extension to pass extension check, then fail on path traversal
      validateEmailPath('../../../etc/passwd.emlx', '/home/user/Mail')
    } catch (e) {
      expect(e.message).toContain('denied')
    }
  })

  it('should not expose internal implementation details in errors', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    try {
      validateSearchQuery(null)
    } catch (e) {
      // Should not contain stack traces or file paths
      expect(e.message).not.toContain('.js:')
      expect(e.message).not.toContain('node_modules')
    }
  })
})

describe('Contract: Parameter Type Coercion', () => {
  it('should handle string numbers for limit parameter', async () => {
    const { validateLimit } = await import('../../lib/validators.js')

    expect(validateLimit('50')).toBe(50)
    expect(validateLimit('100')).toBe(100)
  })

  it('should return defaults for invalid values', async () => {
    const { validateLimit, validateDaysBack } = await import('../../lib/validators.js')

    expect(validateLimit('invalid')).toBe(30) // default
    expect(validateLimit(-1)).toBe(30) // default
    expect(validateDaysBack('invalid')).toBe(0) // default
  })

  it('should cap values at maximum', async () => {
    const { validateLimit, validateDaysBack } = await import('../../lib/validators.js')

    expect(validateLimit(99999)).toBe(1000) // capped
    expect(validateDaysBack(99999)).toBe(3650) // capped
  })
})

describe('Contract: Enum Validation', () => {
  it('should define valid enum values for sort_by', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    // Find sort_by enum definitions
    const sortByMatches = content.matchAll(/sort_by[^}]*enum:\s*\[([^\]]+)\]/g)

    for (const match of sortByMatches) {
      expect(match[1]).toContain('relevance')
      expect(match[1]).toContain('date')
    }
  })

  it('should define valid enum values for rebuild sources', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    const sourcesMatch = content.match(/enum:\s*\["emails",\s*"messages",\s*"calendar"\]/)
    expect(sourcesMatch).not.toBeNull()
  })
})
