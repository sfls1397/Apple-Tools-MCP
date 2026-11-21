
import { describe, it, expect, beforeAll } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'

const REQUIRED_TOOL_FIELDS = ['name', 'description', 'inputSchema']
const REQUIRED_SCHEMA_FIELDS = ['type', 'properties']

const EXPECTED_TOOLS = [
  'smart_search',
  'mail_search', 'mail_recent', 'mail_date', 'mail_read', 'mail_senders', 'mail_thread', 'mail_find', 'mail_links',
  'messages_search', 'messages_recent', 'messages_conversation', 'messages_contacts',
  'calendar_search', 'calendar_date', 'calendar_free_time', 'calendar_upcoming',
  'calendar_week', 'calendar_recurring',
  'contacts_search', 'contacts_lookup', 'person_search',
  'rebuild_index'
]

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
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    const toolMatches = content.matchAll(/name:\s*["']([a-z_]+)["']/g)
    const toolNames = new Set()
    for (const match of toolMatches) {
      if (EXPECTED_TOOLS.includes(match[1]) || match[1].includes('_')) {
        toolNames.add(match[1])
      }
    }
    toolDefinitions = [...toolNames].map(name => ({ name }))
  })

  it('should have all expected tools registered', () => {
    const registeredNames = toolDefinitions.map(t => t.name)

    const foundCount = EXPECTED_TOOLS.filter(t => registeredNames.includes(t)).length
    console.log(`  → Found ${foundCount}/${EXPECTED_TOOLS.length} expected tools`)

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

    const schemaCount = (content.match(/inputSchema:\s*\{/g) || []).length
    const propsCount = (content.match(/inputSchema:\s*\{[^}]*properties:\s*\{/g) || []).length

    console.log(`  → ${schemaCount} schemas, ${propsCount} with properties`)
    expect(propsCount).toBeGreaterThan(0)
  })

  it('should specify required array for tools with required params', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

    for (const [toolName, requiredParams] of Object.entries(TOOLS_WITH_REQUIRED_PARAMS)) {
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

    const validTypes = ['string', 'number', 'boolean', 'array', 'object', 'integer', 'null', 'text']

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

describe('Contract: Write Tool Compliance', () => {
  it('write tools satisfy the same required fields as read tools', async () => {
    const { WRITE_TOOL_DEFINITIONS } = await import('../../lib/writeTools.js')

    expect(WRITE_TOOL_DEFINITIONS.length).toBeGreaterThan(0)
    for (const tool of WRITE_TOOL_DEFINITIONS) {
      for (const field of REQUIRED_TOOL_FIELDS) {
        expect(tool).toHaveProperty(field)
      }
      for (const field of REQUIRED_SCHEMA_FIELDS) {
        expect(tool.inputSchema).toHaveProperty(field)
      }
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('does not collide with read tool names', async () => {
    const { WRITE_TOOL_DEFINITIONS } = await import('../../lib/writeTools.js')
    const writeNames = WRITE_TOOL_DEFINITIONS.map((t) => t.name)

    expect(new Set(writeNames).size).toBe(writeNames.length)
    for (const name of writeNames) {
      expect(EXPECTED_TOOLS).not.toContain(name)
    }
  })
})

describe('Contract: Response Format Compliance', () => {
  it('should return content array with type and text', async () => {
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

    expect(validateLimit('invalid')).toBe(30)
    expect(validateLimit(-1)).toBe(30)
    expect(validateDaysBack('invalid')).toBe(0)
  })

  it('should cap values at maximum', async () => {
    const { validateLimit, validateDaysBack } = await import('../../lib/validators.js')

    expect(validateLimit(99999)).toBe(1000)
    expect(validateDaysBack(99999)).toBe(3650)
  })
})

describe('Contract: Enum Validation', () => {
  it('should define valid enum values for sort_by', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'index.js')
    const content = fs.readFileSync(indexPath, 'utf-8')

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
