import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { getAppleToolsDir } from "./config.js";

export const FINGERPRINT_ALGORITHM = "sha256-mail-content-v1";
export const RECONCILIATION_VERSION = 1;
const digest = value => createHash("sha256").update(value).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const codePattern = /^[a-z][a-z0-9_-]{0,63}$/;
const bindingFields = ["claim_id", "attempt", "revision", "fingerprint_algorithm", "fingerprint"];
const refusals = new Set(["identity_refused", "legacy_ineligible", "active_writer_refused", "evidence_refused", "authorization_refused", "durability_refused", "revision_refused", "outcome_conflict"]);
const reasonCodes = new Set(["operator_verified_sent", "operator_verified_not_sent"]);

export const mailRecordHash = value => digest(JSON.stringify(value));

export function mailFingerprint(args) {
  const addresses = values => Array.isArray(values) ? values.map(value => String(value).trim().toLowerCase()).sort() : values;
  return digest(JSON.stringify([addresses(args.to), addresses(args.cc || []), addresses(args.bcc || []), args.subject, args.body, args.body_format || "plain"]));
}

export function mailClaimId(fingerprint, key) {
  return digest(key === undefined ? fingerprint : `key:${key}`);
}

export function mailOutcome(code, { ok = false, entry = "none", historical = "unknown", ...fields } = {}) {
  return {
    ok,
    sendStarted: entry === "entered" ? true : entry === "unknown" ? undefined : false,
    unconfirmed: ["pending_suppressed", "transport_unresolved", "bridge_uncertain", "active_writer_refused", "durability_refused"].includes(code),
    message: `mail_send: ${code}. No automatic retry or ledger update is authorized.`,
    mail_send: { schema_version: 1, code, current_invocation_transport: entry, historical_effects: historical, ledger_action: "none", retry_authorized: false, ...fields }
  };
}

export function refuse(code) {
  const error = new Error(refusals.has(code) ? code : "durability_refused");
  error.mailCode = error.message;
  throw error;
}

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) refuse("durability_refused");
}

function readJson(file) {
  regularFile(file);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function syncDirectory(directory, io = fs) {
  const descriptor = io.openSync(directory, "r");
  try { io.fsyncSync(descriptor); } finally { io.closeSync(descriptor); }
}

export function durableCreate(file, value, io = fs) {
  const descriptor = io.openSync(file, "wx", 0o600);
  try {
    io.writeFileSync(descriptor, JSON.stringify(value));
    io.fsyncSync(descriptor);
  } finally { io.closeSync(descriptor); }
  syncDirectory(path.dirname(file), io);
}

export function withMailWriterLock(directory, work) {
  const missing = [];
  for (let current = directory; !fs.existsSync(current); current = path.dirname(current)) missing.push(current);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const created of missing) syncDirectory(path.dirname(created));
  const lock = path.join(directory, ".writer-lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { refuse("active_writer_refused"); }
  try {
    const result = work();
    fs.rmdirSync(lock);
    return result;
  } catch (error) {
    if (error.mailCode && error.mailCode !== "durability_refused") fs.rmdirSync(lock);
    throw error;
  }
}

export function claimBinding(claim) {
  return Object.fromEntries(bindingFields.map(field => [field, claim[field]]));
}

function sameBinding(left, right) {
  return bindingFields.every(field => left[field] === right[field]);
}

function validateBinding(value) {
  if (!value || !hashPattern.test(value.claim_id) || !hashPattern.test(value.fingerprint) || value.fingerprint_algorithm !== FINGERPRINT_ALGORITHM ||
      !Number.isSafeInteger(value.attempt) || value.attempt < 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) refuse("identity_refused");
}

export function readMailClaim(directory, id, attempt) {
  if (!hashPattern.test(id) || !Number.isSafeInteger(attempt) || attempt < 1) refuse("identity_refused");
  const claimDirectory = path.join(directory, id);
  if (!fs.existsSync(path.join(claimDirectory, `${attempt}.json`))) refuse("identity_refused");
  const stat = fs.lstatSync(claimDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("identity_refused");
  const claim = readJson(path.join(claimDirectory, `${attempt}.json`));
  if (claim.protocol_version === undefined) return { ...claim, legacy: true };
  if (claim.protocol_version !== 1) refuse("identity_refused");
  validateBinding(claim);
  const { integrity_hash: initialHash, ...initialPayload } = claim;
  if (initialHash !== mailRecordHash(initialPayload) || !Number.isSafeInteger(claim.createdAt) || claim.createdAt < 0 ||
      claim.claim_id !== id || claim.attempt !== attempt || claim.revision !== 1 || claim.state !== "pending") refuse("identity_refused");
  let state = { ...claim, record_hash: digest(JSON.stringify(claim)) };
  const initialDescriptor = fs.openSync(path.join(claimDirectory, `${attempt}.json`), "r");
  try { fs.fsyncSync(initialDescriptor); } finally { fs.closeSync(initialDescriptor); }
  syncDirectory(claimDirectory);
  syncDirectory(directory);
  const journal = path.join(claimDirectory, `${attempt}.events`);
  if (!fs.existsSync(journal)) return state;
  const journalStat = fs.lstatSync(journal);
  if (!journalStat.isDirectory() || journalStat.isSymbolicLink()) refuse("durability_refused");
  const names = fs.readdirSync(journal).sort((left, right) => Number(left.slice(0, -5)) - Number(right.slice(0, -5)));
  for (let index = 0; index < names.length; index++) {
    if (names[index] !== `${index + 2}.json`) refuse("durability_refused");
    const event = readJson(path.join(journal, names[index]));
    const { integrity_hash: eventHash, ...eventPayload } = event;
    if (eventHash !== mailRecordHash(eventPayload) || event.schema_version !== 1 || event.revision !== state.revision + 1 || event.previous_hash !== state.record_hash ||
        event.claim_id !== id || event.attempt !== attempt || event.fingerprint !== claim.fingerprint || event.fingerprint_algorithm !== claim.fingerprint_algorithm ||
        !["done", "not_started", "not_sent"].includes(event.state) || state.state !== "pending") refuse("durability_refused");
    state = { ...claim, ...event, record_hash: digest(JSON.stringify(event)) };
    const descriptor = fs.openSync(path.join(journal, names[index]), "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  syncDirectory(journal);
  syncDirectory(claimDirectory);
  return state;
}

export function appendMailOutcome(directory, claim, metadata, io = fs) {
  const journal = path.join(directory, claim.claim_id, `${claim.attempt}.events`);
  io.mkdirSync(journal, { recursive: true, mode: 0o700 });
  syncDirectory(path.dirname(journal), io);
  const event = {
    schema_version: 1, ...claimBinding(claim), revision: claim.revision + 1,
    previous_hash: claim.record_hash, ...metadata
  };
  event.integrity_hash = mailRecordHash(event);
  durableCreate(path.join(journal, `${event.revision}.json`), event, io);
  return { ...claim, ...event, record_hash: digest(JSON.stringify(event)) };
}

const defaultAuthorityRoot = "/Library/Application Support/AppleTools/Reconciliation";

function assertProtected(file, directory = false) {
  let current = path.resolve(file);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 ||
        (current === path.resolve(file) && (directory ? !stat.isDirectory() : !stat.isFile()))) refuse("evidence_refused");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function protectedMailAuthority(root = defaultAuthorityRoot) {
  return {
    load(kind, reference) {
      if (!["deployment", "approval", "evidence", "authorization"].includes(kind) || !hashPattern.test(reference)) refuse("evidence_refused");
      try {
        assertProtected(root, true);
        const file = path.join(root, kind, `${reference}.json`);
        assertProtected(file);
        regularFile(file);
        const revocationsFile = path.join(root, "revocations.json");
        assertProtected(revocationsFile);
        const revocations = readJson(revocationsFile);
        const raw = fs.readFileSync(file, "utf8");
        if (raw.length > 65536 || digest(raw) !== reference || revocations.schema_version !== 1 || !Array.isArray(revocations.references) ||
            revocations.references.some(value => !hashPattern.test(value)) || !Array.isArray(revocations.ids) || revocations.ids.some(value => !hashPattern.test(value))) refuse("evidence_refused");
        const record = JSON.parse(raw);
        if (revocations.references.includes(reference) || revocations.ids.includes(record.id)) refuse("evidence_refused");
        return record;
      } catch { refuse("evidence_refused"); }
    }
  };
}

function fresh(record, now, maximumAge = 60000) {
  if (!record || record.schema_version !== 1 || !Number.isSafeInteger(record.issued_at) || !Number.isSafeInteger(record.expires_at) ||
      record.issued_at > now || now - record.issued_at > maximumAge || record.expires_at <= now || record.expires_at - record.issued_at > maximumAge || record.revoked !== false) refuse("evidence_refused");
}

function deploymentProof(authority, reference, now) {
  const record = authority.load("deployment", reference);
  fresh(record, now);
  const required = ["daemon", "local_fallback", "accepted_bridge", "scripts_appleevents", "old_processes", "outstanding_effects"];
  if (record.kind !== "deployment" || !codePattern.test(record.epoch) || !Array.isArray(record.accounts) || !record.accounts.length ||
      record.accounts.some(account => !hashPattern.test(account)) || new Set(record.accounts).size !== record.accounts.length ||
      !Array.isArray(record.operators) || !record.operators.length || record.operators.some(operator => !codePattern.test(operator)) ||
      required.some(writer => record.excluded?.[writer] !== true) || record.nonparticipating_launch_disabled !== true || record.clock_uncertainty_ms !== 0) refuse("active_writer_refused");
  return record;
}

function approvalProof(authority, reference, kind, target, deployment, now) {
  const record = authority.load(kind === "retry" ? "authorization" : "approval", reference);
  fresh(record, now);
  if (record.kind !== kind || !sameBinding(record, target) || !codePattern.test(record.operator) ||
      !deployment.operators.includes(record.operator) || record.epoch !== deployment.epoch || !hashPattern.test(record.id)) refuse("authorization_refused");
  return record;
}

export function mailAttempts(directory, id) {
  const names = fs.readdirSync(path.join(directory, id)).filter(name => name.endsWith(".json"));
  if (names.some(name => !/^[1-9]\d*\.json$/.test(name) || !Number.isSafeInteger(Number(name.slice(0, -5))))) refuse("identity_refused");
  return names.map(name => Number(name.slice(0, -5)));
}

function latestAttempt(directory, id) {
  const names = mailAttempts(directory, id);
  return names.length ? Math.max(...names) : 0;
}

export function reconciliationFencePath(directory) {
  return path.join(directory, ".reconciliation-fence.json");
}

export function fencedMailWrite(run, { directory = path.join(getAppleToolsDir(), "mail-send-claims") } = {}) {
  try {
    return withMailWriterLock(directory, () => fs.existsSync(reconciliationFencePath(directory)) ? mailOutcome("active_writer_refused") : run());
  } catch (error) { return mailOutcome(error.mailCode || "durability_refused"); }
}

export function mailSendReconcile(args, {
  directory = path.join(getAppleToolsDir(), "mail-send-claims"), authority = protectedMailAuthority(), now = Date.now, io = fs
} = {}) {
  try {
    const allowed = [...bindingFields, "action", "idempotency_key", "deployment_ref", "approval_ref", "evidence_ref", "fence_id", "outcome", "reason_code", "dry_run", "confirm"];
    if (!args || Object.keys(args).some(key => !allowed.includes(key)) || !["begin", "commit"].includes(args.action)) refuse("identity_refused");
    validateBinding(args);
    if ((args.dry_run !== undefined && typeof args.dry_run !== "boolean") || (args.confirm !== undefined && typeof args.confirm !== "boolean") ||
        !hashPattern.test(args.deployment_ref) || !hashPattern.test(args.approval_ref)) refuse("identity_refused");
    if (args.action === "begin" && ["outcome", "reason_code", "evidence_ref", "fence_id"].some(field => args[field] !== undefined)) refuse("identity_refused");
    if (args.idempotency_key !== undefined && (typeof args.idempotency_key !== "string" || !args.idempotency_key.trim() || args.idempotency_key.length > 256 || mailClaimId(args.fingerprint, args.idempotency_key) !== args.claim_id)) refuse("identity_refused");
    if (args.dry_run === true) return { ...mailOutcome("reconciliation_preview"), planned: true };
    if (!fs.existsSync(directory)) refuse("identity_refused");
    const initial = readMailClaim(directory, args.claim_id, args.attempt);
    if (initial.legacy) refuse("legacy_ineligible");
    const requestHash = digest(JSON.stringify(allowed.map(field => args[field] ?? null)));
    if (initial.reconciliation?.request_hash === requestHash && latestAttempt(directory, args.claim_id) === args.attempt) {
      return mailOutcome("reconciliation_replayed", { ok: true, historical: initial.state, receipt: initial.reconciliation.receipt });
    }
    return withMailWriterLock(directory, () => {
      const claim = readMailClaim(directory, args.claim_id, args.attempt);
      if (latestAttempt(directory, args.claim_id) !== args.attempt) refuse("revision_refused");
      if (claim.fingerprint !== args.fingerprint) refuse("identity_refused");
      if (claim.reconciliation?.request_hash === requestHash) return mailOutcome("reconciliation_replayed", { ok: true, historical: claim.state, receipt: claim.reconciliation.receipt });
      if (claim.state !== "pending") refuse("outcome_conflict");
      if (!sameBinding(args, claim)) refuse("revision_refused");
      const observedNow = now();
      const deployment = deploymentProof(authority, args.deployment_ref, observedNow);
      const approval = approvalProof(authority, args.approval_ref, "reconcile", args, deployment, observedNow);
      const fenceFile = reconciliationFencePath(directory);
      if (args.action === "begin") {
        if (fs.existsSync(fenceFile)) {
          const previous = readJson(fenceFile);
          if (!sameBinding(previous, args) || previous.approval_ref !== args.approval_ref || previous.deployment_ref !== args.deployment_ref) refuse("active_writer_refused");
          return mailOutcome("evidence_required", { ok: true, fence_id: previous.fence_id, ...claimBinding(claim) });
        }
        const fence = { schema_version: 1, ...claimBinding(claim), fence_id: digest(randomUUID()), created_at: observedNow, approval_ref: args.approval_ref, deployment_ref: args.deployment_ref, epoch: deployment.epoch };
        durableCreate(fenceFile, fence, io);
        return mailOutcome("evidence_required", { ok: true, fence_id: fence.fence_id, ...claimBinding(claim) });
      }
      const fence = readJson(fenceFile);
      if (!sameBinding(fence, args) || !hashPattern.test(args.fence_id) || fence.fence_id !== args.fence_id || fence.epoch !== deployment.epoch ||
          fence.approval_ref !== args.approval_ref || fence.deployment_ref !== args.deployment_ref) refuse("active_writer_refused");
      if (!["sent", "not_sent"].includes(args.outcome) || !reasonCodes.has(args.reason_code) || args.reason_code !== `operator_verified_${args.outcome}`) refuse("evidence_refused");
      const evidence = authority.load("evidence", args.evidence_ref);
      fresh(evidence, observedNow);
      if (evidence.kind !== "mail_verification" || !hashPattern.test(evidence.id) || !sameBinding(evidence, args) || evidence.fence_id !== fence.fence_id ||
          evidence.epoch !== deployment.epoch || evidence.operator !== approval.operator || evidence.source !== "complete_exact_mail_snapshot_v1" ||
          evidence.clock_uncertainty_ms !== 0 || evidence.outcome !== args.outcome || evidence.reason_code !== args.reason_code || evidence.effects_drained !== true) refuse("evidence_refused");
      for (const mailbox of ["sent", "outbox"]) {
        const observation = evidence[mailbox];
        if (!observation || observation.completed !== true || observation.error !== null || observation.index_used !== false ||
            !Number.isSafeInteger(observation.observed_at) || observation.observed_at <= fence.created_at || observation.observed_at > observedNow ||
            observedNow - observation.observed_at > 60000 || evidence.issued_at < observation.observed_at || !Number.isSafeInteger(observation.search_from) || observation.search_from > claim.createdAt ||
            observation.search_to !== observation.observed_at || observation.exact_fingerprint !== claim.fingerprint ||
            !Array.isArray(observation.accounts) || JSON.stringify([...observation.accounts].sort()) !== JSON.stringify([...deployment.accounts].sort()) ||
            !Array.isArray(observation.matches)) refuse("evidence_refused");
      }
      if (evidence.outbox.matches.length !== 0 || (args.outcome === "not_sent" ? evidence.sent.matches.length !== 0 : evidence.sent.matches.length !== 1)) refuse("evidence_refused");
      let messageRef;
      if (args.outcome === "sent") {
        const match = evidence.sent.matches[0];
        if (!match || !hashPattern.test(match.message_ref) || !hashPattern.test(match.message_id_hash) || !deployment.accounts.includes(match.account) ||
            match.fingerprint !== claim.fingerprint || match.message_id_hash !== evidence.message_id_hash) refuse("evidence_refused");
        messageRef = match.message_ref;
      }
      deploymentProof(authority, args.deployment_ref, now());
      approvalProof(authority, args.approval_ref, "reconcile", args, deployment, now());
      const revalidated = authority.load("evidence", args.evidence_ref);
      fresh(revalidated, now());
      if (JSON.stringify(revalidated) !== JSON.stringify(evidence)) refuse("evidence_refused");
      const receipt = digest(JSON.stringify([requestHash, claim.record_hash]));
      appendMailOutcome(directory, claim, {
        state: args.outcome === "sent" ? "done" : "not_sent", committed_at: observedNow,
        reconciliation: { request_hash: requestHash, receipt, evidence_ref: args.evidence_ref, approval_ref: args.approval_ref, reason_code: args.reason_code, operator: approval.operator, ...(messageRef ? { message_ref: messageRef } : {}) }
      }, io);
      io.unlinkSync(fenceFile);
      syncDirectory(directory, io);
      return mailOutcome("reconciled", { ok: true, historical: args.outcome, receipt });
    });
  } catch (error) {
    return mailOutcome(error.mailCode || "durability_refused");
  }
}

export function validateRetryAuthorization(authority, reference, deploymentRef, claim, now) {
  try {
    const deployment = deploymentProof(authority, deploymentRef, now);
    const approval = approvalProof(authority, reference, "retry", claim, deployment, now);
    if (claim.state !== "not_sent" || claim.authorization_id !== undefined || approval.single_use !== true) refuse("authorization_refused");
    return approval.id;
  } catch { refuse("authorization_refused"); }
}

export function assertUnspentRetryLineage(directory, claim) {
  const consumed = path.join(directory, ".authorizations");
  if (!fs.existsSync(consumed)) return;
  const stat = fs.lstatSync(consumed);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("durability_refused");
  for (const name of fs.readdirSync(consumed)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) refuse("durability_refused");
    const record = readJson(path.join(consumed, name));
    validateBinding(record);
    if (record.schema_version !== 1 || record.authorization_id !== name.slice(0, -5) ||
        typeof record.authorization_ref !== "string" || !record.authorization_ref ||
        !Number.isSafeInteger(record.retry_attempt) || record.retry_attempt !== record.attempt + 1 ||
        !Number.isSafeInteger(record.consumed_at) || record.consumed_at < 0) refuse("durability_refused");
    if (record.claim_id === claim.claim_id) refuse("authorization_refused");
  }
}
