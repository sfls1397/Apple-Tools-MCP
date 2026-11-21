
import fs from "fs";
import { defaultSocketPath } from "./writeBridge.js";

export const TCC_SENSITIVE_PREFIXES = ["contacts_", "calendar_", "mail_", "messages_"];

export function isTccSensitiveWrite(toolName) {
  return TCC_SENSITIVE_PREFIXES.some((prefix) => String(toolName || "").startsWith(prefix));
}

export function planWriteRoute({ indexerMode, bridgeAvailable, toolName }) {
  if (indexerMode) {
    return { target: "local", reason: "this process is the indexer daemon" };
  }
  if (bridgeAvailable && isTccSensitiveWrite(toolName)) {
    return { target: "daemon", reason: "the indexer daemon owns the privacy-approved automation context" };
  }
  return { target: "local", reason: bridgeAvailable ? "tool is not privacy-gated" : "no indexer daemon is listening" };
}

export function planAfterDelegation({ delivered, response }) {
  if (!delivered) return { fallbackLocal: true };
  if (!response || typeof response !== "object") return { fallbackLocal: true };
  if (response.unsupported) return { fallbackLocal: true };
  return { fallbackLocal: false };
}

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

export function terminalAutomationAdvice(execPath = process.execPath) {
  const printed = execPath ? ` (${execPath})` : "";
  return (
    `Run this from Terminal.app (short-lived CLI / MacBook host — no always-on indexer). ` +
    `Click Allow for the printed process.execPath${printed}. ` +
    `Check System Settings → Privacy & Security → Automation for that node → Contacts, Calendar, Mail, Messages, and System Events. ` +
    `Do not start apple-tools-indexer.`
  );
}

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
