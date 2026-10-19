import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getAppleToolsDir } from "./config.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const uncertain = () => ({
  ok: false, unconfirmed: true, sendStarted: true,
  message: "mail_send: unconfirmed. An earlier identical send may still complete. Check Sent and Outbox; do not resend."
});

/** Cross-process, restart-safe send claims. Only hashes and outcome metadata
 * are stored. A crash or corrupt record fails closed, including an empty file
 * left between exclusive creation and its first write. No uncertain claim
 * expires: a missing Sent row cannot prove a queued send will not run later.
 */
export function idempotentMailSend(args, run, {
  directory = path.join(getAppleToolsDir(), "mail-send-claims"), now = Date.now
} = {}) {
  if (args.dry_run === true) return run();
  const key = args.idempotency_key;
  if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 256)) {
    return { ok: false, sendStarted: false, message: "mail_send refused: idempotency_key must be a nonempty string of at most 256 characters." };
  }
  const addresses = (values) => (Array.isArray(values) ? values.map(v => String(v).trim().toLowerCase()).sort() : values);
  const fingerprint = digest(JSON.stringify([
    addresses(args.to), addresses(args.cc || []), addresses(args.bcc || []),
    args.subject, args.body, args.body_format || "plain"
  ]));
  const dir = path.join(directory, digest(key === undefined ? fingerprint : `key:${key}`));
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(dir, 0o700);
    const attempts = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n)).map(n => Number(n.slice(0, -5)));
    const last = attempts.length ? Math.max(...attempts) : 0;
    if (last) {
      const previous = JSON.parse(fs.readFileSync(path.join(dir, `${last}.json`), "utf8"));
      if (previous.fingerprint !== fingerprint) {
        return { ok: false, sendStarted: false, message: "mail_send refused: idempotency_key was already used with different message content." };
      }
      if (previous.state === "done") {
        if (previous.result?.ok !== true) return uncertain();
        return { ...previous.result, deduplicated: true };
      }
      if (previous.state !== "not_started") return uncertain();
    }
    // Atomic exclusive create arbitrates concurrent retries, even in different processes.
    const file = path.join(dir, `${last + 1}.json`);
    const fd = fs.openSync(file, "wx", 0o600);
    const claim = { fingerprint, createdAt: now(), state: "pending" };
    try {
      fs.writeFileSync(fd, JSON.stringify(claim));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    let result;
    try { result = run(); } catch { return uncertain(); }
    const safe = result?.sendStarted === false || result?.planned === true || /^mail_send refused:/.test(result?.message || "");
    const state = result?.ok === true ? "done" : safe ? "not_started" : "pending";
    const cached = result?.ok === true ? {
      ok: true, delivered: result.delivered === true, mailbox: result.mailbox,
      message: "mail_send: previous send already accepted; duplicate suppressed."
    } : undefined;
    // Torn writes remain blocked on the next call. Never persist message content.
    fs.writeFileSync(file, JSON.stringify({ ...claim, state, result: cached }), { mode: 0o600 });
    return result;
  } catch {
    return uncertain();
  }
}
