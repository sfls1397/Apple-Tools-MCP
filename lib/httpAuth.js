
import crypto from "crypto";
import { writeKeychainSecret } from "./keychainWrite.js";
import { execFileSync as defaultExecFileSync } from "child_process";

export const KEYCHAIN_SERVICE = "apple-tools-mcp-http";
export const KEYCHAIN_ACCOUNT = "http-auth-token";
export const ENV_TOKEN = "APPLE_TOOLS_HTTP_TOKEN";
export const ENV_PREVIOUS_TOKEN = "APPLE_TOOLS_HTTP_TOKEN_PREVIOUS";

function envToken(env, name) {
  const value = env && typeof env[name] === "string" ? env[name].trim() : "";
  return value.length > 0 ? value : null;
}

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

export function loadOrCreateHttpAuthToken(options = {}) {
  const log = options.log || ((msg) => console.error(msg));
  const exec = options.execFileSync || defaultExecFileSync;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const env = options.env || process.env;

  if (!options.forceNew) {
    const injected = envToken(env, ENV_TOKEN);
    if (injected) {
      return { token: injected, generated: false };
    }

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

export function acceptedHttpAuthTokens(token, env = process.env) {
  const previous = envToken(env, ENV_PREVIOUS_TOKEN);
  return previous && envToken(env, ENV_TOKEN) === token && previous !== token ? [token, previous] : [token];
}

export function verifyAuthHeader(headerValue, expectedToken) {
  if (Array.isArray(expectedToken)) {
    return expectedToken.reduce((ok, expected) => verifyAuthHeader(headerValue, expected) || ok, false);
  }
  if (typeof expectedToken !== "string" || expectedToken.length === 0) {
    return false;
  }
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
