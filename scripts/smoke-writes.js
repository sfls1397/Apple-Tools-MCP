#!/usr/bin/env node
/**
 * Write-tool smoke test for QA prove-out on a Node host (Mac Mini / LaunchAgent).
 *
 * Covers the Automation / privacy classes that gate this package's writes:
 * - Mail compose (Automation → Mail.app). dry_run never talks to Mail, so
 *   this step runs a real `make new outgoing message` (then discards it).
 *   A hang or timeout is TCC / Automation denied, not "Mail.app missing".
 * - Messages account/service lookup (Automation → Messages.app). Nothing
 *   is sent. A deny fails --apply the same way Mail does.
 * - Contacts CRUD (AddressBook class, via Contacts.app)
 * - Calendar CRUD (calendars class, via Calendar.app)
 *
 * Mail, Messages, Contacts, and Calendar must all pass on the Node host —
 * that is the ship gate. A missing grant for any one of those four apps
 * fails --apply. Contacts and Calendar CRUD are expected to fail under a
 * host app that holds neither entitlement - that is a documented host
 * limitation, not a package failure. Mail and Messages are separate Apple
 * Events targets: a Contacts/Calendar grant does not include them.
 *
 * Default is a dry run: no contact or event is created, edited, or deleted.
 * It is not a no-op, though: it reads contacts from the AddressBook database
 * and calls calendar_list_calendars, which is a live Calendar.app query and
 * therefore a real TCC touch that can prompt or be denied. A dry run treats
 * that listing as advisory, so a denial does not report a failure for a run
 * that changed nothing.
 *
 * Pass --apply to perform real create -> edit -> delete round trips.
 *
 * Usage:
 *   node scripts/smoke-writes.js                       # dry run, no changes
 *   node scripts/smoke-writes.js --apply               # real CRUD, cleans up
 *   node scripts/smoke-writes.js --apply --keep        # leaves the test items
 *   node scripts/smoke-writes.js --apply --calendar=Work
 *
 * Test items are clearly named and removed again unless --keep is set.
 * No credentials, tokens, or personal data are involved.
 */

import { loadContacts, getContactStats } from "../contacts.js";
import { probeSocket, defaultSocketPath } from "../lib/writeBridge.js";
import { dispatchWriteTool } from "../lib/writeTools.js";
import { probeMailAutomation } from "../lib/mailWrite.js";
import { probeMessagesAutomation } from "../lib/messagesWrite.js";
import { isIndexerMode } from "../lib/processMode.js";

export function parseSmokeArgs(argv = []) {
  const calendarArg = argv.find((a) => a.startsWith("--calendar="));
  return {
    apply: argv.includes("--apply"),
    keep: argv.includes("--keep"),
    allowLocal: argv.includes("--allow-local"),
    calendar: calendarArg ? calendarArg.slice("--calendar=".length) : null
  };
}

/**
 * Ship-gate precondition.
 *
 * The smoke test must exercise the same path production MCP clients use, so
 * a real run needs either the write bridge (writes execute inside the
 * launchd-started daemon, where node is the responsible process) or an
 * explicit acknowledgement that this process itself is the responsible one
 * - which is only true when a parent like Terminal.app or launchd started
 * it. Running in-process under a foreign parent (an embedded agent shell,
 * for example) produces an AppleScript denial that says nothing about
 * whether the package works.
 *
 * @returns {{ proceed: boolean, path: "daemon"|"local", reason: string }}
 */
export function resolveSmokePath({ apply, bridgeUp, allowLocal, indexerMode }) {
  if (bridgeUp) {
    return { proceed: true, path: "daemon", reason: "write bridge is listening; writes execute in the indexer daemon" };
  }
  if (indexerMode) {
    return { proceed: true, path: "local", reason: "this process is the indexer daemon" };
  }
  if (!apply) {
    return { proceed: true, path: "local", reason: "dry run; nothing is executed" };
  }
  if (allowLocal) {
    return { proceed: true, path: "local", reason: "--allow-local given; this process must be the responsible one" };
  }
  return {
    proceed: false,
    path: "local",
    reason:
      "no write bridge at the socket below and --apply was requested.\n" +
      "  The ship gate runs writes under launchd-owned node. Either:\n" +
      "    1. start the indexer LaunchAgent (apple-tools-indexer) so writes route through the bridge, or\n" +
      "    2. run this from Terminal.app, where node is the responsible process, and pass --allow-local.\n" +
      "  Executing in-process under another parent would only prove that parent's Automation rights,\n" +
      "  so this is refused rather than reported as a package failure."
  };
}

/**
 * Pull the "event_id: <id>" value out of a write tool success message.
 */
export function extractEventId(message) {
  const match = String(message || "").match(/event_id:\s*([A-Za-z0-9._:@+-]+)/);
  return match ? match[1] : null;
}

export function extractEventKitId(message) {
  const match = String(message || "").match(/eventkit_id:\s*([A-Za-z0-9._:@+/=-]+)/);
  return match ? match[1] : null;
}

/**
 * Prefer an On My Mac calendar so Calendar.app delete is reliable if EventKit
 * remove still misses. EventKit add/remove is the primary path on iCloud
 * (writeOnly can delete events it created). An explicit --calendar= wins.
 */
export function pickSmokeCalendar(calendars, explicitName) {
  if (explicitName) {
    return { name: explicitName, reason: `--calendar=${explicitName}` };
  }
  const writable = (calendars || []).filter((c) => c.writable);
  const local = writable.filter((c) => c.local);
  if (local[0]) {
    return { name: local[0].name, reason: "On My Mac (EventKit sourceType local)" };
  }
  if (writable[0]) {
    return { name: writable[0].name, reason: "first writable calendar (no local calendar listed)" };
  }
  return { name: "Calendar", reason: "fallback name Calendar" };
}

/**
 * Listing calendars is a live Calendar.app call even during a dry run, so a
 * refusal there says something about this host - but it is not a failure of
 * a run that created nothing. Only --apply, which must actually write,
 * treats it as fatal.
 *
 * @returns {"error"|"warning"}
 */
export function calendarListSeverity(apply) {
  return apply ? "error" : "warning";
}

/**
 * Mail compose is a live Apple Events call (dry_run of mail_send never
 * touches Mail). On --apply a deny fails the ship gate. On a dry run it is
 * advisory, like calendar_list_calendars, so a refused prompt is WARN.
 *
 * @returns {"error"|"warning"}
 */
export function mailProbeSeverity(apply) {
  return apply ? "error" : "warning";
}

export function messagesProbeSeverity(apply) {
  return mailProbeSeverity(apply);
}

/**
 * How smoke exercises Mail Apple Events.
 *
 * The compose-and-discard helper is smoke-script-only — not an MCP write
 * tool. On --apply with the write bridge up, also run public mail_draft so
 * launchd-owned node is fail-closed for Mail (same make new outgoing message
 * verb; nothing is sent).
 *
 * @returns {{ useLocalHelper: boolean, useMailDraft: boolean, reason: string }}
 */
export function planMailSmokeTouch({ apply, daemonPath }) {
  if (apply && daemonPath) {
    return {
      useLocalHelper: true,
      useMailDraft: true,
      reason: "local compose-and-discard helper plus mail_draft via the write bridge (live Mail Apple Events; nothing is sent)"
    };
  }
  return {
    useLocalHelper: true,
    useMailDraft: false,
    reason: "smoke-script compose-and-discard helper (live Mail Apple Events; nothing is sent). mail_send dry_run never touches Mail."
  };
}

/**
 * How smoke exercises Messages Apple Events.
 * Smoke-script-only helper; this gate never sends and is not an MCP tool.
 *
 * @returns {{ useLocalHelper: boolean, reason: string }}
 */
export function planMessagesSmokeTouch() {
  return {
    useLocalHelper: true,
    reason: "smoke-script Messages account lookup (live Apple Events; nothing is sent). messages_send dry_run never touches Messages."
  };
}

export function mailDraftSmokeArgs(stamp) {
  return {
    to: [`atm-mail-probe-${stamp}@example.com`],
    subject: `ATM Mail Automation probe ${stamp}`,
    body: "Created by apple-tools-mcp smoke test; safe to delete from Drafts."
  };
}

/**
 * A start/end pair well in the future, so a smoke event never collides with
 * anything real on the calendar.
 */
export function smokeEventWindow(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 400, 3, 0, 0, 0);
  const pad = (v) => String(v).padStart(2, "0");
  const fmt = (d, hour) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hour)}:00`;
  return { start: fmt(start, 3), end: fmt(start, 4) };
}

/**
 * Pull the "contact_id: <id>" value out of a write tool success message.
 */
export function extractContactId(message) {
  const match = String(message || "").match(/contact_id:\s*([A-Za-z0-9._:-]+)/);
  return match ? match[1] : null;
}

function line(label, value) {
  console.log(`${label.padEnd(22)} ${value}`);
}

function step(name, result, severity = "error") {
  const failed = result.ok === false;
  const status = failed ? (severity === "warning" ? "WARN" : "FAIL") : result.planned ? "PLANNED" : "OK";
  console.log(`\n[${status}] ${name}`);
  console.log(`  ${result.message}`);
  return result;
}

async function main() {
  const { apply, keep, calendar, allowLocal } = parseSmokeArgs(process.argv.slice(2));
  const socketPath = defaultSocketPath();
  const bridgeUp = await probeSocket(socketPath);
  const indexerMode = isIndexerMode();
  const route = resolveSmokePath({ apply, bridgeUp, allowLocal, indexerMode });

  console.log("apple-tools-mcp write smoke test");
  console.log("=".repeat(60));
  line("Mode:", apply
    ? "APPLY (will change Contacts and Calendar; Mail compose is live, nothing is sent)"
    : "DRY RUN (no creates, edits, or deletes)");
  line("Process:", indexerMode ? "indexer daemon" : "plain node / stdio");
  line("Write bridge:", bridgeUp ? `listening at ${socketPath}` : `not listening (${socketPath})`);
  line("Write path:", route.path === "daemon" ? "indexer daemon via write bridge" : "in this process");

  if (!route.proceed) {
    console.log(`\nRefusing to run: ${route.reason}`);
    process.exitCode = 2;
    return;
  }

  console.log(
    "\nTCC note: macOS attributes this work to the process responsible for it.\n" +
    "Contact reads use sqlite + Full Disk Access; the CRUD steps use Contacts.app\n" +
    "and Calendar.app, gated by the AddressBook and calendars privacy classes.\n" +
    "Mail compose is a separate Automation target (node → Mail.app). A hang or\n" +
    "timeout there is TCC / Automation denied, not Mail.app missing.\n" +
    `Writes take the same route production MCP clients take: ${route.reason}.`
  );
  if (!apply) {
    console.log(
      "Dry run: no creates, edits, or deletes for Contacts/Calendar. calendar_list_calendars\n" +
      "still runs for real - it is a live Calendar.app query and a TCC touch -\n" +
      "so a denial there is reported as a warning, not a failure.\n" +
      "The Mail step also runs for real (make new outgoing message) because mail_send\n" +
      "dry_run never touches Mail. A Mail deny is TCC / Automation denied; on a dry\n" +
      "run it is a warning, on --apply it fails the ship gate."
    );
  }

  // Every write goes through the production dispatcher, so the smoke test
  // proves the path clients actually use rather than a private shortcut.
  const run = (tool, args) => dispatchWriteTool(tool, args, { indexerMode, socketPath });

  // Read side first: proves Full Disk Access independently of the write path.
  console.log("\n--- Contacts read (sqlite + Full Disk Access) ---");
  const contacts = loadContacts();
  if (contacts.length === 0) {
    console.log("  No contacts loaded. If you expected some, this is a Full Disk Access /");
    console.log("  attribution problem on the responsible process, not the write entitlement.");
  } else {
    const stats = getContactStats();
    line("  Contacts loaded:", String(stats.total));
    line("  With unique ids:", String(contacts.filter((c) => c.uniqueId).length));
  }

  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const common = apply ? { confirm: true } : { dry_run: true };
  const results = [];

  // Mail first so first-run Allow includes Mail in the same pass as Contacts/Calendar.
  // Helpers are smoke-script-only — not MCP write tools. mail_send dry_run never talks to Mail.
  console.log("\n--- Mail Automation (Mail.app compose / Apple Events) ---");
  if (!apply) {
    console.log("  (live make new outgoing message even on a dry run; mail_send dry_run never touches Mail)");
  }

  const mailPlan = planMailSmokeTouch({ apply, daemonPath: route.path === "daemon" });
  const mailSeverity = mailProbeSeverity(apply);
  const mailHelperResult = probeMailAutomation();
  if (mailHelperResult.ok === false && mailSeverity === "warning") {
    step("mail Automation compose", mailHelperResult, "warning");
    console.log("  Warning only: mail_send dry_run never touches Mail. --apply fails closed if Mail Automation is still denied.");
  } else {
    results.push(step("mail Automation compose", mailHelperResult, mailSeverity));
  }
  if (mailPlan.useMailDraft) {
    console.log(`  ${mailPlan.reason}`);
    results.push(step("mail_draft (daemon Mail Automation)", await run("mail_draft", mailDraftSmokeArgs(stamp))));
  }

  console.log("\n--- Messages Automation (Messages.app accounts / Apple Events) ---");
  if (!apply) {
    console.log("  (live Messages account lookup even on a dry run; messages_send dry_run never touches Messages; nothing is sent)");
  }

  const messagesSeverity = messagesProbeSeverity(apply);
  const messagesResult = probeMessagesAutomation();

  if (messagesResult.ok === false && messagesSeverity === "warning") {
    step("messages Automation lookup", messagesResult, "warning");
    console.log("  Warning only: messages_send dry_run never touches Messages. --apply fails closed if Messages Automation is still denied.");
  } else {
    results.push(step("messages Automation lookup", messagesResult, messagesSeverity));
  }

  console.log("\n--- Contacts CRUD (Contacts.app / AddressBook privacy class) ---");
  const created = step("contacts_add", await run("contacts_add", {
    first_name: "ATM Smoke",
    last_name: `Test ${stamp}`,
    organization: "apple-tools-mcp smoke test",
    emails: [`atm-smoke-${stamp}@example.com`],
    ...common
  }));
  results.push(created);

  if (created.ok !== false) {
    const contactId = apply ? extractContactId(created.message) : "ABCD1234-SMOKE:ABPerson";
    if (apply && !contactId) {
      console.log("  contacts_add reported success but returned no contact id; skipping edit/delete.");
      results.push({ ok: false });
    } else {
      results.push(step("contacts_edit", await run("contacts_edit", {
        contact_id: contactId,
        job_title: "Smoke Tested",
        ...common
      })));

      if (apply && keep) {
        console.log(`  Left contact ${contactId} in place (--keep). Delete it when you are done.`);
      } else {
        const removed = step("contacts_remove", await run("contacts_remove", { contact_id: contactId, ...common }));
        results.push(removed);
        if (apply && removed.ok === false) {
          console.log(`  Created ${contactId} but could not delete it. Remove it in Contacts.app.`);
        }
      }
    }
  }

  // ---- Calendar: the other entitlement-gated write path ----
  console.log("\n--- Calendar CRUD (Calendar.app / calendars privacy class) ---");
  if (!apply) {
    console.log("  (live Calendar.app query even on a dry run)");
  }
  const listSeverity = calendarListSeverity(apply);
  const calendars = step("calendar_list_calendars", await run("calendar_list_calendars", {}), listSeverity);
  if (calendars.ok === false && listSeverity === "warning") {
    console.log("  Warning only: the dry run changed nothing, so a refused listing is not a failure.");
  } else {
    results.push(calendars);
  }

  const writable = (calendars.calendars || []).filter((c) => c.writable);
  const picked = pickSmokeCalendar(calendars.calendars || [], calendar);
  const targetCalendar = picked.name;
  if (calendar && writable.length > 0 && !writable.some((c) => c.name === calendar)) {
    console.log(`  Warning: --calendar=${calendar} is not in the writable list; trying it anyway.`);
  }
  line("  Target calendar:", `${targetCalendar} (${picked.reason})`);

  const window = smokeEventWindow();
  const eventCreated = step("calendar_add", await run("calendar_add", {
    calendar_name: targetCalendar,
    title: `ATM smoke test ${stamp}`,
    start: window.start,
    end: window.end,
    notes: "Created by apple-tools-mcp smoke test; safe to delete.",
    alerts_minutes_before: [10],
    ...common
  }));
  results.push(eventCreated);

  if (eventCreated.ok !== false) {
    const eventId = apply ? extractEventId(eventCreated.message) : "ATM-SMOKE-EVENT-UID";
    const eventKitId = apply ? extractEventKitId(eventCreated.message) : null;
    if (apply && !eventId) {
      console.log("  calendar_add reported success but returned no event id; skipping edit/delete.");
      results.push({ ok: false });
    } else {
      results.push(step("calendar_edit", await run("calendar_edit", {
        event_id: eventId,
        title: `ATM smoke test ${stamp} (edited)`,
        ...common
      })));

      if (apply && keep) {
        console.log(`  Left event ${eventId} in place (--keep). Delete it when you are done.`);
      } else {
        const removed = step("calendar_remove", await run("calendar_remove", {
          event_id: eventId,
          eventkit_id: eventKitId || undefined,
          calendar_name: targetCalendar,
          ...common
        }));
        results.push(removed);
        if (apply && removed.ok === false) {
          console.log(`  Created ${eventId} on ${targetCalendar} but could not delete it.`);
          console.log("  add/edit succeeded, so this is a delete-path failure, not missing Calendar Automation.");
          console.log("  Same write-bridge RPC as add/edit; Calendar.app has no remove/move-to-trash (delete + EventKit fallback).");
          if (removed.diagnostics) {
            console.log(`  ${removed.diagnostics}`);
          } else {
            const rawLine = String(removed.message || "").match(/osascript kind=\S+ error=.*/);
            if (rawLine) console.log(`  ${rawLine[0]}`);
          }
          console.log("  Paste the osascript kind=/error= line if asking for another tip.");
          console.log("  Remove the leftover event in Calendar.app.");
        }
      }
    }
  }

  const failed = results.some((r) => r && r.ok === false);
  console.log("\n" + "=".repeat(60));
  if (failed) {
    console.log("Result: FAILED - see the messages above.");
    if (route.path === "local") {
      console.log("These writes ran in this process, so the failure describes this process's");
      console.log("Automation rights. Start the indexer LaunchAgent and re-run to test the");
      console.log("shipping path, where writes execute under launchd-owned node.");
    } else {
      console.log("These writes ran inside the indexer daemon, so this is a real gate failure:");
      console.log("grant the daemon's node binary Full Disk Access (reads) and Allow node in");
      console.log("System Settings > Privacy & Security > Automation for Mail.app, Messages.app,");
      console.log("Contacts.app, and Calendar.app. A hang or timeout on Mail compose is TCC /");
      console.log("Automation denied, not Mail.app missing. Do not add node via + in the");
      console.log("Contacts or Calendars privacy lists.");
    }
    process.exitCode = 1;
  } else if (apply) {
    console.log(`Result: PASS - Mail, Messages, Contacts, and Calendar Automation all work (${route.path === "daemon" ? "via the write bridge" : "in this process"}).`);
  } else {
    console.log("Result: PASS - dry run only. Re-run with --apply to prove real CRUD and fail-closed Mail/Messages/Contacts/Calendar Automation.");
  }
}

// Only run when invoked directly, so the helpers stay unit-testable.
if (process.argv[1] && process.argv[1].endsWith("smoke-writes.js")) {
  main().catch((e) => {
    console.error(`Smoke test error: ${e.message}`);
    process.exit(1);
  });
}
