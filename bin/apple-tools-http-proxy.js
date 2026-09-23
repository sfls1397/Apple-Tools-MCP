#!/usr/bin/env node
import { runHttpStdioProxy } from "../lib/httpStdioProxy.js";

const url = process.argv[2];
if (!url || process.argv.length !== 3) {
  console.error("Usage: apple-tools-http-proxy <http://mini-address:8421/mcp>");
  process.exitCode = 2;
} else {
  try {
    await runHttpStdioProxy({ url, token: process.env.APPLE_TOOLS_MCP_TOKEN });
  } catch (error) {
    console.error(`Apple Tools HTTP proxy: ${error.message}`);
    process.exitCode = 1;
  }
}
