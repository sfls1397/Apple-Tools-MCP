/**
 * Notification Center toasts for the indexer / LaunchAgent runtime.
 *
 * Default is quiet: LaunchAgent and `--mode=indexer` must not banner the
 * operator. Startup still logs to stderr (redirected by the plist).
 * Permissions probing does not use this module — those Allow dialogs stay.
 *
 * Opt-in only:
 *   APPLE_TOOLS_NOTIFY=1
 *   --notify
 */

import { runAppleScript, asString } from "./appleScript.js";

export const INDEXER_NOTIFY_TITLE = "Apple Tools MCP";
export const INDEXER_RUNNING_MESSAGE = "indexer is running";

/**
 * @param {{ env?: NodeJS.ProcessEnv, argv?: string[] }} [options]
 * @returns {boolean}
 */
export function isUserNotifyEnabled({
  env = process.env,
  argv = process.argv
} = {}) {
  const raw = env && env.APPLE_TOOLS_NOTIFY;
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  const args = Array.isArray(argv) ? argv : [];
  return args.includes("--notify") || args.includes("--verbose-notify");
}

/**
 * @param {string} title
 * @param {string} message
 * @returns {string}
 */
export function buildUserNotifyScript(title, message) {
  return `display notification ${asString(message)} with title ${asString(title)}`;
}

/**
 * Post a Notification Center toast only when explicitly opted in.
 *
 * @returns {{ posted: boolean, reason: string }}
 */
export function postUserNotification(title, message, {
  env = process.env,
  argv = process.argv,
  run = runAppleScript
} = {}) {
  if (!isUserNotifyEnabled({ env, argv })) {
    return { posted: false, reason: "quiet" };
  }
  const result = run(buildUserNotifyScript(title, message), { timeout: 5000 });
  if (!result || result.ok === false) {
    return { posted: false, reason: "error" };
  }
  return { posted: true, reason: "opt-in" };
}

/**
 * The only indexer-runtime toast. Off unless APPLE_TOOLS_NOTIFY / --notify.
 *
 * @returns {{ posted: boolean, reason: string }}
 */
export function maybeNotifyIndexerRunning({
  version = "",
  env = process.env,
  argv = process.argv,
  run = runAppleScript
} = {}) {
  const suffix = version ? ` (v${version})` : "";
  return postUserNotification(
    INDEXER_NOTIFY_TITLE,
    `${INDEXER_RUNNING_MESSAGE}${suffix}`,
    { env, argv, run }
  );
}
