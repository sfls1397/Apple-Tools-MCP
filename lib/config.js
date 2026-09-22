/**
 * User config for apple-tools-mcp.
 *
 * Path is fixed at ~/.apple-tools-mcp/config.json (or $HOME). Arbitrary paths
 * from config contents are ignored — config is treated as data, not as
 * instructions or path overrides.
 *
 * Interval precedence (highest wins):
 *   1. INDEX_INTERVAL_MS environment variable
 *   2. config.json `indexInterval` (or `indexIntervalMs`)
 *   3. Product default (5 minutes)
 *
 * Values are clamped to [15s, 6h]. Human forms like `30s`, `1m`, `1h` are accepted.
 */

import fs from "fs";
import os from "os";
import path from "path";

export const APPLE_TOOLS_DIR_NAME = ".apple-tools-mcp";
export const CONFIG_FILE_NAME = "config.json";

/** MacBook / MCP local-fallback default. */
export const DEFAULT_INDEX_INTERVAL_MS = 5 * 60 * 1000;

/** Documented floor: 15 seconds (30s remains allowed). */
export const MIN_INDEX_INTERVAL_MS = 15 * 1000;

/** Documented ceiling: 6 hours. */
export const MAX_INDEX_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Recommended Mini always-on value (set in config.json, not the product default). */
export const MINI_RECOMMENDED_INDEX_INTERVAL_MS = 60 * 1000;

/** --transport=http bind address/port defaults. */
export const DEFAULT_HTTP_HOST = "0.0.0.0";
export const DEFAULT_HTTP_PORT = 8421;

const KNOWN_CONFIG_KEYS = new Set(["indexInterval", "indexIntervalMs", "httpHost", "httpPort"]);

const MAX_DURATION_STRING_LENGTH = 32;

function defaultWarn(message) {
  console.error(message);
}

/**
 * Directory that holds config.json, indexer.lock, and vector-index.
 * Always under the user home directory — never a path from config contents.
 *
 * @param {{ env?: NodeJS.ProcessEnv, homedir?: () => string }} [options]
 * @returns {string}
 */
export function getAppleToolsDir(options = {}) {
  const env = options.env || process.env;
  const homedir = options.homedir || (() => os.homedir());
  const home = env.HOME || homedir();
  return path.join(home, APPLE_TOOLS_DIR_NAME);
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, homedir?: () => string }} [options]
 * @returns {string}
 */
export function getConfigPath(options = {}) {
  return path.join(getAppleToolsDir(options), CONFIG_FILE_NAME);
}

/**
 * Parse a millisecond count or human duration (`500ms`, `30s`, `1m`, `1h`).
 * @param {unknown} value
 * @returns {number|null} milliseconds, or null if unparseable
 */
export function parseDuration(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DURATION_STRING_LENGTH) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n)) {
      return null;
    }
    return n;
  }
  const match = /^(\d+)(ms|s|m|h)$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n)) {
    return null;
  }
  const unit = match[2].toLowerCase();
  const multiplier = unit === "ms" ? 1
    : unit === "s" ? 1000
    : unit === "m" ? 60 * 1000
    : 60 * 60 * 1000;
  const result = n * multiplier;
  if (!Number.isSafeInteger(result)) {
    return null;
  }
  return result;
}

/**
 * Compact human form for logs (`1m`, `30s`, `6h`, or `1500ms`).
 * @param {number} ms
 * @returns {string}
 */
export function formatIntervalMs(ms) {
  if (!Number.isFinite(ms)) {
    return String(ms);
  }
  const rounded = Math.round(ms);
  if (rounded % (60 * 60 * 1000) === 0) {
    return `${rounded / (60 * 60 * 1000)}h`;
  }
  if (rounded % (60 * 1000) === 0) {
    return `${rounded / (60 * 1000)}m`;
  }
  if (rounded % 1000 === 0) {
    return `${rounded / 1000}s`;
  }
  return `${rounded}ms`;
}

/**
 * Clamp a parsed millisecond value. Invalid input yields the default (not the min).
 *
 * @param {unknown} raw
 * @param {{ defaultMs?: number, minMs?: number, maxMs?: number }} [bounds]
 * @returns {{ ms: number, human: string, clamped: boolean, invalid: boolean, requestedMs: number|null }}
 */
export function clampIndexInterval(raw, bounds = {}) {
  const defaultMs = bounds.defaultMs ?? DEFAULT_INDEX_INTERVAL_MS;
  const minMs = bounds.minMs ?? MIN_INDEX_INTERVAL_MS;
  const maxMs = bounds.maxMs ?? MAX_INDEX_INTERVAL_MS;
  const requestedMs = parseDuration(raw);

  if (requestedMs === null) {
    return {
      ms: defaultMs,
      human: formatIntervalMs(defaultMs),
      clamped: false,
      invalid: true,
      requestedMs: null
    };
  }

  const clampedMs = Math.min(maxMs, Math.max(minMs, requestedMs));
  return {
    ms: clampedMs,
    human: formatIntervalMs(clampedMs),
    clamped: clampedMs !== requestedMs,
    invalid: false,
    requestedMs
  };
}

/**
 * Load ~/.apple-tools-mcp/config.json. Missing file is fine. Invalid JSON
 * does not throw — callers get empty data plus a warn log.
 *
 * @param {{
 *   configPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   readFile?: (p: string) => string,
 *   exists?: (p: string) => boolean,
 *   warn?: (msg: string) => void
 * }} [options]
 * @returns {{ data: Record<string, unknown>, missing: boolean, invalid: boolean, path: string }}
 */
export function loadConfigFile(options = {}) {
  const warn = options.warn || defaultWarn;
  const configPath = options.configPath || getConfigPath({ env: options.env });
  const exists = options.exists || ((p) => fs.existsSync(p));
  const readFile = options.readFile || ((p) => fs.readFileSync(p, "utf8"));

  if (!exists(configPath)) {
    return { data: {}, missing: true, invalid: false, path: configPath };
  }

  try {
    const raw = readFile(configPath);
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn("Invalid config.json: expected a JSON object. Using defaults.");
      return { data: {}, missing: false, invalid: true, path: configPath };
    }
    for (const key of Object.keys(parsed)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        warn(`Ignoring unknown config key: ${key}`);
      }
    }
    return { data: parsed, missing: false, invalid: false, path: configPath };
  } catch (err) {
    const message = err && err.message ? err.message : "parse error";
    warn(`Invalid config.json (${message}). Using defaults.`);
    return { data: {}, missing: false, invalid: true, path: configPath };
  }
}

function fileIntervalRaw(data) {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(data, "indexInterval")) {
    return data.indexInterval;
  }
  if (Object.prototype.hasOwnProperty.call(data, "indexIntervalMs")) {
    return data.indexIntervalMs;
  }
  return undefined;
}

/**
 * Resolve the index refresh interval once at process start.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   configPath?: string,
 *   fileData?: Record<string, unknown>,
 *   warn?: (msg: string) => void
 * }} [options]
 * @returns {{
 *   ms: number,
 *   human: string,
 *   source: "env" | "config" | "default",
 *   clamped: boolean,
 *   invalid: boolean,
 *   requestedMs: number|null,
 *   raw: unknown
 * }}
 */
export function resolveIndexInterval(options = {}) {
  const env = options.env || process.env;
  const warn = options.warn || defaultWarn;
  const envRaw = env.INDEX_INTERVAL_MS;
  const envSet = envRaw !== undefined && envRaw !== "";

  let source = "default";
  let raw = DEFAULT_INDEX_INTERVAL_MS;

  if (envSet) {
    source = "env";
    raw = envRaw;
  } else {
    const data = options.fileData !== undefined
      ? options.fileData
      : loadConfigFile({ configPath: options.configPath, env, warn }).data;
    const fromFile = fileIntervalRaw(data);
    if (fromFile !== undefined) {
      source = "config";
      raw = fromFile;
    }
  }

  const clamped = clampIndexInterval(raw);
  if (clamped.invalid && source !== "default") {
    warn(`Invalid index interval ${JSON.stringify(raw)} from ${source}; using default ${clamped.human} (${clamped.ms} ms)`);
  } else if (clamped.clamped) {
    const fromHuman = formatIntervalMs(clamped.requestedMs);
    warn(
      `Index interval ${fromHuman} (${clamped.requestedMs} ms) from ${source} is outside ${formatIntervalMs(MIN_INDEX_INTERVAL_MS)}–${formatIntervalMs(MAX_INDEX_INTERVAL_MS)}; clamped to ${clamped.human} (${clamped.ms} ms)`
    );
  }

  return {
    ms: clamped.ms,
    human: clamped.human,
    source: clamped.invalid && source !== "default" ? "default" : source,
    clamped: clamped.clamped,
    invalid: clamped.invalid,
    requestedMs: clamped.requestedMs,
    raw
  };
}

/**
 * Load config from disk (if present) and resolve the interval.
 * @param {{ env?: NodeJS.ProcessEnv, configPath?: string, warn?: (msg: string) => void }} [options]
 */
export function loadResolvedIndexInterval(options = {}) {
  const warn = options.warn || defaultWarn;
  const loaded = loadConfigFile({
    configPath: options.configPath,
    env: options.env,
    warn
  });
  return resolveIndexInterval({
    env: options.env,
    fileData: loaded.data,
    warn
  });
}

/**
 * Log the effective interval once. Human form and milliseconds.
 * @param {{ ms: number, human: string, source: string, clamped: boolean }} resolved
 * @param {{ log?: (msg: string) => void }} [options]
 */
export function logResolvedInterval(resolved, options = {}) {
  const log = options.log || defaultWarn;
  const clampedNote = resolved.clamped ? ", clamped" : "";
  log(`Effective index refresh interval: ${resolved.human} (${resolved.ms} ms) [source=${resolved.source}${clampedNote}]`);
}

/**
 * Resolve --transport=http bind host/port.
 * Precedence (highest wins): env vars > config.json > product default.
 *
 * @param {{ env?: NodeJS.ProcessEnv, configPath?: string, fileData?: Record<string, unknown>, warn?: (msg: string) => void }} [options]
 * @returns {{ host: string, port: number }}
 */
export function resolveHttpServerConfig(options = {}) {
  const env = options.env || process.env;
  const warn = options.warn || defaultWarn;
  const data =
    options.fileData !== undefined
      ? options.fileData
      : loadConfigFile({ configPath: options.configPath, env, warn }).data;

  const host = env.APPLE_TOOLS_HTTP_HOST || (typeof data.httpHost === "string" ? data.httpHost : undefined) || DEFAULT_HTTP_HOST;

  const rawPort = env.APPLE_TOOLS_HTTP_PORT !== undefined ? env.APPLE_TOOLS_HTTP_PORT : data.httpPort;
  const parsedPort = typeof rawPort === "number" ? rawPort : Number(rawPort);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : DEFAULT_HTTP_PORT;

  return { host, port };
}
