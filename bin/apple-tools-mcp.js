#!/usr/bin/env node
/**
 * npm bin for the MCP stdio server (and `permissions` subcommand).
 * Dedicated wrapper so npm 12 pack/publish keeps the CLI — `index.js` as a
 * bin target is rewritten with "script name index.js was invalid and removed".
 */
import '../index.js';
