# Project Architecture

Apple Tools MCP is a Model Context Protocol server for Apple Mail, iMessages, Calendar, and Contacts on macOS. It reads directly from macOS system databases and `.emlx` files, generates local vector embeddings using `all-MiniLM-L6-v2` (384-dim), and stores them in a LanceDB index at `~/.apple-tools-mcp/vector-index/`. The server communicates over stdio transport and exposes 38 tools: 22 read/search/admin tools plus the 16 write tools added in 2.0.0. There are no Apple Reminders tools.

A long-lived **indexer daemon** (`--mode=indexer` / `apple-tools-indexer`) owns `~/.apple-tools-mcp/indexer.lock` and refreshes the vector index on an interval from `~/.apple-tools-mcp/config.json` (env `INDEX_INTERVAL_MS` overrides; default 5 minutes, clamped to 15s–6h). MCP stdio clients stay short-lived, exit on stdin close, and index locally only when no daemon holds the lock.

## Core Modules

### index.js -- MCP Server, Indexer Daemon, and Tool Dispatcher

Entry point and process lifecycle manager. Default mode is MCP stdio: registers all 22 MCP tools, routes tool calls, and **exits on stdin close**. `--mode=indexer` (or the `apple-tools-indexer` bin) skips MCP stdio, holds `indexer.lock` for the process lifetime, and runs startup index + background refresh. MCP instances that lose the lock skip background indexing and search the shared index; if the lock is free they index locally (stdio happy path). Index-backed tools (`mail_*`, `messages_*`, `calendar_search`) return a "still indexing" message until the first index cycle completes (`sessionIndexComplete` flag) **while this process owns the lock**. `calendar_date` and `calendar_free_time` query live Calendar.sqlitedb and do not wait. Contains `smartSearch()` which auto-detects data sources from query intent and searches them in parallel, then groups results into 1-hour time buckets via `synthesizeResults()`.

### indexer.js -- Data Ingestion and Vector Storage

Loads the embedding model, manages the LanceDB vector database (three tables: `emails`, `messages`, `calendar`), and handles all data extraction from macOS sources. Email indexing parses `.emlx` files from `~/Library/Mail` with manual RFC822 header parsing. Message indexing queries `~/Library/Messages/chat.db` and handles `NSAttributedString` binary BLOBs. Calendar indexing reads from `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb` and converts Mac Absolute Time (epoch 2001-01-01). Supports incremental indexing via `-mtime` filtering.

### search.js -- Vector Search and Result Formatting

Maintains its own LanceDB connection. Implements agentic RAG: query expansion (synonym variants), pronoun resolution, negation parsing (`NOT`/`-`/`without`), natural language date extraction via `chrono-node`, and reciprocal rank fusion (RRF, k=60) to merge multi-variant results. Caches embeddings (TTL=5min, max=100) and results (TTL=5min, max=50). Tracks session query context for conversational continuity.

### contacts.js -- AddressBook Contact Resolution

Reads from `~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb` via SQLite. Maintains in-memory lookup maps (`emailToContact`, `phoneToContact`, `nameToContact`) with 5-minute TTL cache.

### lib/shell.js -- Secure Subprocess Wrappers

All shell execution uses `spawnSync` with `shell: false`. Provides `safeSqlite3()`, `safeOsascript()`, `safeMdfind()`, `safeFind()` -- never interpolates strings into a shell command.

### lib/validators.js -- Security and Input Validation

Centralizes injection prevention: path traversal checks, AppleScript/SQL escaping, LanceDB ID allowlisting, ReDoS-safe regex helpers (`safeMatch`/`safeReplace`), and an iterative HTML tag stripper (no regex).

### lib/audit.js -- Index Integrity Auditor

Compares the vector index against all three source databases with 0% tolerance. Reports missing items, orphaned entries, and duplicates.

### lib/config.js -- Config File and Interval Clamp

Loads `~/.apple-tools-mcp/config.json` (missing/invalid JSON is non-fatal). Resolves the index refresh interval with precedence env `INDEX_INTERVAL_MS` > file `indexInterval` / `indexIntervalMs` > 5-minute default. Accepts human durations (`30s`, `1m`, `1h`) and clamps to 15 seconds–6 hours, logging the effective interval.

### lib/processMode.js -- Indexer vs MCP stdio

Detects `--mode=indexer` / `--mode indexer` / `apple-tools-indexer` bin so the same `index.js` can run as a daemon or as a short-lived MCP client.

### lib/indexerLock.js -- indexer.lock

Acquire/release/heartbeat for `~/.apple-tools-mcp/indexer.lock`. Never steals from a live PID (even if the timestamp is old). Dead-PID takeover uses a `wx` mutex beside the lock (`indexer.lock.takeover`), re-reads, unlinks only if contents are still the expected dead lock, then `wx`-creates — never renames the live path. A crash-orphaned `.takeover` file is not stolen with compare-then-unlink; waiters `wx` a fence named by the dead PID. Empty or unparsable mutex/lock bytes are unknown (no fence, no steal), so a peer cannot sneak past an in-flight `wx` or heartbeat truncate. MCP local-fallback starts the same lock heartbeat as the daemon.

### lib/indexerRuntime.js -- Daemon vs stdio control flow

Stdin-exit policy, overlapping-cycle skip, lock retention across daemon cycles, MCP local-fallback startup, and daemon lock retry.

### lib/writeTools.js -- Write tool surface (2.0.0)

Defines the 16 write tools (`mail_send`, `mail_draft`, `mail_reply`, `mail_forward`, `mail_mark`, `mail_archive`, `mail_trash`, `messages_send`, `calendar_list_calendars`, `calendar_add`, `calendar_edit`, `calendar_remove`, `calendar_rsvp`, `contacts_add`, `contacts_edit`, `contacts_remove`), maps them to handlers, and dispatches each call local-or-daemon. `index.js` spreads these definitions into `ListTools` and routes matching calls before the read-tool switch, so writes never wait on the index gate.

### lib/writeGuards.js -- Confirm / dry-run policy

The safety contract shared by every write: `dry_run` previews and never executes; deletes and multi-recipient sends require `confirm`; recipients, ids, bodies, and subjects are validated rather than guessed; success and failure lines name the action and target, and `scrubValues()` keeps caller-supplied bodies out of error text.

### lib/appleScript.js -- Script literals, strict dates, TCC classification

Builds escaped AppleScript literals (`asString`/`asInteger`/`dateCall`), parses writes-only strict local datetimes (no natural language), and classifies osascript failures as `tcc` / `not_found` / `app_unavailable` / `unknown`.

### lib/mailWrite.js, messagesWrite.js, calendarWrite.js, contactsWrite.js -- Write implementations

One module per data source. Each exports pure `build*Script()` builders (unit-tested without macOS) plus the tool functions. Mail addresses messages by RFC822 Message-ID (resolvable from an `.emlx` `file_path`); Messages verifies a `chat_id` against `chat.db` before sending and counts participants to detect group chats; Calendar addresses events by iCal UID and builds RRULEs from an allowlisted grammar; Contacts addresses people by Contacts.app person id and never writes the AddressBook database directly.

### lib/writeBridge.js + lib/writeRouting.js -- TCC attribution

macOS attributes Apple events to the process *responsible* for the sender, which for a stdio server is the host app rather than node. A host that cannot hold Contacts/Calendars access therefore blocks those writes regardless of node's Full Disk Access. The launchd-started indexer daemon does not have that problem, so it listens on a 0600 unix socket (`~/.apple-tools-mcp/writer.sock`) and performs writes for stdio clients; `writeRouting.js` holds the pure local-vs-daemon policy, the fallback-to-local rule, and the TCC advice text.

Reads and writes hit different gates and must not be conflated. Contacts and Calendar **reads** are sqlite against `AddressBook-v22.abcddb` / `Calendar.sqlitedb` and need only Full Disk Access, so an `EPERM` there is an FDA/attribution problem. **Writes** go through Contacts.app (`CNContactStore`) and Calendar.app (EventKit), gated by the AddressBook and calendars privacy classes. Claude.app ships with neither `com.apple.security.personal-information.addressbook` nor `…​.calendars` (verified by codesign; only location and photos-library are present), so Contacts and Calendar CRUD under Claude Desktop are host limitations. The ship gate for both is the Node host with FDA, reached from any client through the bridge. Contacts/Calendar **writes** are granted by Allowing **node** in System Settings → Privacy & Security → **Automation** (Apple Events to Contacts.app / Calendar.app) while the LaunchAgent owns node — not by adding node via + in the Contacts or Calendars privacy lists (those panes often have no Add button). `scripts/smoke-writes.js` proves both paths.

## Common Commands

- **Start server**: `npm start`
- **Indexer daemon**: `npm run indexer` (or `node index.js --mode=indexer`)
- **Run all tests**: `npm test`
- **Unit tests**: `npm run test:unit`
- **Integration tests**: `npm run test:integration`
- **Coverage**: `npm run test:coverage`
- **Indexing tests**: `npm run test:idx`
- **Security tests**: `npm run test:security`
- **Performance tests**: `npm run perf` (also `perf:quick`, `perf:embedding`, `perf:stress`, `perf:search`, `perf:lancedb`, etc.)
- **Rebuild index**: `npm run build-index` (indexes all email history by default; set `APPLE_TOOLS_INDEX_DAYS_BACK=30` to cap the lookback window)
- **Audit index**: `npm run audit`

## Terminology

- **MCP** -- Model Context Protocol; the communication standard this server implements (stdio transport)
- **LanceDB** -- Local columnar vector database used for embedding storage and similarity search
- **all-MiniLM-L6-v2** -- The HuggingFace sentence-transformer model used for local embedding generation (384 dimensions)
- **RRF (Reciprocal Rank Fusion)** -- Algorithm that merges result sets from multiple query variants using rank positions (k=60)
- **Mac Absolute Time** -- Apple's timestamp format with epoch at 2001-01-01 (offset 978307200 seconds from Unix epoch)
- **`.emlx`** -- Apple Mail's proprietary email file format; each file contains one message with RFC822 headers
- **NSAttributedString** -- Apple binary format found in Messages `chat.db` BLOBs; requires multiple extraction strategies
- **Smart Search** -- Meta-tool that auto-detects which data sources to query based on natural language intent
- **Query Context** -- Session-level state tracking the last query, person, and source for conversational continuity (5-min expiry)
- **Embedding Cache** -- In-memory TTL cache avoiding redundant vector computations for repeated/similar queries

## Common Patterns

- **File naming**: Source files use `camelCase.js`; test files use `kebab-case.test.js`; perf tests use `kebab-case.perf.test.js`
- **Function naming**: `camelCase` with semantic prefixes -- `get*` (data retrieval), `format*` (output formatting), `search*` (vector search), `validate*` (input validation), `escape*` (injection prevention), `safe*` (secure shell wrappers), `index*` (indexing operations)
- **Constants**: `SCREAMING_SNAKE_CASE`; millisecond values suffixed with `_MS`
- **MCP tool names**: `snake_case` (e.g., `mail_search`, `calendar_free_time`, `person_search`)
- **Write tool pattern**: validate args -> `planWrite()` (dry_run / confirm gate) -> build escaped script -> `runAppleScript()` -> message naming ids and recipients, never bodies
- **Exports**: Named exports only, never default exports
- **Branching**: Single `main` branch; no feature branch convention
- **CI/CD**: GitHub Actions publishes to GitHub Packages on release creation; runs `npm ci` and `npm test` first
- **Security pattern**: All subprocess execution goes through `lib/shell.js` wrappers with `shell: false`; all user input goes through `lib/validators.js`
- **Test graceful skipping**: Tests use `describe.skipIf(!condition)` to skip when macOS data sources are unavailable
- **Caching pattern**: In-memory `Map`-based caches with TTL expiry and max-entry limits throughout `search.js` and `contacts.js`
