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
 * - Mini LaunchAgent / write-bridge hosts may be told to use the daemon.
 *   MacBook / Terminal / permissions CLI (no writer.sock) must not be told
 *   to start apple-tools-indexer — that path is Mini-only.
 *
 * These helpers are pure so the routing policy is testable off-macOS.
 */

import fs from "fs";
import { defaultSocketPath } from "./writeBridge.js";

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
 * Mini always-on indexer / write bridge is present (writer.sock or this
 * process is the daemon). Absent on MacBook / short-lived Terminal CLI.
 */
export function detectLaunchAgentContext({
  indexerMode = false,
  bridgeAvailable = false,
  socketPath,
  existsSync = fs.existsSync
} = {}) {
  if (indexerMode || bridgeAvailable) return true;
  const sock = socketPath || defaultSocketPath();
  try {
    return Boolean(sock && existsSync(sock));
  } catch {
    return false;
  }
}

/**
 * MacBook / Terminal / permissions CLI — no always-on indexer.
 * Allows attach to the printed process.execPath.
 */
export function terminalAutomationAdvice(execPath = process.execPath) {
  const printed = execPath ? ` (${execPath})` : "";
  return (
    `Run this from Terminal.app (short-lived CLI / MacBook host — no always-on indexer). ` +
    `Click Allow for the printed process.execPath${printed}. ` +
    `Check System Settings → Privacy & Security → Automation for that node → Contacts, Calendar, Mail, Messages, and System Events. ` +
    `Do not start apple-tools-indexer.`
  );
}

/**
 * Mini host with a live write-bridge / LaunchAgent.
 */
export function miniLaunchAgentAdvice() {
  return (
    "This Mac has a Mini write-bridge / LaunchAgent. Grant the daemon's node Full Disk Access (reads) and " +
    "Allow that node in System Settings → Privacy & Security → Automation for Mail.app, Messages.app, Contacts.app, Calendar.app, and System Events (mail_send / mail_draft fill the body via AX hit-test). " +
    "Do not add node via + in the Contacts or Calendars privacy lists."
  );
}

export function hostAutomationAdvice({
  launchAgent = false,
  execPath = process.execPath
} = {}) {
  return launchAgent ? miniLaunchAgentAdvice() : terminalAutomationAdvice(execPath);
}

/**
 * Advice appended when a local write is denied by TCC.
 * No writer.sock / LaunchAgent → Terminal + printed execPath only.
 */
export function tccFallbackAdvice({
  bridgeAvailable,
  execPath = process.execPath,
  launchAgent
} = {}) {
  const mini = launchAgent === undefined ? Boolean(bridgeAvailable) : Boolean(launchAgent);
  if (mini && bridgeAvailable) {
    return (
      "The indexer daemon was reachable but the write was still denied; grant the daemon's node binary Full Disk Access (reads) and " +
      "Allow node in System Settings > Privacy & Security > Automation for Mail.app, Messages.app, Contacts.app, Calendar.app, and System Events. " +
      "A hang or timeout on Mail compose is TCC / Automation denied, not Mail.app missing. " +
      "Do not add node via + in the Contacts or Calendars privacy lists — those panes often have no Add button."
    );
  }
  if (mini) {
    return miniLaunchAgentAdvice();
  }
  return terminalAutomationAdvice(execPath);
}
