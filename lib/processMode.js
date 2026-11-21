
import path from "path";

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

export function isIndexerMode(argv = process.argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return false;
  }
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
  return entry === "apple-tools-indexer" || entry === "apple-tools-indexer.js";
}

export function isHttpTokenMode(argv = process.argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return false;
  }
  if (argv.includes("--mode=http-token")) {
    return true;
  }
  return firstPositionalArg(argv) === "http-token";
}

export function isHttpMode(argv = process.argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return false;
  }
  if (isPermissionsMode(argv) || isHttpTokenMode(argv)) {
    return false;
  }
  if (argv.includes("--transport=http") || argv.includes("--mode=http")) {
    return true;
  }
  const transportIdx = argv.indexOf("--transport");
  if (transportIdx !== -1 && argv[transportIdx + 1] === "http") {
    return true;
  }
  const entry = argv[1] ? path.basename(argv[1]) : "";
  return entry === "apple-tools-http" || entry === "apple-tools-http.js";
}
