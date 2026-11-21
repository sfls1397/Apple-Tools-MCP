
import fs from "fs";
import os from "os";
import path from "path";
import { classifyAppleScriptError, SYSTEM_EVENTS_STICKY_DENY_GUIDANCE } from "./appleScript.js";
import { probeMailAutomation, probeSystemEventsAutomation } from "./mailWrite.js";
import { probeMessagesAutomation } from "./messagesWrite.js";
import { probeContactsAutomation } from "./contactsWrite.js";
import { probeCalendarAutomation } from "./calendarWrite.js";
import { detectLaunchAgentContext, hostAutomationAdvice } from "./writeRouting.js";

export const REQUIRED_SURFACES = ["Contacts", "Calendar", "Mail", "Messages", "System Events"];

export const EXAMPLE_MINI_NODE = path.join(os.homedir(), ".local", "node", "bin", "node");

export const EXAMPLE_MACBOOK_NVM_NODE = process.execPath;

export const GRANT_GRANTED = "granted";
export const GRANT_MISSING = "missing";
export const GRANT_ERROR = "error";

export function describeProbeBinary(execPath = process.execPath) {
  return {
    execPath: String(execPath || ""),
    miniExample: EXAMPLE_MINI_NODE,
    macbookExample: EXAMPLE_MACBOOK_NVM_NODE
  };
}

export function normalizeNodePath(filePath, { realpathSync = fs.realpathSync } = {}) {
  if (!filePath) return "";
  const resolved = path.resolve(String(filePath));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function readShebangTarget(scriptPath, { readFileSync = fs.readFileSync } = {}) {
  if (!scriptPath) return null;
  try {
    const line = String(readFileSync(scriptPath, "utf8")).split(/\r?\n/, 1)[0] || "";
    if (!line.startsWith("#!")) return null;
    const raw = line.slice(2).trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts[0] === "/usr/bin/env" || parts[0].endsWith("/env")) {
      return { kind: "env", target: parts[1] || "node", raw };
    }
    return { kind: "absolute", target: parts[0], raw };
  } catch {
    return null;
  }
}

export function detectExecPathMismatch({
  execPath = process.execPath,
  argv = process.argv,
  realpathSync = fs.realpathSync,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  const deps = { realpathSync, existsSync, readFileSync };
  const execNorm = normalizeNodePath(execPath, deps);
  const argv0 = argv && argv[0] ? String(argv[0]) : "";
  const invokedCli = argv && argv[1] ? String(argv[1]) : "";
  const argv0Norm = argv0 ? normalizeNodePath(argv0, deps) : "";

  const reasons = [];
  let siblingNode = "";
  let shebangTarget = "";

  if (argv0Norm && execNorm && argv0Norm !== execNorm) {
    reasons.push("argv0");
  }

  if (invokedCli) {
    const sibling = path.join(path.dirname(path.resolve(invokedCli)), "node");
    if (existsSync(sibling)) {
      siblingNode = normalizeNodePath(sibling, deps);
      if (siblingNode && execNorm && siblingNode !== execNorm) {
        reasons.push("sibling");
      }
    }
    const shebang = readShebangTarget(invokedCli, deps);
    if (shebang && shebang.kind === "absolute" && shebang.target) {
      shebangTarget = normalizeNodePath(shebang.target, deps);
      if (shebangTarget && execNorm && shebangTarget !== execNorm) {
        reasons.push("shebang");
      }
    }
  }

  return {
    mismatch: reasons.length > 0,
    reasons,
    execPath: execNorm || String(execPath || ""),
    argv0: argv0Norm || argv0,
    invokedCli,
    siblingNode,
    shebangTarget
  };
}

export function formatExecPathMismatchWarn(info) {
  if (!info || !info.mismatch) return [];
  const cli = info.invokedCli || "apple-tools-mcp";
  return [
    "",
    "WARN: Allow dialogs attach to process.execPath, not the apple-tools-mcp path you typed.",
    `  Invoked CLI:        ${cli}`,
    `  process.argv[0]:    ${info.argv0 || "(unknown)"}`,
    info.siblingNode ? `  Node next to CLI:   ${info.siblingNode}` : null,
    info.shebangTarget ? `  CLI shebang target: ${info.shebangTarget}` : null,
    `  process.execPath:   ${info.execPath}  ← Allows attach HERE`,
    "Re-run with that exact node so execPath matches the binary you intend:",
    `  ${info.execPath} ${cli} permissions`,
    "  or: $(which node) $(which apple-tools-mcp) permissions",
    '  or: node "$(dirname "$(which node)")/../lib/node_modules/apple-tools-mcp/index.js" permissions',
    ""
  ].filter((line) => line !== null);
}

export function classifyGrantStatus(result) {
  if (result && result.ok === true) return GRANT_GRANTED;
  const text = String((result && (result.message || result.error)) || "");
  const kind = (result && result.kind) || classifyAppleScriptError(text);
  if (kind === "tcc" || kind === "timeout" || kind === "attribution") {
    return GRANT_MISSING;
  }
  if (kind === "app_not_running") {
    return GRANT_ERROR;
  }
  if (/accessibility_denied|assistive access|gui_scripting_unavailable/i.test(text)) {
    return GRANT_MISSING;
  }
  if (/tcc|automation deny|not authorized|not permitted|not allowed|timed out|etimedout|responsible-process|attribution/i.test(text)) {
    return GRANT_MISSING;
  }
  return GRANT_ERROR;
}

export function formatGrantReport(grants) {
  return REQUIRED_SURFACES.map((name) => `${name} = ${grants[name] || GRANT_ERROR}`);
}

export function exitCodeForGrants(grants) {
  return REQUIRED_SURFACES.every((name) => grants[name] === GRANT_GRANTED) ? 0 : 1;
}

export function probeFullDiskAccess({
  home = process.env.HOME,
  accessFn = fs.accessSync
} = {}) {
  if (!home) {
    return { status: "skipped", message: "HOME is unset; skipped Full Disk Access probe" };
  }
  const targets = [
    path.join(home, "Library", "Mail"),
    path.join(home, "Library", "Messages", "chat.db"),
    path.join(home, "Library", "Application Support", "AddressBook")
  ];
  let sawPath = false;
  for (const target of targets) {
    try {
      accessFn(target, fs.constants.R_OK);
      sawPath = true;
    } catch (e) {
      const code = e && e.code ? e.code : "";
      if (code === "EPERM" || code === "EACCES") {
        return {
          status: "missing",
          message: `Full Disk Access looks missing for this node (${code} reading ${path.basename(target)}). Reads need FDA on node; that is separate from Automation.`
        };
      }
      if (code === "ENOENT") {
        continue;
      }
      return {
        status: "skipped",
        message: `Full Disk Access probe skipped (${code || "error"} on ${path.basename(target)})`
      };
    }
  }
  if (!sawPath) {
    return { status: "skipped", message: "Mail / Messages / AddressBook paths are not present; skipped Full Disk Access probe" };
  }
  return { status: "readable", message: "Mail / Messages / AddressBook paths are readable (Full Disk Access looks present)" };
}

export function defaultPermissionsProbes() {
  return {
    Contacts: probeContactsAutomation,
    Calendar: probeCalendarAutomation,
    Mail: probeMailAutomation,
    Messages: probeMessagesAutomation,
    "System Events": probeSystemEventsAutomation
  };
}

function bannerLines(binary, version) {
  return [
    `Apple Tools MCP permissions (v${version})`,
    "=".repeat(60),
    `Probing node binary: ${binary.execPath}`,
    "This is process.execPath — the node that is running this command.",
    `Mini example:     ${binary.miniExample}`,
    `Runtime example: ${binary.macbookExample}  (current Node installation)`,
    "Invoke this command with the product node so Allow dialogs attach to it.",
    "",
    "Open System Settings → Privacy & Security → Automation on this Mac.",
    "When macOS asks, click Allow for THIS node — not the MCP host app.",
    "Do not add node via + in the Contacts or Calendars privacy lists.",
    "dry_run of mail_send / messages_send does not count: this command uses real Apple Events.",
    "Nothing is sent to third parties. Mail composes and discards a temporary outgoing message.",
    "Messages only enumerates accounts. Contacts creates and deletes a throwaway person in-script.",
    "Calendar lists calendars only — no events are created.",
    "System Events is probed with process / GUI scripting (tell process + unix id; nothing is typed).",
    "A soft tell System Events to get name is not enough — that can succeed without AppleEvents auth.",
    "A prior Don't Allow is a sticky Deny: turn System Events on for this node in Automation, then re-run this command."
  ];
}

export async function runPermissionsCommand({
  execPath = process.execPath,
  argv = process.argv,
  version = "",
  stdout = console.log,
  probes,
  fdaProbe = probeFullDiskAccess,
  realpathSync = fs.realpathSync,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  const binary = describeProbeBinary(execPath);
  const mismatch = detectExecPathMismatch({
    execPath,
    argv,
    realpathSync,
    existsSync,
    readFileSync
  });
  const launchAgent = detectLaunchAgentContext({ existsSync });
  const hostAdvice = hostAutomationAdvice({ launchAgent, execPath });
  const probeFns = { ...defaultPermissionsProbes(), ...(probes || {}) };
  const log = (msg) => {
    stdout(msg);
  };

  for (const line of bannerLines(binary, version)) {
    log(line);
  }
  for (const line of formatExecPathMismatchWarn(mismatch)) {
    log(line);
  }

  const grants = {};
  for (const surface of REQUIRED_SURFACES) {
    log("");
    log(`--- ${surface} ---`);
    log(`Next dialog: click Allow for node → ${surface} (if asked). Already-granted surfaces stay quiet.`);
    let result;
    try {
      result = await Promise.resolve(probeFns[surface]());
    } catch (e) {
      result = { ok: false, message: e && e.message ? e.message : String(e), kind: "unknown" };
    }
    const status = classifyGrantStatus(result);
    grants[surface] = status;
    log(`[${status}] ${surface}: ${result && result.message ? result.message : ""}`);
    if (status !== GRANT_GRANTED) {
      log(`  ${hostAdvice}`);
    }
  }

  const fda = fdaProbe();
  log("");
  log(`--- Full Disk Access (advisory) ---`);
  log(`[${fda.status}] ${fda.message}`);

  log("");
  log("=".repeat(60));
  log("Grant report");
  for (const line of formatGrantReport(grants)) {
    log(`  ${line}`);
  }

  const code = exitCodeForGrants(grants);
  if (code === 0) {
    log("Result: PASS — Contacts, Calendar, Mail, Messages, and System Events are granted for this node.");
    log("Safe to re-run; already-granted surfaces report OK without another click.");
  } else {
    log("Result: INCOMPLETE — one or more required grants are missing or errored.");
    log(hostAdvice);
    if (grants["System Events"] !== GRANT_GRANTED) {
      log(SYSTEM_EVENTS_STICKY_DENY_GUIDANCE);
    }
    log("Click Allow for the missing surfaces and re-run this command. Exit is non-zero (fail closed).");
  }
  return code;
}
