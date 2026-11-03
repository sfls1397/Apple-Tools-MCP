import fs from "fs";
import path from "path";
import { getAppleToolsDir } from "./config.js";
import { FINGERPRINT_ALGORITHM, mailFingerprint, mailClaimId, mailOutcome, readMailClaim, appendMailOutcome, durableCreate, syncDirectory, withMailWriterLock, reconciliationFencePath, protectedMailAuthority, validateRetryAuthorization, assertUnspentRetryLineage, refuse, claimBinding, mailRecordHash, mailAttempts } from "./mailReconciliation.js";

/** Cross-process, restart-safe send claims. Only hashes and outcome metadata
 * are stored. A crash or corrupt record fails closed, including an empty file
 * left between exclusive creation and its first write. No uncertain claim
 * expires: a missing Sent row cannot prove a queued send will not run later.
 */
export function idempotentMailSend(args, run, {
  directory = path.join(getAppleToolsDir(), "mail-send-claims"), now = Date.now,
  authority = protectedMailAuthority(), io = fs, log = record => console.error(JSON.stringify(record)), monotonic = () => process.hrtime.bigint()
} = {}) {
  if (args.dry_run === true) return run();
  const key = args.idempotency_key;
  if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 256)) {
    return mailOutcome("identity_refused");
  }
  const fingerprint = mailFingerprint(args);
  const id = mailClaimId(fingerprint, key);
  const dir = path.join(directory, id);
  let entered = false;
  try {
    return withMailWriterLock(directory, () => {
      if (fs.existsSync(reconciliationFencePath(directory))) return mailOutcome("active_writer_refused");
      for (const candidate of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}$/.test(name) && name !== id)) {
        const attempts = mailAttempts(directory, candidate);
        if (!attempts.length) continue;
        const previous = readMailClaim(directory, candidate, Math.max(...attempts));
        if (previous.fingerprint === fingerprint && !["done", "not_started"].includes(previous.state)) {
          return mailOutcome(previous.state === "not_sent" ? "not_sent_suppressed" : "pending_suppressed", { historical: previous.state, ...(previous.legacy ? { legacy: true } : claimBinding(previous)) });
        }
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      fs.chmodSync(dir, 0o700);
      const attempts = mailAttempts(directory, id);
      const last = attempts.length ? Math.max(...attempts) : 0;
      let authorizationId;
      let authorizationBinding;
      if (last) {
        const previous = readMailClaim(directory, id, last);
        if (previous.fingerprint !== fingerprint) {
          return mailOutcome("identity_refused");
        }
        if (previous.state === "done") {
          if (previous.legacy && previous.result?.ok !== true) return mailOutcome("pending_suppressed");
          return { ...mailOutcome("accepted_replay", { ok: true, historical: "accepted", ...(previous.legacy ? { legacy: true } : claimBinding(previous)) }), deduplicated: true };
        }
        if (previous.state === "not_sent" && args.retry_authorization_ref !== undefined && !previous.legacy) {
          assertUnspentRetryLineage(directory, previous);
          authorizationId = validateRetryAuthorization(authority, args.retry_authorization_ref, args.deployment_ref, previous, now());
          authorizationBinding = claimBinding(previous);
          for (const attempt of attempts) {
            const original = JSON.parse(fs.readFileSync(path.join(dir, `${attempt}.json`), "utf8"));
            if (original.authorization_id === authorizationId) refuse("authorization_refused");
          }
        } else if (previous.state !== "not_started") {
          return mailOutcome(previous.state === "not_sent" ? "not_sent_suppressed" : "pending_suppressed", { historical: previous.state, ...(previous.legacy ? { legacy: true } : claimBinding(previous)) });
        }
      }
      const file = path.join(dir, `${last + 1}.json`);
      if (args.retry_authorization_ref !== undefined && !authorizationId) refuse("authorization_refused");
      if (authorizationId) {
        const consumed = path.join(directory, ".authorizations");
        io.mkdirSync(consumed, { recursive: true, mode: 0o700 });
        syncDirectory(directory, io);
        if (fs.existsSync(path.join(consumed, `${authorizationId}.json`))) refuse("authorization_refused");
        durableCreate(path.join(consumed, `${authorizationId}.json`), { schema_version: 1, authorization_id: authorizationId, authorization_ref: args.retry_authorization_ref, ...authorizationBinding, retry_attempt: last + 1, consumed_at: now() }, io);
      }
      const claim = { protocol_version: 1, claim_id: id, attempt: last + 1, revision: 1, fingerprint_algorithm: FINGERPRINT_ALGORITHM, fingerprint, createdAt: now(), state: "pending", ...(authorizationId ? { authorization_id: authorizationId } : {}) };
      claim.integrity_hash = mailRecordHash(claim);
      durableCreate(file, claim, io);
      syncDirectory(directory, io);
      if (authorizationId) validateRetryAuthorization(authority, args.retry_authorization_ref, args.deployment_ref, readMailClaim(directory, id, last), now());
      const started = monotonic();
      const stage = (code, verification = "unknown") => {
        try { log({ schema_version: 1, stage: code, semantics: code.endsWith("completed") ? "completed" : "entered", attempt: claim.attempt, operation_id: id, route: "local_handler", protocol_version: 1, elapsed_ms: Math.max(0, Number(monotonic() - started) / 1e6), dispatch_attempted: "unknown", dispatch_acknowledged: "unknown", verification }); } catch {}
      };
      stage("handler_entered");
      entered = true;
      let result;
      try { result = run(); } catch { return mailOutcome("transport_unresolved", { entry: "entered", ...claimBinding(claim) }); }
      stage("handler_completed");
      const safe = result?.sendStarted === false || result?.planned === true || /^mail_send refused:/.test(result?.message || "");
      stage("verification_completed", result?.ok === true ? ["sent", "outbox"].includes(result.mailbox) ? result.mailbox : "accepted" : safe ? "not_started" : "unresolved");
      const state = result?.ok === true ? "done" : safe && !authorizationId ? "not_started" : "pending";
      let finalClaim = readMailClaim(directory, id, last + 1);
      if (state !== "pending") finalClaim = appendMailOutcome(directory, finalClaim, { state, committed_at: now() }, io);
      const code = result?.ok === true ? "transport_accepted" : safe ? authorizationId ? "authorization_spent" : "not_started" : "transport_unresolved";
      return { ...result, ...mailOutcome(code, { ok: result?.ok === true, entry: "entered", historical: state, ...claimBinding(finalClaim) }), ...(safe ? { sendStarted: false } : {}), message: result?.message || mailOutcome(code).message };
    });
  } catch (error) {
    return mailOutcome(error.mailCode || "durability_refused", { entry: entered ? "entered" : "none" });
  }
}
