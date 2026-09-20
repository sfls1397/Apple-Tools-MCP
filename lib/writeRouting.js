/**
 * Where a write executes: in this process, or in the indexer daemon.
 *
 * macOS attributes Apple events and Contacts/Calendar access to the process
 * *responsible* for the sender. A stdio MCP server inherits that
 * responsibility from the host app that launched it, so Contacts and Calendar
 * writes can be denied even when node has Full Disk Access. The indexer
 * daemon is launched by launchd, so node is responsible for its own events.
 *
 * Policy:
 * - The indexer daemon always executes locally (it is the privileged host).
 * - An MCP stdio process delegates to the daemon when the write bridge is up.
 * - If delegation is impossible, it runs locally and, on a TCC denial,
 *   explains the host constraint instead of reporting a generic failure.
 *
 * These helpers are pure so the routing policy is testable off-macOS.
 */

/**
 * Writes that macOS gates behind per-app privacy (TCC) rather than plain
 * file permissions. All of them benefit from running in the daemon.
 */
export const TCC_SENSITIVE_PREFIXES = ["contacts_", "calendar_", "mail_", "messages_"];

export function isTccSensitiveWrite(toolName) {
  return TCC_SENSITIVE_PREFIXES.some((prefix) => String(toolName || "").startsWith(prefix));
}

/**
 * @param {object} state
 * @param {boolean} state.indexerMode - true when this process is the daemon
 * @param {boolean} state.bridgeAvailable - true when the daemon socket answered
 * @param {string} state.toolName
 * @returns {{ target: "local"|"daemon", reason: string }}
 */
export function planWriteRoute({ indexerMode, bridgeAvailable, toolName }) {
  if (indexerMode) {
    return { target: "local", reason: "this process is the indexer daemon" };
  }
  if (bridgeAvailable && isTccSensitiveWrite(toolName)) {
    return { target: "daemon", reason: "the indexer daemon owns the privacy-approved automation context" };
  }
  return { target: "local", reason: bridgeAvailable ? "tool is not privacy-gated" : "no indexer daemon is listening" };
}

/**
 * Decide what to do after a delegated attempt.
 * A bridge that is down or broken must not block the write: fall back to
 * local execution so a single-host setup keeps working.
 *
 * @returns {{ fallbackLocal: boolean }}
 */
export function planAfterDelegation({ delivered, response }) {
  if (!delivered) return { fallbackLocal: true };
  if (!response || typeof response !== "object") return { fallbackLocal: true };
  if (response.unsupported) return { fallbackLocal: true };
  return { fallbackLocal: false };
}

/**
 * Advice appended when a local write is denied by TCC and no daemon was
 * available to take over.
 */
export function tccFallbackAdvice({ bridgeAvailable }) {
  if (bridgeAvailable) {
    return "The indexer daemon was reachable but the write was still denied; grant the daemon's node binary Full Disk Access and Automation access in System Settings > Privacy & Security.";
  }
  return "No indexer daemon is running on this Mac. Start apple-tools-indexer (the LaunchAgent) so writes execute under node, which macOS can grant Contacts/Calendar access to directly.";
}
