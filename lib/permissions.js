/**
 * First-run / upgrade permissions command.
 *
 * Probes Contacts, Calendar, Mail, and Messages under process.execPath so
 * macOS can pop Allow dialogs for that node binary. The user clicks Allow;
 * this command cannot grant silently.
 *
 * Always runs in this process (never via the write bridge): the point is to
 * attach the dialogs to the node that invoked `apple-tools-mcp permissions`.
 * Mail and Messages use the existing live Apple Events helpers — dry_run of
 * mail_send / messages_send never talks to those apps and does not count.
 */

import fs from "fs";
import path from "path";
import { classifyAppleScriptError } from "./appleScript.js";
import { probeMailAutomation } from "./mailWrite.js";
import { probeMessagesAutomation } from "./messagesWrite.js";
import { probeContactsAutomation } from "./contactsWrite.js";
import { probeCalendarAutomation } from "./calendarWrite.js";

export const REQUIRED_SURFACES = ["Contacts", "Calendar", "Mail", "Messages"];

/** Mini ship-gate host example — not a universal path. */
export const EXAMPLE_MINI_NODE = "/Users/petercoates/.local/node/bin/node";

/** MacBook Claude nvm example — not Homebrew. */
export const EXAMPLE_MACBOOK_NVM_NODE = "/Users/petercoates/.nvm/versions/node/v22.21.1/bin/node";

export const GRANT_GRANTED = "granted";
export const GRANT_MISSING = "missing";
export const GRANT_ERROR = "error";

/**
 * @param {string} [execPath=process.execPath]
 * @returns {{ execPath: string, miniExample: string, macbookExample: string }}
 */
export function describeProbeBinary(execPath = process.execPath) {
  return {
    execPath: String(execPath || ""),
    miniExample: EXAMPLE_MINI_NODE,
    macbookExample: EXAMPLE_MACBOOK_NVM_NODE
  };
}

/**
 * Map a probe result to the grant report vocabulary.
 * TCC / timeout / attribution on a live Apple Event is a missing Allow.
 *
 * @param {{ ok?: boolean, kind?: string|null, message?: string, error?: string }} result
 * @returns {"granted"|"missing"|"error"}
 */
export function classifyGrantStatus(result) {
  if (result && result.ok === true) return GRANT_GRANTED;
  const text = String((result && (result.message || result.error)) || "");
  const kind = (result && result.kind) || classifyAppleScriptError(text);
  if (kind === "tcc" || kind === "timeout" || kind === "attribution") {
    return GRANT_MISSING;
  }
  if (/tcc|automation deny|not authorized|not permitted|not allowed|timed out|etimedout|responsible-process|attribution/i.test(text)) {
    return GRANT_MISSING;
  }
  return GRANT_ERROR;
}

/**
 * @param {Record<string, string>} grants
 * @returns {string[]}
 */
export function formatGrantReport(grants) {
  return REQUIRED_SURFACES.map((name) => `${name} = ${grants[name] || GRANT_ERROR}`);
}

/**
 * Fail closed: any required surface that is not granted is a non-zero exit.
 *
 * @param {Record<string, string>} grants
 * @returns {number}
 */
export function exitCodeForGrants(grants) {
  return REQUIRED_SURFACES.every((name) => grants[name] === GRANT_GRANTED) ? 0 : 1;
}

/**
 * Advisory Full Disk Access touch. Read tools need FDA on this node; it is
 * not one of the four required Automation grants and never fails the command.
 *
 * @returns {{ status: "readable"|"missing"|"skipped", message: string }}
 */
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
    Messages: probeMessagesAutomation
  };
}

function bannerLines(binary, version) {
  return [
    `Apple Tools MCP permissions (v${version})`,
    "=".repeat(60),
    `Probing node binary: ${binary.execPath}`,
    "This is process.execPath — the node that is running this command.",
    `Mini example:     ${binary.miniExample}`,
    `MacBook example:  ${binary.macbookExample}  (Claude nvm; not Homebrew)`,
    "Invoke this command with the product node so Allow dialogs attach to it.",
    "",
    "Open System Settings → Privacy & Security → Automation on this Mac.",
    "When macOS asks, click Allow for THIS node — not the MCP host app.",
    "Do not add node via + in the Contacts or Calendars privacy lists.",
    "dry_run of mail_send / messages_send does not count: this command uses real Apple Events.",
    "Nothing is sent to third parties. Mail composes and discards a temporary outgoing message.",
    "Messages only enumerates accounts. Contacts creates and deletes a throwaway person in-script.",
    "Calendar lists calendars only — no events are created."
  ];
}

/**
 * Run the four live probes and print a grant report.
 *
 * @param {object} [options]
 * @param {string} [options.execPath]
 * @param {string} [options.version]
 * @param {(msg: string) => void} [options.stdout]
 * @param {Record<string, () => object|Promise<object>>} [options.probes]
 * @param {() => { status: string, message: string }} [options.fdaProbe]
 * @returns {Promise<number>}
 */
export async function runPermissionsCommand({
  execPath = process.execPath,
  version = "",
  stdout = console.log,
  probes,
  fdaProbe = probeFullDiskAccess
} = {}) {
  const binary = describeProbeBinary(execPath);
  const probeFns = { ...defaultPermissionsProbes(), ...(probes || {}) };
  const log = (msg) => {
    stdout(msg);
  };

  for (const line of bannerLines(binary, version)) {
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
    log("Result: PASS — Contacts, Calendar, Mail, and Messages are granted for this node.");
    log("Safe to re-run; already-granted surfaces report OK without another click.");
  } else {
    log("Result: INCOMPLETE — one or more required grants are missing or errored.");
    log("Click Allow for the missing surfaces and re-run this command. Exit is non-zero (fail closed).");
  }
  return code;
}
