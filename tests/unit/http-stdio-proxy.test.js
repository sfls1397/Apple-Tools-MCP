import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createHttpRequestHandler } from '../../lib/httpTransport.js'
import { verifyAuthHeader } from '../../lib/httpAuth.js'

const proxyPath = fileURLToPath(new URL('../../bin/apple-tools-http-proxy.js', import.meta.url))
const token = 'proxy-test-token'

function createUpstreamServer() {
  const server = new Server(
    { name: 'proxy-test-upstream', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
    content: [{ type: 'text', text: `${params.name}:${params.arguments?.text}` }],
  }))
  return server
}

describe('HTTP to stdio proxy', () => {
  let httpServer
  let client

  afterEach(async () => {
    await client?.close()
    await new Promise((resolve) => httpServer?.close(resolve) ?? resolve())
  })

  it('forwards tool discovery and calls through the authenticated HTTP endpoint', async () => {
    httpServer = http.createServer(createHttpRequestHandler({
      token,
      verifyAuthHeader,
      createServer: createUpstreamServer,
      StreamableHTTPServerTransport,
      packageVersion: '1.0.0',
    }))
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${httpServer.address().port}/mcp`

    client = new Client({ name: 'proxy-test-client', version: '1.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [proxyPath, url],
      env: { ...process.env, APPLE_TOOLS_MCP_TOKEN: token },
    }))

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo'])
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } })
    expect(result.content).toEqual([{ type: 'text', text: 'echo:hello' }])
  })
})
