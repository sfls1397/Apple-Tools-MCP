import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Forward the tool interface from an HTTP MCP server to a local stdio client. */
export function createProxyServer(remoteClient) {
  const server = new Server(
    { name: "apple-tools-http-proxy", version: "3.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    remoteClient.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    remoteClient.callTool(request.params));

  return server;
}

export async function runHttpStdioProxy({ url, token, input = process.stdin, output = process.stdout }) {
  if (!token) throw new Error("APPLE_TOOLS_MCP_TOKEN is required");
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("MCP URL must use http or https");
  }

  const remoteClient = new Client({ name: "apple-tools-http-proxy", version: "3.0.0" });
  const remoteTransport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await remoteClient.connect(remoteTransport);

  const server = createProxyServer(remoteClient);
  try {
    await server.connect(new StdioServerTransport(input, output));
  } catch (error) {
    await remoteClient.close();
    throw error;
  }

  server.onclose = () => { void remoteClient.close(); };
  return server;
}
