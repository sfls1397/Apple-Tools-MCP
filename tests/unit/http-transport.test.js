import { describe, expect, it, vi } from 'vitest'
import { createHttpRequestHandler } from '../../lib/httpTransport.js'
import { verifyAuthHeader } from '../../lib/httpAuth.js'

const token = 'test-token'

function createResponse() {
  return {
    headersSent: false,
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    end(body) {
      this.body = body
      return this
    },
    on: vi.fn()
  }
}

function createHandler() {
  return createHttpRequestHandler({
    token,
    verifyAuthHeader,
    createServer: vi.fn(),
    StreamableHTTPServerTransport: class {},
    packageVersion: '3.0.0',
    log: vi.fn()
  })
}

describe('HTTP transport request handler', () => {
  it('requires a bearer token for the health endpoint', () => {
    const response = createResponse()
    createHandler()({ url: '/health', headers: {} }, response)

    expect(response.status).toBe(401)
    expect(response.headers['WWW-Authenticate']).toBe('Bearer')
  })

  it('does not use a malformed Host header while routing a valid request target', () => {
    const response = createResponse()
    createHandler()({
      url: '/health',
      headers: { host: '[', authorization: `Bearer ${token}` }
    }, response)

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true, version: '3.0.0' })
  })

  it('rejects a malformed request target without throwing', () => {
    const response = createResponse()
    expect(() => createHandler()({
      url: 'http://[',
      headers: { authorization: `Bearer ${token}` }
    }, response)).not.toThrow()

    expect(response.status).toBe(400)
  })
})
