/**
 * Authenticated request handler for the Streamable HTTP transport.
 *
 * Keep this separate from index.js so request parsing and authorization can
 * be exercised without starting the MCP server or touching the Keychain.
 */

/**
 * @param {{
 *   token: string,
 *   verifyAuthHeader: (header: string | string[] | undefined, token: string) => boolean,
 *   createServer: () => { connect: (transport: unknown) => Promise<void>, close: () => Promise<void> },
 *   StreamableHTTPServerTransport: new (options: { sessionIdGenerator: undefined }) => { handleRequest: (req: unknown, res: unknown) => Promise<void>, close: () => Promise<void> },
 *   packageVersion: string,
 *   log?: (message: string) => void
 * }} options
 */
export function createHttpRequestHandler(options) {
  const { token, verifyAuthHeader, createServer, StreamableHTTPServerTransport, packageVersion } = options;
  const log = options.log || ((message) => console.error(message));

  return (req, res) => {
    if (!verifyAuthHeader(req.headers["authorization"], token)) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "Unauthorized: missing or invalid bearer token" }));
      return;
    }

    let url;
    try {
      // The request target is relative. Do not derive a URL base from the
      // user-controlled Host header, which can itself be malformed.
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad request" }));
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: packageVersion }));
      return;
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    void (async () => {
      const requestServer = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await requestServer.connect(transport);
        await transport.handleRequest(req, res);
        res.on("close", () => {
          void transport.close();
          void requestServer.close();
        });
      } catch (err) {
        log(`MCP HTTP request error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    })();
  };
}
