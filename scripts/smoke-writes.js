#!/usr/bin/env node
/**
 * Write-tool smoke test for QA prove-out on a Node host (Mac Mini / LaunchAgent).
 *
 * Default is a dry run: it reports what each step would do and changes
 * nothing. Pass --apply to actually perform the Contacts round trip
 * (create -> edit -> delete), which is the supported prove-out for the
 * AddressBook entitlement question: it must pass on the Node host, and it is
 * expected to fail under a host app that cannot hold Contacts access.
 *
 * Usage:
 *   node scripts/smoke-writes.js                # dry run, no changes
 *   node scripts/smoke-writes.js --apply        # real create/edit/delete
 *   node scripts/smoke-writes.js --apply --keep # create + edit, leave it behind
 *
 * The test contact is clearly named and removed again unless --keep is set.
 * No credentials, tokens, or personal data are involved.
 */

import { contactsAdd, contactsEdit, contactsRemove } from "../lib/contactsWrite.js";
import { loadContacts, getContactStats } from "../contacts.js";
import { probeSocket, defaultSocketPath } from "../lib/writeBridge.js";
import { isIndexerMode } from "../lib/processMode.js";

export function parseSmokeArgs(argv = []) {
  return {
    apply: argv.includes("--apply"),
    keep: argv.includes("--keep")
  };
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
  const { apply, keep } = parseSmokeArgs(process.argv.slice(2));
  const socketPath = defaultSocketPath();
  const bridgeUp = await probeSocket(socketPath);

  console.log("apple-tools-mcp write smoke test");
  console.log("=".repeat(60));
  line("Mode:", apply ? "APPLY (will change Contacts)" : "DRY RUN (no changes)");
  line("Process:", isIndexerMode() ? "indexer daemon" : "plain node / stdio");
  line("Write bridge:", bridgeUp ? `listening at ${socketPath}` : "not running (writes execute in this process)");
  console.log(
    "\nTCC note: macOS attributes this work to the process responsible for it.\n" +
    "Run this directly with node (or from the LaunchAgent) so node is responsible.\n" +
    "Contacts reads below use the AddressBook sqlite file + Full Disk Access;\n" +
    "the CRUD steps use Contacts.app, which is gated by the AddressBook privacy class."
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

  const created = step("contacts_add", contactsAdd({
    first_name: "ATM Smoke",
    last_name: `Test ${stamp}`,
    organization: "apple-tools-mcp smoke test",
    emails: [`atm-smoke-${stamp}@example.com`],
    ...common
  }));

  if (created.ok === false) {
    console.log("\nResult: FAILED at create. See the message above for the cause.");
    process.exitCode = 1;
    return;
  }

  const contactId = apply ? extractContactId(created.message) : null;
  if (apply && !contactId) {
    console.log("\nResult: create reported success but returned no contact id; stopping.");
    process.exitCode = 1;
    return;
  }

  const editArgs = apply
    ? { contact_id: contactId, job_title: "Smoke Tested", confirm: true }
    : { contact_id: "ABCD1234-SMOKE:ABPerson", job_title: "Smoke Tested", dry_run: true };
  const edited = step("contacts_edit", contactsEdit(editArgs));

  if (apply && !keep) {
    const removed = step("contacts_remove", contactsRemove({ contact_id: contactId, confirm: true }));
    if (removed.ok === false) {
      console.log(`\nResult: created ${contactId} but could not delete it. Remove it in Contacts.app.`);
      process.exitCode = 1;
      return;
    }
  } else if (apply && keep) {
    console.log(`\nLeft contact ${contactId} in place (--keep). Delete it when you are done.`);
  } else {
    step("contacts_remove", contactsRemove({ contact_id: "ABCD1234-SMOKE:ABPerson", dry_run: true }));
  }

  const failed = [created, edited].some((r) => r.ok === false);
  console.log(`\nResult: ${failed ? "FAILED" : apply ? "PASS - Contacts CRUD works on this host" : "PASS - dry run only, re-run with --apply to prove CRUD"}`);
  if (failed) process.exitCode = 1;
}

// Only run when invoked directly, so the helpers stay unit-testable.
if (process.argv[1] && process.argv[1].endsWith("smoke-writes.js")) {
  main().catch((e) => {
    console.error(`Smoke test error: ${e.message}`);
    process.exit(1);
  });
}
