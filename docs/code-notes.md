# Code notes

Why the code is the way it is, kept here because the code carries no comments (`docs/TYPES-AND-LINT.md`, the comment ban). Each section names the file it belongs to. Narration, history and dividers were deleted; only reasons that are not visible in the code or its tests live here.

## npm bin wrappers (`bin/apple-tools-mcp.js`, `bin/apple-tools-indexer.js`, `bin/apple-tools-http.js`)

- npm 12 pack and publish rewrites a `bin` target named `index.js` and drops it with the warning `script name index.js was invalid and removed`, so each CLI has its own wrapper. The guard is `tests/unit/npm-bin.test.js`.
- `bin/apple-tools-indexer.js` injects `--mode=indexer` and `bin/apple-tools-http.js` injects `--transport=http`, so a realpath to the wrapper still starts that daemon or server. `permissions` (and `http-token` for the HTTP wrapper) still win over the injected flag, the same contract as the `apple-tools-indexer` bin name.
- `bin/apple-tools-mcp.js` is the MCP stdio server and the `permissions` subcommand.

## `scripts/postinstall.js`

Print-only reminder after an install or upgrade. It must never run GUI or TCC probes unattended: a LaunchAgent or a headless npm cannot click Allow. The operator runs `apple-tools-mcp permissions` on the host's UI. The guard is `tests/unit/permissions.test.js` ("is a package-bin subcommand, not an unattended postinstall probe").

## `scripts/audit-index.js`

Usage: `node scripts/audit-index.js [--sources emails,messages] [--max-items 50]`; `--sources calendar --max-items 0` audits a single source with no item cap. The report goes to standard output.

## `scripts/smoke-mail-read.js`

- Read only: every `mail_search` hit must be readable by `mail_read`. For each hit it checks what `mail_read` needs: the `File` path passes `validateEmailPath`, the file exists and its headers parse.
- A hit whose file is gone means the index holds stale paths (for example after a move to a new Mac). The indexer re-paths those on its next pass.
- Writes nothing, sends nothing, needs no indexer lock. Usage: `node scripts/smoke-mail-read.js [--limit=30] ["receipt" "meeting"]`. Exit 0 when every hit is readable, 1 when any is not, 2 when there were no hits.

## `scripts/smoke-writes.js` (the write ship gate)

- It covers the Automation and privacy classes that gate this package's writes: Mail compose (Automation to Mail.app), Messages account and service lookup (Automation to Messages.app), Contacts CRUD (AddressBook class, through Contacts.app) and Calendar CRUD (calendars class, through Calendar.app).
- `mail_send` with `dry_run` never talks to Mail, so the Mail step runs a real `make new outgoing message` and discards it. A hang or timeout there is TCC or Automation denied, not "Mail.app missing". Nothing is sent. Mail and Messages are separate Apple Events targets: a Contacts or Calendar grant does not include them.
- Mail, Messages, Contacts and Calendar must all pass on the Node host; that is the ship gate. A missing grant for any one of the four fails `--apply`. Contacts and Calendar CRUD are expected to fail under a host app that holds neither entitlement: a documented host limitation, not a package failure.
- The write path launches Contacts.app before CRUD, so keep Contacts, Mail and Messages running on the host. Calendar does not need to stay open (EventKit).
- The default is a dry run: no contact or event is created, edited or deleted. It is not a no-op: it reads contacts from the AddressBook database and calls `calendar_list_calendars`, a live Calendar.app query and a real TCC touch that can prompt or be denied. A dry run treats that listing as advisory (`calendarListSeverity(false)` is a warning), so a denial does not fail a run that changed nothing. Only `--apply` treats it as an error. The Mail compose step is advisory on a dry run in the same way (a refused prompt is WARN).
- `--apply` performs real create, edit and delete round trips; `--keep` leaves the test items; `--calendar=Work` picks the calendar. Test items are clearly named and removed unless `--keep`. No credentials, tokens or personal data are involved.
- Ship-gate precondition: the smoke test must exercise the same path production MCP clients use, so a real run needs the write bridge (writes execute inside the launchd-started daemon, where node is the responsible process) or an explicit `--allow-local` acknowledgement that this process itself is the responsible one, which is only true when a parent like Terminal.app or launchd started it. Running in process under a foreign parent (an embedded agent shell, for example) produces an AppleScript denial that says nothing about whether the package works.
- Every write goes through `dispatchWriteTool`, the production dispatcher, not the write modules directly. Importing them directly is what made the smoke test bypass the bridge and fail the Mini ship gate (guard: `tests/unit/write-tools.test.js`, "dispatches through the production write path, not the write modules directly").
- The read side runs first: it proves Full Disk Access independently of the write path. Mail runs first among the writes so the first-run Allow prompt covers Mail in the same pass as Contacts and Calendar.
- The Mail compose-and-discard and Messages lookup helpers exist only in this script; they are not MCP write tools. With the write bridge up, `--apply` also runs the public `mail_draft`, so the launchd-owned node is fail-closed for Mail (same verb, nothing is sent).
- Calendar choice: prefer an On My Mac calendar, so a Calendar.app delete is reliable if the EventKit remove still misses. EventKit add and remove is the primary path on iCloud (`writeOnly` can delete events it created). An explicit `--calendar=` wins.
- Smoke events are placed well in the future so they never collide with anything real on the calendar.
- The script's main block runs only when invoked directly, so the helpers stay unit-testable.

## `contacts.js`

- Contacts reads go straight at the AddressBook sqlite file, so they depend on Full Disk Access for the process macOS holds responsible. They do not depend on the AddressBook entitlement that gates Contacts.app and CNContactStore writes. Reporting the difference keeps a plain Full Disk Access problem from being mistaken for the host entitlement gap.
- iCloud-synced contacts live in the `Sources` subdirectory of the AddressBook folder; the main database is the fallback, and a source with no rows is skipped.
- `ZUNIQUEID` is the Contacts.app person id the write tools address contacts by. A schema without it must still load contacts for search.
- Memory bounds: at most 50,000 contacts, 10 emails and 10 phones per contact, so a very large contacts database cannot exhaust memory. The lookup maps are cached for 5 minutes.
- Phone numbers are normalized to digits, keeping a leading `+` for international numbers; a US number is reduced to 10 digits by dropping the leading 1, and the `+` is kept only when no leading 1 was dropped.
- Name lookup tries an exact full name first, then first name, nickname and partial matches; `lookupContact` tries email (the most specific), then phone, then name.

## Gate scripts (`.githooks`, `.security`, `.cursor`)

- Both history scans (`.security/metadata.py`, `.githooks/pre-push`, the gate and `merge-pr.py`) read only the history being checked, never `--all` and never `rev-list --all`: the head the gate checks, or each tip a push sends. The worktree shares the repository's refs, so `--all` took in other jobs' branches and scratch worktrees and failed pushes and gates on someone else's scratch commit. A delete pushes no commits, so neither scan runs for it; the file scan still does. Guards: `.security/test_standard.py`: `test_history_ignores_another_jobs_scratch_worktree`, `test_pre_push_checks_only_the_pushed_commits` and `test_gate_and_merge_scan_only_the_checked_head`.
- After a push, GitHub's PR head can lag the branch by a few seconds, so `local-gate.py` waits up to `HEAD_WAIT` seconds before refusing when the origin branch already holds the local commit (ported from the Toolbox). A closed PR never waits; an unpushed commit or an unreadable origin refuses at once. Guard: `test_pr_head_lag_after_a_push_is_waited_out`.
- Only the owner's newest `local-gate` status on the exact SHA counts for a merge; GitHub Actions are not the gate. The merge sends the SHA as a condition, so GitHub rejects a changed PR head atomically.
- Public tool attribution in pre-existing history is not a personal identity, but new commits must always use GitHub noreply, including tool-generated commits. `cat-file` reads the real commit headers because a mailmap cannot hide an identity.
- `.security/scan.py`: Semgrep 1.180.0 misparses a valid TypeScript regex as an HTML comment, so its spelling is rewritten in the disposable scan copy only, with the same pattern and flags; runtime and index bytes are never modified. Advisory chains are pinned for every affected installed version, not just the name. Staged scans use explicit staged targets so an unstaged worktree or unrelated files are never scanned; tools, configuration, package metadata and candidate source come from the index. Tests and scripts are scanned; only generated and vendor paths are ignored. Tool errors, source snippets, private paths and config are never echoed.
- `.security/test_gates.py` probes never make test commits, so they never bypass a real repository's hook. Staged metadata would trigger a real npm, so only source is checked, with a fake npm that returns an empty successful audit.
- `.security/languages.py` selects an SDK compatible with the installed compiler for the Clang analysis, then fails on findings.
- `.cursor/install-gitleaks.sh` and `install-semgrep.sh` serve Cursor Cloud on Linux: they install only the checksum-verified pinned release, Semgrep needs Python 3.10 or newer, default cloud images omit `ensurepip` (so the same pin comes from the system pip), and exports last for that script only (the always-applied rule sets `PATH` in new shells). CI has no committer identity by default, so `.cursor/install-security.sh` sets one and never inherits a runner hostname. Default-image cloud agents skip `environment.json`, so tools install to `~/.local/bin`.
