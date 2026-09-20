/**
 * Process mode detection for apple-tools-mcp.
 *
 * Canonical indexer entrypoint: `node index.js --mode=indexer`
 * Convenience bin: `apple-tools-indexer` (same file; detected via argv[1]).
 * Permissions CLI: `apple-tools-mcp permissions` / `--mode=permissions`.
 * MCP stdio remains the default when neither is present.
 */

import path from "path";

/**
 * First positional user argument, skipping flags (`--foo` / `--foo=bar`).
 * Used so `node index.js permissions` and `apple-tools-mcp permissions`
 * both resolve as the permissions CLI.
 *
 * @param {string[]} argv
 * @returns {string|null}
 */
function firstPositionalArg(argv) {
  const rest = Array.isArray(argv) ? argv.slice(2) : [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--mode") {
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("-")) {
      continue;
    }
    return arg || null;
  }
  return null;
}

/**
 * @param {string[]} [argv=process.argv]
 * @returns {boolean}
 */
export function isPermissionsMode(argv = process.argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return false;
  }
  if (argv.includes("--mode=permissions")) {
    return true;
  }
  const modeIdx = argv.indexOf("--mode");
  if (modeIdx !== -1 && argv[modeIdx + 1] === "permissions") {
    return true;
  }
  return firstPositionalArg(argv) === "permissions";
}

/**
 * @param {string[]} [argv=process.argv]
 * @returns {boolean}
 */
export function isIndexerMode(argv = process.argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return false;
  }
  // permissions is a short-lived CLI on the same bin; it wins over indexer.
  if (isPermissionsMode(argv)) {
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
