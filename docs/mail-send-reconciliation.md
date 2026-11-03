# Mail send reconciliation protocol v1

## Boundary and deployment

This is a **no-send** operation, not a Mail transport or a locked-screen
workaround. It imports no Mail, shell, UI, wake, clipboard or page-ledger code.
Installation does not adjudicate claims, create authority, authorize a retry,
change a page ledger or deliver historical mail. All legacy records are
ineligible, regardless of age, mailbox observations or missing metadata. No
legacy migration or adjudication is implemented.

The default deployment is closed. Positive reconciliation needs an external
administrator-controlled authority described below. This package does **not**
create that authority, manufacture verification evidence, stop old writers or
disable their launch sources. Without proven exclusion of nonparticipating
writers, it refuses. Do not create an authority manifest simply to bypass this
refusal. Establishing the privileged operational boundary and collecting real
evidence require their own approved operational work; offline fixtures are not
live evidence. No live claim or Mail operation is needed to install or smoke-test
the package.

## Identity and delivery lineage

`claim_id` is the existing claim-directory digest. The request binds the exact
`attempt`, `revision`, `fingerprint_algorithm: sha256-mail-content-v1` and
`fingerprint`. The fingerprint preserves the existing algorithm: SHA-256 of
the JSON array containing sorted/lowercased/trimmed To, Cc, Bcc, exact subject,
exact body and body format (default plain). It does not equate different HTML
or body strings. A supplied idempotency key must hash to that same directory;
it is never stored. Missing or conflicting identities do not create a claim.
The public `mail_send` structured result supplies modern claim bindings.

The latest attempt is authoritative. Changing or removing a key cannot escape
an unresolved or terminal not_sent claim with identical content, including a
legacy pending claim. A new key can name a genuinely new intended delivery
only after all identical-content lineages are accepted or proven not_started.
This retains the existing intentional-new-delivery convention for successful
sends, not for uncertain ones. Changing actual content defines another
fingerprint; callers must not disguise a retry by modifying a payload.

## Trusted references and authority

Tool arguments accept **references**, not caller-authored checked strings,
scripts, raw evidence or authority objects. A reference is the SHA-256 of the
exact UTF-8 bytes of an administrator-provisioned JSON file:

`/Library/Application Support/AppleTools/Reconciliation/<kind>/<ref>.json`

Kinds are `deployment`, `approval`, `evidence`, `authorization`. The root,
every ancestor, every file and `revocations.json` must be root-owned, not
group/world-writable and not a symlink. Files must be regular and bounded to
64 KiB. Content hashes must match. Missing, corrupt, unprotected or revoked
references refuse. These checks establish administrative provenance; a tool
caller with the ordinary user identity cannot issue proofs. Root is the
authorized issuer. The protocol does not claim protection against a malicious
administrator, kernel, or a Mail user independently sending messages.

`revocations.json` has `schema_version: 1`, `references: [<hash>...]` and
`ids: [<hash>...]`. It is reread on every authority lookup; a missing list is
not an empty list. References or authority IDs can be revoked. Revocation
before durable consumption prevents a retry; revocation cannot undo a consumed
permission or an already invoked transport. Expiration is checked again before
transport entry. Neither age nor revoked permission restores permission.

All authority records have `schema_version: 1`, integer epoch-millisecond
`issued_at`, `expires_at`, and `revoked: false`. The entire validity interval
is at most 60 seconds, with no future issue time and no clock uncertainty.
Authority records are immutable-by-reference. Replacing a record needs a new
reference. Operation IDs, fingerprints and protected references are bounded
hashes; operator/epoch IDs are bounded lowercase codes, not names or free text.

A deployment proof has `kind: deployment`, an epoch code, the complete list
of account hashes, authorized operator codes, `clock_uncertainty_ms: 0`,
`nonparticipating_launch_disabled: true`, and true exclusion assertions for
**all** of `daemon`, `local_fallback`, `accepted_bridge`, `scripts_appleevents`,
`old_processes`, `outstanding_effects`. The administrative issuer must actually
disable nonparticipating launch sources for the validity window and drain
already accepted requests/scripts/AppleEvents, not infer exclusion from a PID,
reused PID, heartbeat, lease, socket closure or timeout. The deployment proof
is the trusted administrative attestation of that operational enforcement,
not an automatic discovery mechanism. If it cannot be established, refuse.

Reconciliation approval has `kind: reconcile`, a unique hash ID, the full
claim binding, epoch and an operator code from that deployment proof. Retry
authorization is a separate record with `kind: retry`, a separate unique ID,
the **terminal** binding, operator, epoch and `single_use: true`. Reconciliation
neither issues nor consumes retry authorization. `confirm: true` is not
authority. There is no automatic approval, retry, requeue or ledger reset.

## Writer fence and fresh evidence

1. `mail_send_reconcile(action: begin, <binding>, deployment_ref, approval_ref)`
   validates an existing modern pending claim and protected authority under
   the global `.writer-lock`. It exclusively creates and synchronizes a
   persistent `.reconciliation-fence.json`, then returns a random hash
   `fence_id`. Repeating begin with the same identity and references returns
   that fence. No transport is invoked.
2. Every participating `mail_send` and other Mail write (reply, forward,
   draft, mark, archive, trash) takes the same cross-process lock and refuses
   while the fence exists. A bridge request accepted before begin still
   checks it when its handler executes. Nonparticipating versions/scripts
   are excluded only by the administrative boundary, never by pretending
   they honor this lock. The deployment epoch cannot change mid-operation.
3. Only **after** the fence exists, the authorized operator obtains complete
   exact-content Sent **and** Outbox observations from the accepted source,
   `complete_exact_mail_snapshot_v1`. This name denotes a privileged,
   administrator-validated complete snapshot; it does not bless an arbitrary
   client claiming that source. This build ships no snapshot collector.
   The administrator provisions the protected evidence record with its
   provenance and explicit adjudication. Caller-created artifacts are not
   accepted. Negative observations alone do not decide an outcome.
4. Commit rechecks authority, exclusion, binding, freshness and both mailbox
   observations under the lock. It appends one authoritative terminal
   state/audit record, synchronizes it, then removes/synchronizes the fence.
   It never enters Mail. Refusals retain an existing fence; they never make
   a claim retryable. An expired fence has **no automatic release**.

Evidence has `kind: mail_verification`, a unique hash ID, exact binding,
fence ID, epoch, authorized operator, source, zero clock uncertainty,
`effects_drained: true`, explicit `outcome: sent | not_sent`, and the matching
reason code `operator_verified_sent | operator_verified_not_sent`.

Separate `sent` and `outbox` observations each require `completed: true`,
`error: null`, `index_used: false`, the complete deployment `accounts` list,
`exact_fingerprint`, integer `observed_at` **after** fence creation, integer
`search_from` no later than attempt creation, `search_to` equal to the
observation time, and `matches: []`. Both observations must be at most 60
seconds old, not in the future, and no later than the evidence issue time.
Partial scans, unavailable accounts, stale indexes, errors, incomplete history,
unknown clocks, ambiguity or any queued Outbox match refuse. A sent decision
requires exactly one Sent match with an account from the covered set, exact
fingerprint, protected `message_ref`, and `message_id_hash` matching the
evidence-level exact Message-ID hash. Not_sent requires zero matches in both
mailboxes **plus** the explicit protected operator decision.

## Authoritative audit/state transaction and failure recovery

New attempts keep their original `<attempt>.json` pending record forever.
Immutable, exclusively created `<attempt>.events/<revision>.json` records
are the **only** outcome state; there is no separate mutable state file to
update ahead of the audit. Records include schema version, binding, revision,
previous hash, integrity hash and bounded metadata. Initial attempts also
have an integrity hash. Hashes detect accidental corruption, not same-user
forgery: the user's claim storage is not immutable against that user.

Ordering: create initial attempt exclusively, write, file fsync, parent
directory fsync, claim-root fsync, then handler entry. For outcomes, create
the journal directory, synchronize its parent, exclusively create the next
event, write, file fsync and journal-directory fsync before returning a
committed receipt. The appended record is simultaneously audit and state.
No terminal or retryable state is published by a separate write.

Torn, missing-sequence, divergent, corrupt or unsynchronized writes fail
closed. Disk-full and failed fsync never permit transport or a second
transport invocation. A crash or unknown durability failure retains the
global lock, without expiry, PID-based takeover or automatic repair. Recovery
of that availability requires a separate explicit maintenance decision;
this API does not remove an orphan lock. An already committed identical
reconciliation can return its immutable receipt read-only even with an orphan
lock or lost reply. A complete record surviving an interrupted synchronization
is revalidated and synchronized (file and parent directories) before replay;
an unavailable disk cannot produce a successful receipt. No missing or torn
record is synthesized. A leftover fence after a commit is not automatically
cleared by replay. It cannot unlock mail. Original attempts are never deleted,
rewritten or retroactively annotated.

Allowlisted reconciliation audit fields are request hash, receipt hash,
evidence/approval references, reason code, operator code, optional protected
message reference and commit time, plus structural binding/hash fields.
No raw key, addresses, subject, body, clipboard, scripts, free-text reason,
raw error or tool-result text is persisted.

## Transition table

| Current state | Operation | Result |
|---|---|---|
| Absent | ordinary send | Durable new pending attempt, then one handler invocation |
| Modern pending | another ordinary send, any key | Suppressed; no new attempt or handler |
| Modern pending | valid reconciliation | Append done or terminal not_sent; no handler |
| Legacy pending | reconciliation | Always ineligible; no migration or new metadata |
| Legacy pending | ordinary send, any key | Suppressed |
| Done | same delivery send | Accepted historical replay, not a new delivery |
| Done | genuinely new intentional key | New delivery, unless another identical-content lineage blocks it |
| Not_started | ordinary send | Existing proven-unstarted behavior; new pending attempt |
| Not_sent | ordinary send, changed/removed key, confirm | Terminal suppression; no attempt allocation |
| Not_sent | separate valid single-use retry approval | Durable consumption, then one new pending attempt |
| Terminal | identical reconciliation | Return the committed receipt |
| Terminal | conflicting outcome, stale binding or revision | Refuse |
| Consumed retry | timeout, crash, lost reply, proven-unstarted | Permission remains spent; no automatic recovery |

Retry consumption exclusively creates and synchronizes a global
`.authorizations/<authorization-id>.json` audit binding the grant to one
claim/fingerprint and one new retry attempt **before** that attempt enters
the existing transport handler. The new attempt also stores the authorization
ID. Concurrent/replayed consumers cannot invoke another handler. A crash
after consumption but before transport sacrifices permission and may sacrifice
delivery. V1 does **not** allow another authorization after a consumed,
proven-unstarted retry; a separately reviewed future protocol would be needed.
Admission checks both the attempt's authorization provenance and all durable
consumption records for its claim lineage, including a consumption whose crash
prevented creation of the retry attempt. A different grant cannot restore it.
This promises at-most-once authorized handler invocation, not exactly-once
delivery by Mail or a remote mail server.

Page-ledger reconciliation is a separate workflow. Every machine result says
`ledger_action: none` and `retry_authorized: false` (no permission for a future
invocation). A claim receipt cannot reset or advance the page ledger. A caller
observing disagreement must report that mismatch; it cannot partially reset
two systems. This operation never imports or touches a ledger.

## External results and safe logs

MCP exposes `structuredContent.mail_send` with `schema_version: 1`, `code`,
`current_invocation_transport: none | entered | unknown`,
`historical_effects`, `ledger_action`, `retry_authorized`, and applicable
binding/fence/receipt fields. `entered` means this invocation entered the
existing synchronous transport **handler**, not proof that Mail acknowledged
a send. Lower-level dispatch remains unknown unless independently observed.

Important codes: `pending_suppressed`, `transport_unresolved`,
`transport_accepted`, `accepted_replay`, `not_sent_suppressed`,
`identity_refused`, `legacy_ineligible`, `active_writer_refused`,
`evidence_refused`, `authorization_refused`, `durability_refused`,
`revision_refused`, `outcome_conflict`, `bridge_uncertain`,
`evidence_required`, `reconciled`, `reconciliation_replayed`.
`authorization_spent` distinguishes a consumed approval whose handler proved
it never started sending; that result still grants no future attempt.
Suppression has no handler entry this invocation, but earlier effects may
still finish. An uncertain bridge handoff reports unknown entry for send;
reconciliation always reports none. It never locally replays a possibly
accepted bridge operation. Text-only clients also get `isError: true` for
historical send replay, preventing them mistaking suppression for a newly sent
message. All callers must honor `ledger_action: none` on suppression and
uncertainty, not scrape text or treat `ok` as a new delivery.

Allowlisted stage records are `handler_entered`, `handler_completed` and
`verification_completed`, with
entered/completed semantics, bounded hash operation ID, numeric attempt,
local-handler route, protocol version, monotonic elapsed milliseconds, and
explicit unknown dispatch-attempted/acknowledged fields. A completion marker
for the handler means only it returned. Verification outcomes are allowlisted
as sent, outbox, accepted, not_started, unresolved or unknown, never raw tool
text. Bridge outcome codes also record verification
results without claiming that suppressed mail was sent. Logging failure
does not change state or grant permission. No sender changes or timeout
increases are part of this contract.

## Offline verification and smoke

`tests/unit/mail-reconciliation.test.js` uses fresh temporary directories,
synthetic manifests, injected authority/IO and independent processes with
controlled start barriers. It never calls Mail, a page ledger, an existing
claim or a real verification collector. It covers identity, evidence,
mailbox/account ambiguity, exclusion, persistence/fault boundaries, immutable
replay, terminal suppression, authorization and structured external results.
Existing mail-send and bridge tests cover late completion and fallback rules.

Installation smoke can list the tool schema and call a synthetic
`dry_run: true` reconciliation with an isolated home. Preview creates no
claim, fence, audit or authority. It is not an adjudication or a delivery
verification. Never use a historical claim for smoke testing.
