/**
 * Process mode detection for apple-tools-mcp.
 *
 * Canonical indexer entrypoint: `node index.js --mode=indexer`
 * Convenience bin: `apple-tools-indexer` (same file; detected via argv[1]).
 * MCP stdio remains the default when neither is present.
 */

import path from "path";

/**
 * @param {string[]} [argv=process.argv]
 * @returns {boolean}
 */
export function isIndexerMode(argv = process.argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return false;
  }
  if (argv.includes("--mode=indexer")) {
    return true;
  }
  const modeIdx = argv.indexOf("--mode");
  if (modeIdx !== -1 && argv[modeIdx + 1] === "indexer") {
    return true;
  }
  const entry = argv[1] ? path.basename(argv[1]) : "";
  return entry === "apple-tools-indexer";
}
