#!/usr/bin/env node
/**
 * Write-tool smoke test for QA prove-out on a Node host (Mac Mini / LaunchAgent).
 *
 * Covers both privacy classes that gate this package's writes:
 * - Contacts CRUD (AddressBook class, via Contacts.app)
 * - Calendar CRUD (calendars class, via Calendar.app)
 *
 * Both must pass on the Node host, which is the ship gate. Both are expected
 * to fail under a host app that holds neither entitlement - that is a
 * documented host limitation, not a package failure.
 *
 * Default is a dry run: it reports what each step would do and changes
 * nothing. Pass --apply to perform real create -> edit -> delete round trips.
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

import { contactsAdd, contactsEdit, contactsRemove } from "../lib/contactsWrite.js";
import { calendarListCalendars, calendarAdd, calendarEdit, calendarRemove } from "../lib/calendarWrite.js";
import { loadContacts, getContactStats } from "../contacts.js";
import { probeSocket, defaultSocketPath } from "../lib/writeBridge.js";
import { isIndexerMode } from "../lib/processMode.js";

export function parseSmokeArgs(argv = []) {
  const calendarArg = argv.find((a) => a.startsWith("--calendar="));
  return {
    apply: argv.includes("--apply"),
    keep: argv.includes("--keep"),
    calendar: calendarArg ? calendarArg.slice("--calendar=".length) : null
  };
}

/**
 * Pull the "event_id: <id>" value out of a write tool success message.
 */
export function extractEventId(message) {
  const match = String(message || "").match(/event_id:\s*([A-Za-z0-9._:@+-]+)/);
  return match ? match[1] : null;
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

function step(name, result) {
  const status = result.ok === false ? "FAIL" : result.planned ? "PLANNED" : "OK";
  console.log(`\n[${status}] ${name}`);
  console.log(`  ${result.message}`);
  return result;
}

async function main() {
  const { apply, keep, calendar } = parseSmokeArgs(process.argv.slice(2));
  const socketPath = defaultSocketPath();
  const bridgeUp = await probeSocket(socketPath);

  console.log("apple-tools-mcp write smoke test");
  console.log("=".repeat(60));
  line("Mode:", apply ? "APPLY (will change Contacts and Calendar)" : "DRY RUN (no changes)");
  line("Process:", isIndexerMode() ? "indexer daemon" : "plain node / stdio");
  line("Write bridge:", bridgeUp ? `listening at ${socketPath}` : "not running (writes execute in this process)");
  console.log(
    "\nTCC note: macOS attributes this work to the process responsible for it.\n" +
    "Run this directly with node (or from the LaunchAgent) so node is responsible.\n" +
    "Reads below use sqlite + Full Disk Access; the CRUD steps use Contacts.app\n" +
    "and Calendar.app, gated by the AddressBook and calendars privacy classes."
  );

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

  console.log("\n--- Contacts CRUD (Contacts.app / AddressBook privacy class) ---");
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const common = apply ? { confirm: true } : { dry_run: true };

  const results = [];

  const created = step("contacts_add", contactsAdd({
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
      results.push(step("contacts_edit", contactsEdit({
        contact_id: contactId,
        job_title: "Smoke Tested",
        ...common
      })));

      if (apply && keep) {
        console.log(`  Left contact ${contactId} in place (--keep). Delete it when you are done.`);
      } else {
        const removed = step("contacts_remove", contactsRemove({
          contact_id: contactId,
          ...(apply ? { confirm: true } : { dry_run: true })
        }));
        results.push(removed);
        if (apply && removed.ok === false) {
          console.log(`  Created ${contactId} but could not delete it. Remove it in Contacts.app.`);
        }
      }
    }
  }

  // ---- Calendar: the other entitlement-gated write path ----
  console.log("\n--- Calendar CRUD (Calendar.app / calendars privacy class) ---");
  const calendars = step("calendar_list_calendars", calendarListCalendars());
  results.push(calendars);

  const writable = (calendars.calendars || []).filter((c) => c.writable);
  const targetCalendar = calendar || (writable[0] && writable[0].name) || "Calendar";
  if (calendar && !writable.some((c) => c.name === calendar) && calendars.ok !== false) {
    console.log(`  Warning: --calendar=${calendar} is not in the writable list; trying it anyway.`);
  }
  line("  Target calendar:", targetCalendar);

  const window = smokeEventWindow();
  const eventCreated = step("calendar_add", calendarAdd({
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
    if (apply && !eventId) {
      console.log("  calendar_add reported success but returned no event id; skipping edit/delete.");
      results.push({ ok: false });
    } else {
      results.push(step("calendar_edit", calendarEdit({
        event_id: eventId,
        title: `ATM smoke test ${stamp} (edited)`,
        ...common
      })));

      if (apply && keep) {
        console.log(`  Left event ${eventId} in place (--keep). Delete it when you are done.`);
      } else {
        const removed = step("calendar_remove", calendarRemove({
          event_id: eventId,
          ...(apply ? { confirm: true } : { dry_run: true })
        }));
        results.push(removed);
        if (apply && removed.ok === false) {
          console.log(`  Created ${eventId} but could not delete it. Remove it in Calendar.app.`);
        }
      }
    }
  }

  const failed = results.some((r) => r && r.ok === false);
  console.log("\n" + "=".repeat(60));
  if (failed) {
    console.log("Result: FAILED — see the messages above.");
    console.log("A denial naming the AddressBook or calendars privacy class means the");
    console.log("responsible process cannot hold that entitlement. Run this on the Node");
    console.log("host (or start the indexer daemon) rather than under a host app.");
    process.exitCode = 1;
  } else if (apply) {
    console.log("Result: PASS — Contacts and Calendar CRUD both work on this host.");
  } else {
    console.log("Result: PASS — dry run only. Re-run with --apply to prove real CRUD.");
  }
}

// Only run when invoked directly, so the helpers stay unit-testable.
if (process.argv[1] && process.argv[1].endsWith("smoke-writes.js")) {
  main().catch((e) => {
    console.error(`Smoke test error: ${e.message}`);
    process.exit(1);
  });
}
