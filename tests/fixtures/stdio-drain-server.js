#!/usr/bin/env node
/**
 * Minimal MCP stdio server wired like index.js (bindStdinCloseExit +
 * drain-on-close), with one slow tool so tests need no Mail access.
 * DRAIN=0 reproduces the pre-fix synchronous exit.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  bindStdinCloseExit,
  trackInFlightRequests,
  drainInFlightThenExit
} from "../../lib/indexerRuntime.js";

const DRAIN = process.env.DRAIN !== "0";
const DELAY_MS = Number(process.env.DELAY_MS || 300);
const REPLY_BYTES = Number(process.env.REPLY_BYTES || 1024);

let inFlight = null;
bindStdinCloseExit(process.stdin, false, () => {
  if (!DRAIN) process.exit(0);
  drainInFlightThenExit({
    inFlight,
    timeoutMs: 10000,
    exit: () => process.exit(0)
  });
});

const server = new Server({ name: "stdio-drain-fixture", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "slow_echo", description: "test", inputSchema: { type: "object", properties: {} } }]
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  return { content: [{ type: "text", text: "x".repeat(REPLY_BYTES) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
inFlight = trackInFlightRequests(transport);
