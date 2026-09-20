/**
 * Contacts write operations: add, edit, remove.
 *
 * Contacts are addressed by their AddressBook unique id (Contacts.app's
 * `id`, for example "ABCD1234-...:ABPerson"), which `contacts_search` and
 * `contacts_lookup` report as "Contact ID" and `contacts_add` returns.
 *
 * Writes go through Contacts.app rather than the AddressBook sqlite file:
 * writing that database directly corrupts iCloud sync.
 */

import { runAppleScript, asString, CONTACTS_TCC_GUIDANCE, ATTRIBUTION_GUIDANCE } from "./appleScript.js";
import {
  planWrite,
  normalizeList,
  isEmailAddress,
  isPhoneNumber,
  validateContactId,
  validateSubject,
  validateLabel,
  writeErrorMessage,
  writeSuccessMessage,
  isFlagTrue,
  truncate
} from "./writeGuards.js";

const MAX_VALUES_PER_FIELD = 10;

function validateContactEmails(value, label) {
  const emails = normalizeList(value);
  if (emails.length > MAX_VALUES_PER_FIELD) {
    return { emails: [], error: `at most ${MAX_VALUES_PER_FIELD} email addresses per contact` };
  }
  const bad = emails.filter((e) => !isEmailAddress(e));
  if (bad.length > 0) {
    return { emails: [], error: `invalid email address(es): ${bad.map((e) => truncate(e, 40)).join(", ")}` };
  }
  const resolvedLabel = validateLabel(label, "work");
  if (!resolvedLabel) return { emails: [], error: "email_label must be letters and spaces only" };
  return { emails: emails.map((email) => ({ value: email, label: resolvedLabel })), error: null };
}

function validateContactPhones(value, label) {
  const phones = normalizeList(value);
  if (phones.length > MAX_VALUES_PER_FIELD) {
    return { phones: [], error: `at most ${MAX_VALUES_PER_FIELD} phone numbers per contact` };
  }
  const bad = phones.filter((p) => !isPhoneNumber(p));
  if (bad.length > 0) {
    return { phones: [], error: `invalid phone number(s): ${bad.map((p) => truncate(p, 40)).join(", ")}` };
  }
  const resolvedLabel = validateLabel(label, "mobile");
  if (!resolvedLabel) return { phones: [], error: "phone_label must be letters and spaces only" };
  return { phones: phones.map((phone) => ({ value: phone, label: resolvedLabel })), error: null };
}

function findPersonHandler() {
  return `on atmFindPerson(theId)
  tell application "Contacts"
    try
      return person id theId
    end try
    try
      set hits to (every person whose id is theId)
      if (count of hits) > 0 then return item 1 of hits
    end try
  end tell
  error "CONTACT_NOT_FOUND"
end atmFindPerson`;
}

function childLines(items, kind, personVar) {
  return items
    .map((item) => `  make new ${kind} at end of ${kind}s of ${personVar} with properties {label:${asString(item.label)}, value:${asString(item.value)}}`)
    .join("\n");
}

function failure(action, summary, result, secrets = []) {
  if (result.kind === "tcc" || result.kind === "timeout") {
    return `${action} failed — attempted to ${summary}. ${CONTACTS_TCC_GUIDANCE}`;
  }
  const raw = String(result.error || "");
  if (raw.includes("CONTACT_NOT_FOUND")) {
    return `${action} failed — attempted to ${summary}. No contact with that id was found; use the Contact ID from contacts_search or contacts_lookup.`;
  }
  if (result.kind === "attribution") {
    return `${action} failed — attempted to ${summary}. ${ATTRIBUTION_GUIDANCE}`;
  }
  if (result.kind === "app_unavailable") {
    return `${action} failed — attempted to ${summary}. Contacts.app could not be reached on this host.`;
  }
  return writeErrorMessage(action, summary, new Error(raw || "unknown error"), secrets);
}

export function buildAddContactScript({ properties, emails, phones }) {
  const props = Object.entries(properties)
    .map(([key, value]) => `${key}:${asString(value)}`)
    .join(", ");

  return `tell application "Contacts"
  set newPerson to make new person with properties {${props}}
${emails.length ? `${childLines(emails, "email", "newPerson")}\n` : ""}${phones.length ? `${childLines(phones, "phone", "newPerson")}\n` : ""}  save
  set newId to id of newPerson
end tell
return newId`;
}

export function contactsAdd(args = {}) {
  const action = "contacts_add";

  const firstName = validateSubject(args.first_name);
  if (firstName.error) return { ok: false, message: `${action} refused: ${firstName.error.replace("subject", "first_name")}` };
  const lastName = validateSubject(args.last_name);
  if (lastName.error) return { ok: false, message: `${action} refused: ${lastName.error.replace("subject", "last_name")}` };
  const organization = validateSubject(args.organization);
  if (organization.error) return { ok: false, message: `${action} refused: ${organization.error.replace("subject", "organization")}` };
  const jobTitle = validateSubject(args.job_title);
  if (jobTitle.error) return { ok: false, message: `${action} refused: ${jobTitle.error.replace("subject", "job_title")}` };

  if (!firstName.text && !lastName.text && !organization.text) {
    return { ok: false, message: `${action} refused: provide at least first_name, last_name, or organization.` };
  }

  const emails = validateContactEmails(args.emails, args.email_label);
  if (emails.error) return { ok: false, message: `${action} refused: ${emails.error}` };
  const phones = validateContactPhones(args.phones, args.phone_label);
  if (phones.error) return { ok: false, message: `${action} refused: ${phones.error}` };

  const displayName = [firstName.text, lastName.text].filter(Boolean).join(" ") || organization.text;
  const summary = `create contact "${truncate(displayName, 100)}"` +
    `${emails.emails.length ? ` with ${emails.emails.length} email(s)` : ""}` +
    `${phones.phones.length ? ` and ${phones.phones.length} phone number(s)` : ""}`;

  const plan = planWrite({ action, summary, dryRun: isFlagTrue(args.dry_run), confirm: isFlagTrue(args.confirm) });
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

  const properties = {};
  if (firstName.text) properties["first name"] = firstName.text;
  if (lastName.text) properties["last name"] = lastName.text;
  if (organization.text) properties.organization = organization.text;
  if (jobTitle.text) properties["job title"] = jobTitle.text;

  const result = runAppleScript(
    buildAddContactScript({ properties, emails: emails.emails, phones: phones.phones }),
    { timeout: 60000, appName: "Contacts" }
  );
  if (!result.ok) return { ok: false, message: failure(action, summary, result) };

  return {
    ok: true,
    message: writeSuccessMessage(action, "contact created", {
      contact_id: result.output,
      name: displayName,
      emails: emails.emails.map((e) => e.value).join(", ") || undefined,
      phones: phones.phones.map((p) => p.value).join(", ") || undefined
    })
  };
}

export function buildEditContactScript({ contactId, properties, emails, phones, replaceEmails, replacePhones }) {
  const lines = Object.entries(properties).map(([key, value]) => `  set ${key} of thePerson to ${asString(value)}`);
  if (replaceEmails) {
    lines.push(`  try
    delete every email of thePerson
  end try`);
  }
  if (replacePhones) {
    lines.push(`  try
    delete every phone of thePerson
  end try`);
  }

  return `${findPersonHandler()}

set thePerson to atmFindPerson(${asString(contactId)})
tell application "Contacts"
${lines.join("\n")}
${emails.length ? `${childLines(emails, "email", "thePerson")}\n` : ""}${phones.length ? `${childLines(phones, "phone", "thePerson")}\n` : ""}  save
  set editedName to name of thePerson
end tell
return editedName`;
}

export function contactsEdit(args = {}) {
  const action = "contacts_edit";

  const contactId = validateContactId(args.contact_id);
  if (!contactId) {
    return { ok: false, message: `${action} refused: contact_id is required (the "Contact ID" from contacts_search or contacts_lookup). This tool will not guess which contact you meant.` };
  }

  const properties = {};
  const changed = [];

  const fieldMap = {
    first_name: "first name",
    last_name: "last name",
    organization: "organization",
    job_title: "job title"
  };
  for (const [arg, applescriptProp] of Object.entries(fieldMap)) {
    if (args[arg] === undefined) continue;
    const validated = validateSubject(args[arg]);
    if (validated.error) return { ok: false, message: `${action} refused: ${validated.error.replace("subject", arg)}` };
    properties[applescriptProp] = validated.text;
    changed.push(arg);
  }

  const emails = validateContactEmails(args.emails, args.email_label);
  if (emails.error) return { ok: false, message: `${action} refused: ${emails.error}` };
  const phones = validateContactPhones(args.phones, args.phone_label);
  if (phones.error) return { ok: false, message: `${action} refused: ${phones.error}` };

  const replaceEmails = isFlagTrue(args.replace_emails);
  const replacePhones = isFlagTrue(args.replace_phones);
  if (emails.emails.length) changed.push(`${replaceEmails ? "replace" : "add"} ${emails.emails.length} email(s)`);
  if (phones.phones.length) changed.push(`${replacePhones ? "replace" : "add"} ${phones.phones.length} phone(s)`);
  if (replaceEmails && emails.emails.length === 0) changed.push("remove all emails");
  if (replacePhones && phones.phones.length === 0) changed.push("remove all phones");

  if (changed.length === 0) {
    return { ok: false, message: `${action} refused: nothing to change. Pass at least one of first_name, last_name, organization, job_title, emails, phones.` };
  }

  const summary = `update contact ${contactId}: ${changed.join(", ")}`;
  // Dropping every email or phone is destructive, so it needs confirmation.
  const destructive = (replaceEmails && emails.emails.length === 0) || (replacePhones && phones.phones.length === 0);
  const plan = planWrite({
    action,
    summary,
    destructive,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

  const result = runAppleScript(
    buildEditContactScript({
      contactId,
      properties,
      emails: emails.emails,
      phones: phones.phones,
      replaceEmails,
      replacePhones
    }),
    { timeout: 60000, appName: "Contacts" }
  );
  if (!result.ok) return { ok: false, message: failure(action, summary, result) };

  return {
    ok: true,
    message: writeSuccessMessage(action, "contact updated", {
      contact_id: contactId,
      name: truncate(result.output, 120) || undefined,
      changed: changed.join(", ")
    })
  };
}

export function buildRemoveContactScript(contactId) {
  return `${findPersonHandler()}

set thePerson to atmFindPerson(${asString(contactId)})
tell application "Contacts"
  set removedName to name of thePerson
  delete thePerson
  save
end tell
return removedName`;
}

export function contactsRemove(args = {}) {
  const action = "contacts_remove";

  const contactId = validateContactId(args.contact_id);
  if (!contactId) {
    return { ok: false, message: `${action} refused: contact_id is required (the "Contact ID" from contacts_search or contacts_lookup). Deletes never run on a guessed id.` };
  }

  const summary = `delete contact ${contactId}`;
  const plan = planWrite({
    action,
    summary,
    destructive: true,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

  const result = runAppleScript(buildRemoveContactScript(contactId), { timeout: 60000, appName: "Contacts" });
  if (!result.ok) return { ok: false, message: failure(action, summary, result) };

  return {
    ok: true,
    message: writeSuccessMessage(action, "contact deleted", {
      contact_id: contactId,
      name: truncate(result.output, 120) || undefined
    })
  };
}

/**
 * First-run / upgrade probe: the Contacts write verb that triggers
 * Automation → Contacts. Creates a clearly named throwaway person and
 * deletes it in the same script so a completed run leaves no junk.
 */
export const CONTACTS_AUTOMATION_PROBE_FIRST = "ATM";
export const CONTACTS_AUTOMATION_PROBE_LAST = "Permissions Probe";

export function buildContactsAutomationProbeScript() {
  return `tell application "Contacts"
  set probe to make new person with properties {first name:${asString(CONTACTS_AUTOMATION_PROBE_FIRST)}, last name:${asString(CONTACTS_AUTOMATION_PROBE_LAST)}}
  delete probe
  save
end tell
return "OK"`;
}

export function buildContactsProbeCleanupScript() {
  return `tell application "Contacts"
  set leftovers to (every person whose first name is ${asString(CONTACTS_AUTOMATION_PROBE_FIRST)} and last name is ${asString(CONTACTS_AUTOMATION_PROBE_LAST)})
  repeat with p in leftovers
    delete p
  end repeat
  save
end tell
return "OK"`;
}

/**
 * Live Contacts Apple Events check. Not a dry_run.
 * @returns {{ ok: boolean, message: string, kind: string|null }}
 */
export function probeContactsAutomation() {
  const action = "contacts_automation_probe";
  const summary = "create and delete a throwaway Contacts person (Automation / AddressBook check)";
  const result = runAppleScript(buildContactsAutomationProbeScript(), { timeout: 60000, appName: "Contacts" });
  // Best-effort cleanup if the probe created the person then failed mid-script.
  runAppleScript(buildContactsProbeCleanupScript(), { timeout: 30000, appName: "Contacts" });
  if (!result.ok) {
    return { ok: false, message: failure(action, summary, result), kind: result.kind };
  }
  return {
    ok: true,
    kind: null,
    message: writeSuccessMessage(
      action,
      "Contacts Automation allowed (created and deleted a throwaway contact)"
    )
  };
}
