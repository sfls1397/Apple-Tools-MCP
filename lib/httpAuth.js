/**
 * Shared-secret auth for the HTTP transport (--transport=http).
 *
 * stdio mode needs no auth — a locally spawned child process is already
 * trusted by whoever spawned it. HTTP mode is reachable over the LAN and,
 * via Tailscale, from outside it, and this server exposes write tools
 * (send iMessage, edit contacts/calendar), so every HTTP request must carry
 * a bearer token.
 *
 * The token is a random secret generated once and stored in the macOS
 * Keychain — never in a config file, the repo, argv, or logs.
 * Print it only with the explicit http-token command. There is no external account, no
 * OAuth flow, and no cost: it's a self-issued password, like an SSH key.
 */

import crypto from "crypto";
import { writeKeychainSecret } from "./keychainWrite.js";
import { execFileSync as defaultExecFileSync } from "child_process";

export const KEYCHAIN_SERVICE = "apple-tools-mcp-http";
export const KEYCHAIN_ACCOUNT = "http-auth-token";

function readFromKeychain(exec) {
  try {
    const out = exec(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const token = out.toString("utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function writeToKeychain(exec, token) {
  writeKeychainSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token, exec);
}

function generateToken(randomBytes) {
  return randomBytes(32).toString("hex");
}

/**
 * Loads the HTTP auth token from Keychain, generating and storing one the
 * first time this runs on a given machine. Returns the token either way.
 *
 * @param {{
 *   log?: (msg: string) => void,
 *   forceNew?: boolean,
 *   execFileSync?: typeof defaultExecFileSync,
 *   randomBytes?: typeof crypto.randomBytes
 * }} [options]
 * @returns {{ token: string, generated: boolean }}
 */
export function loadOrCreateHttpAuthToken(options = {}) {
  const log = options.log || ((msg) => console.error(msg));
  const exec = options.execFileSync || defaultExecFileSync;
  const randomBytes = options.randomBytes || crypto.randomBytes;

  if (!options.forceNew) {
    const existing = readFromKeychain(exec);
    if (existing) {
      return { token: existing, generated: false };
    }
  }

  const token = generateToken(randomBytes);
  writeToKeychain(exec, token);
  log("Generated a new HTTP auth token and stored it in Keychain.");
  log("Retrieve it with: apple-tools-mcp http-token");
  return { token, generated: true };
}

/**
 * Constant-time check of an incoming `Authorization: Bearer <token>` header
 * against the expected token. Never throws.
 *
 * @param {string | undefined | null} headerValue
 * @param {string} expectedToken
 * @returns {boolean}
 */
export function verifyAuthHeader(headerValue, expectedToken) {
  if (typeof headerValue !== "string") {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) {
    return false;
  }
  const provided = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(provided, expected);
}
