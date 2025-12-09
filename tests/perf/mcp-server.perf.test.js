/**
 * Performance tests for MCP server operations
 * Tests: server startup, request handling, protocol overhead
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  LatencyHistogram,
  getMemoryUsage
} from './helpers/benchmark.js'
import { createPerformanceMocks, createMCPTransportMock } from './helpers/mocks.js'
import { generateSearchQueries } from './helpers/data-generators.js'

describe('MCP Server Performance', () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('MCP Server Performance')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Server Initialization', () => {
    it('should initialize server quickly', async () => {
      const result = await benchmark(
        async () => {
          // Simulate server initialization
          const config = {
            name: 'apple-tools-mcp',
            version: '1.0.0'
          }

          // Setup handlers
          const handlers = new Map()
          handlers.set('tools/list', async () => ({ tools: [] }))
          handlers.set('tools/call', async () => ({ result: {} }))

          return { config, handlers }
        },
        { name: 'Server initialization', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })

    it('should register tools quickly', async () => {
      const toolDefinitions = [
        { name: 'mail_search', description: 'Search emails' },
        { name: 'mail_recent', description: 'Get recent emails' },
        { name: 'mail_read', description: 'Read email content' },
        { name: 'mail_senders', description: 'List frequent senders' },
        { name: 'mail_thread', description: 'Get email thread' },
        { name: 'mail_date', description: 'Get emails by date' },
        { name: 'messages_search', description: 'Search messages' },
        { name: 'messages_recent', description: 'Get recent messages' },
        { name: 'messages_conversation', description: 'Get conversation' },
        { name: 'messages_contacts', description: 'List contacts' },
        { name: 'calendar_search', description: 'Search calendar' },
        { name: 'calendar_date', description: 'Get events by date' },
        { name: 'calendar_upcoming', description: 'Get upcoming events' },
        { name: 'calendar_week', description: 'Get week view' },
        { name: 'calendar_free_time', description: 'Find free time' },
        { name: 'calendar_recurring', description: 'Get recurring events' },
        { name: 'contacts_search', description: 'Search contacts' },
        { name: 'contacts_lookup', description: 'Lookup contact' },
        { name: 'person_search', description: 'Search person' },
        { name: 'smart_search', description: 'Smart search' },
        { name: 'rebuild_index', description: 'Rebuild index' }
      ]

      const result = await benchmark(
        async () => {
          const tools = new Map()
          for (const def of toolDefinitions) {
            tools.set(def.name, {
              ...def,
              inputSchema: { type: 'object', properties: {} }
            })
          }
          return tools
        },
        { name: 'Register 21 tools', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })
  })

  describe('Request/Response Cycle', () => {
    it('should handle list_tools request quickly', async () => {
      const tools = Array(21).fill(null).map((_, i) => ({
        name: `tool_${i}`,
        description: `Tool ${i}`,
        inputSchema: { type: 'object' }
      }))

      const result = await benchmark(
        async () => {
          // Simulate list_tools request
          const request = { method: 'tools/list', params: {} }

          // Process and respond
          const response = {
            tools: tools.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema
            }))
          }

          return JSON.stringify(response)
        },
        { name: 'list_tools request', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })

    it('should handle call_tool request efficiently', async () => {
      const result = await benchmark(
        async () => {
          // Simulate call_tool request
          const request = {
            method: 'tools/call',
            params: {
              name: 'mail_search',
              arguments: { query: 'test query', limit: 20 }
            }
          }

          // Parse request
          const { name, arguments: args } = request.params

          // Execute tool (mocked)
          await mocks.embedder.embedder([args.query])

          // Format response
          const response = {
            content: [{
              type: 'text',
              text: 'Found 10 emails matching your query'
            }]
          }

          return JSON.stringify(response)
        },
        { name: 'call_tool request', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })

    it('should parse JSON requests quickly', async () => {
      const requestStrings = [
        '{"method":"tools/list","params":{}}',
        '{"method":"tools/call","params":{"name":"mail_search","arguments":{"query":"test","limit":20}}}',
        '{"method":"tools/call","params":{"name":"calendar_upcoming","arguments":{"count":10}}}',
        '{"method":"tools/call","params":{"name":"messages_recent","arguments":{"limit":50}}}'
      ]

      const result = await benchmark(
        async () => {
          for (const str of requestStrings) {
            JSON.parse(str)
          }
        },
        { name: 'Parse 4 JSON requests', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should serialize JSON responses quickly', async () => {
      const responses = [
        { tools: Array(21).fill({ name: 'tool', description: 'desc' }) },
        { content: [{ type: 'text', text: 'Result'.repeat(100) }] },
        { content: [{ type: 'text', text: JSON.stringify(Array(50).fill({ email: 'test@example.com', subject: 'Test' })) }] }
      ]

      const result = await benchmark(
        async () => {
          for (const response of responses) {
            JSON.stringify(response)
          }
        },
        { name: 'Serialize 3 JSON responses', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })
  })

  describe('Protocol Overhead', () => {
    it('should have minimal protocol overhead', async () => {
      const transport = createMCPTransportMock()

      const result = await benchmark(
        async () => {
          // Simulate request/response cycle
          const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
          const response = { jsonrpc: '2.0', id: 1, result: { tools: [] } }

          // Encode/decode
          const requestStr = JSON.stringify(request)
          const parsed = JSON.parse(requestStr)
          const responseStr = JSON.stringify(response)

          transport.send(responseStr)
        },
        { name: 'Protocol overhead', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle message framing efficiently', async () => {
      const messages = [
        'Content-Length: 50\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        'Content-Length: 100\r\n\r\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mail_search","arguments":{}}}',
      ]

      const result = await benchmark(
        async () => {
          for (const msg of messages) {
            // Parse header
            const headerEnd = msg.indexOf('\r\n\r\n')
            const header = msg.substring(0, headerEnd)
            const contentLength = parseInt(header.split(': ')[1])

            // Extract body
            const body = msg.substring(headerEnd + 4)
            JSON.parse(body)
          }
        },
        { name: 'Message framing', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })
  })

  describe('Concurrent Requests', () => {
    it('should handle 10 concurrent requests', async () => {
      const result = await benchmark(
        async () => {
          const requests = Array(10).fill(null).map((_, i) => ({
            id: i,
            method: 'tools/call',
            params: { name: 'mail_search', arguments: { query: `query${i}` } }
          }))

          await Promise.all(requests.map(async (req) => {
            await mocks.embedder.embedder([req.params.arguments.query])
            return { id: req.id, result: { content: [] } }
          }))
        },
        { name: '10 concurrent requests', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(200)
    })

    it('should maintain latency under sustained load', async () => {
      const histogram = new LatencyHistogram(10)
      const requests = 100

      for (let i = 0; i < requests; i++) {
        const start = performance.now()
        await mocks.embedder.embedder([`query${i}`])
        histogram.record(performance.now() - start)
      }

      console.log('\nRequest Latency under Load:')
      histogram.printHistogram()

      expect(histogram.getMean()).toBeLessThan(50)
    })
  })

  describe('Error Handling', () => {
    it('should handle errors without performance degradation', async () => {
      const erroringFn = async (shouldError) => {
        if (shouldError) {
          throw new Error('Test error')
        }
        return { result: 'success' }
      }

      const result = await benchmark(
        async () => {
          for (let i = 0; i < 20; i++) {
            try {
              await erroringFn(i % 5 === 0) // 20% error rate
            } catch (e) {
              // Handle error
              const errorResponse = {
                error: { code: -1, message: e.message }
              }
            }
          }
        },
        { name: 'Error handling (20% error rate)', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })
  })

  describe('Memory Efficiency', () => {
    it('should not leak memory during request handling', async () => {
      const memBefore = getMemoryUsage()

      // Simulate many requests
      for (let i = 0; i < 1000; i++) {
        await mocks.embedder.embedder([`query${i}`])
      }

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory before: ${memBefore.heapUsed}MB`)
      console.log(`Memory after: ${memAfter.heapUsed}MB`)
      console.log(`Growth: ${growth.toFixed(2)}MB`)

      // Allow some growth but not excessive
      expect(growth).toBeLessThan(50) // Less than 50MB growth
    })
  })

  describe('Startup Performance', () => {
    it('should complete cold start quickly', async () => {
      const result = await benchmark(
        async () => {
          // Simulate cold start
          const config = { name: 'apple-tools-mcp', version: '1.0.0' }
          const tools = new Map()

          // Register tools
          for (let i = 0; i < 21; i++) {
            tools.set(`tool_${i}`, { name: `tool_${i}` })
          }

          // Initialize transport
          const transport = createMCPTransportMock()

          // Ready to serve
          return { config, tools, transport }
        },
        { name: 'Cold start', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
