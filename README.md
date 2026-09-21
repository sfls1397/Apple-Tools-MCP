# apple-tools-mcp

An MCP (Model Context Protocol) server for Apple Mail, Messages, Calendar, and Contacts on macOS. Search them with natural language, and — as of 2.0.0 — write to them: send mail and messages, manage calendar events, and manage contacts. Works with any compatible MCP client over stdio.

## Features

- **Semantic Search**: Find emails, messages, and events using natural language queries
- **Write Tools (2.0.0)**: Send/reply/forward/draft mail, mark read, archive, trash; send iMessage/SMS; create, edit, remove, and RSVP to calendar events; create, edit, and remove contacts
- **Safe by Default**: Deletes and multi-recipient sends never run without `confirm`, and every write supports `dry_run`
- **Vector Indexing**: Uses LanceDB for fast similarity search with local embeddings
- **Privacy-First**: All processing happens locally on your Mac - no data leaves your machine
- **Smart Deduplication**: Handles IMAP duplicates, prioritizing INBOX over Junk/Trash
- **Date Intelligence**: Understands queries like "last week", "yesterday", "March 2024"

## Requirements

- **macOS** (Ventura 13.0 or later recommended)
- **Node.js** 18.0 or later
- **Full Disk Access** permission for the Node.js binary

## Installation

### 1. Install the package

```bash
npm install -g apple-tools-mcp
```

Or from source:

```bash
git clone https://github.com/sfls1397/Apple-Tools-MCP.git
cd Apple-Tools-MCP
npm install
```

If you installed from source, point your MCP client at the local `index.js` instead of `npx` in step 3:

```json
"command": "node",
"args": ["/absolute/path/to/Apple-Tools-MCP/index.js"]
```

**Mac Mini** stays on a **global npm** install (`npm install -g apple-tools-mcp`) — no git clone on Mini. **MacBook / development** uses the clone above.

After **first install** and after **upgrade** (when write tools are present or change), run the permissions command once on the host UI before using write tools — see [step 2b](#2b-grant-automation-for-write-tools-first-run--ship-gate).

### 2. Grant Full Disk Access

The MCP server needs access to read your Mail, Messages, and Calendar databases.

1. First, find your Node.js path by running in Terminal:

   ```bash
   which node
   ```

   This will output something like `/opt/homebrew/bin/node` or `/usr/local/bin/node`

2. Open **System Settings** → **Privacy & Security** → **Full Disk Access**

3. Click the **+** button

4. Press **Cmd+Shift+G** to open the "Go to Folder" dialog

5. Paste the path from step 1 (e.g., `/opt/homebrew/bin/node`) and press Enter

6. Select the `node` file and click **Open**

7. Ensure the toggle for Node.js is enabled

Full Disk Access covers the **read** tools. Write tools need the automation permissions below.

### 2b. Grant Automation for write tools (first run / ship-gate)

Write tools drive Mail, Messages, Calendar, and Contacts through AppleScript. macOS gates those Apple events behind **Automation**, not by adding `node` to the Contacts or Calendars privacy lists.

#### First install and upgrade: `apple-tools-mcp permissions`

Run this **after first global install** and **after upgrade** when write surfaces are present or change. It probes **`process.execPath`** (the `node` running the command) so macOS can pop **Allow** dialogs for Contacts, Calendar, Mail, and Messages in one sitting. You click **Allow**; the command cannot grant silently. Already-granted surfaces report OK without another click. Missing grants print a report and the process **exits non-zero** (fail closed).

Use the **same `node` the product uses** — not the MCP host app. Always invoke so **`process.execPath`** is that node. A bare `apple-tools-mcp` (or a path like `~/.nvm/versions/node/v22.21.1/bin/apple-tools-mcp`) can have a shebang that starts a **different** node; Allow dialogs attach to `execPath`, not the CLI path you typed.

```bash
# Preferred: execPath matches the product node
$(which node) $(which apple-tools-mcp) permissions

# After `npm install -g apple-tools-mcp` on that node (same idea):
node "$(dirname "$(which node)")/../lib/node_modules/apple-tools-mcp/index.js" permissions
npx apple-tools-mcp permissions

# From a clone:
npm run permissions
```

If the invoked CLI path and `process.execPath` differ, the command prints a **WARN** with both paths and tells you to re-run as `execPath …/apple-tools-mcp permissions`. The command also prints the binary it is probing. Host examples (not universal paths):

- **Mini:** `/Users/petercoates/.local/node/bin/node` (global npm / indexer LaunchAgent)
- **MacBook:** `/Users/petercoates/.nvm/versions/node/v22.21.1/bin/node` (Claude’s nvm `node`, **not** Homebrew)

**MacBook (default for `permissions`):** run from **Terminal.app**. Click **Allow** for the **printed `process.execPath`**. Confirm **System Settings → Privacy & Security → Automation** for that node → Contacts, Calendar, Mail, and Messages. Do **not** start `apple-tools-indexer` — the always-on indexer / write bridge is a **Mini** install only.

**Mini:** use the [Mini ship-gate](#mini-ship-gate-host-setup) path (LaunchAgent-owned node / `writer.sock`). Missing-grant copy mentions the write bridge only when that socket is present.

On the host UI (Mini Screen Sharing or MacBook local), open **System Settings → Privacy & Security → Automation**, then run the command. Click **Allow** for **`node`** → Contacts, Calendar, Mail, and Messages. npm `postinstall` only **prints a reminder** — it does not run the probes unattended.

This is a real Apple Events pass: Mail uses `make new outgoing message` (compose then discard; nothing is sent). Messages enumerates accounts (nothing is sent). `dry_run` of `mail_send` / `messages_send` never talks to those apps and **does not count**. Contacts creates and deletes a throwaway person in-script. Calendar lists calendars only (no leftover events).

**One-pass first-run:** Allow **`node`** to control **Mail**, **Messages**, **Contacts**, and **Calendar** in the same Automation pass. Contacts or Calendar being allowed does **not** grant Mail or Messages — they are separate Apple Events targets. A denied Mail grant hangs `mail_send` / `mail_draft` / `mail_reply` / `mail_forward` until the client disconnects; `dry_run` never talks to Mail, so that deny is invisible until a real compose.

**Do not add `node` via the + button in System Settings → Privacy & Security → Contacts or Calendars.** On current macOS those panes often have **no Add button**, and that instruction is not the ship-gate setup — it failed on the Mini.

#### Mini ship-gate host setup

This is the first-run flow for Mail, Messages, Contacts, and Calendar **writes** on the Mac Mini. Do it on the Mini UI (or Screen Sharing to Mini), with the indexer LaunchAgent owning `node`:

1. Open **System Settings → Privacy & Security → Automation**.
2. Run write prove-out with the **indexer LaunchAgent** owning `node` (`~/.apple-tools-mcp/writer.sock` / launchd). Against the tip, with the LaunchAgent up:

   ```bash
   npm run smoke:writes -- --apply
   ```

   That is the ship-gate context. An embedded agent shell, IDE terminal, or MCP host app subprocess is **not** the ship-gate host unless the write bridge is up and the work executes inside launchd-owned `node`.
3. When prompts appear, click **Allow** for **`node`** to control **Mail**, **Messages**, **Contacts**, and **Calendar**. Watch the host — Allow **`node`** (the LaunchAgent binary), not any other app. Use whatever path the LaunchAgent plist / `which node` reports — `/Users/petercoates/.local/node/bin/node` is a Mini *example* only, not a universal path. Do **not** approve the MCP client / host app that launched a short-lived stdio server.
4. **Keep Contacts, Mail, and Messages running** on the write host (leave the apps open; do not quit them). Cold `tell application "Contacts"` under launchd often fails with `-600` / “application isn't running” instead of auto-launching — that is **not** an Automation deny. The write path launches Contacts.app before CRUD, but write reliability still requires those three apps to stay running. **Calendar does not need to stay open** (Calendar writes go through EventKit).
5. **Full Disk Access** on `node` is a separate grant and covers **reads** (Mail / Messages / Calendar / AddressBook databases). Write tools need the Automation / Apple Events grants to Mail.app (`mail_send`, `mail_draft`, `mail_reply`, `mail_forward`, and the other mail writes), Messages.app (`messages_send`), Contacts.app, and Calendar.app.
6. npm Trusted Publisher / publish tokens are unrelated to TCC. Do not confuse them with this setup.

If you dismissed a prompt, re-open **Automation** and turn the **node → Mail** / **node → Messages** / **node → Contacts** / **node → Calendar** toggles back on. `tccutil reset AppleEvents` re-arms the Automation prompt so you can Allow **`node`** again. Do not use `tccutil reset AddressBook` / `tccutil reset Calendar`, and do not add `node` via Settings **+** into the Contacts or Calendars privacy lists — those panes often have no Add button, and that is not how this ship gate is granted.

#### `dry_run` does not prove Mail Automation

`mail_send` / `mail_draft` / `mail_reply` / `mail_forward` with `dry_run=true` return immediately and never send Apple events to Mail — dry_run never talks to Mail. A TCC deny for **node → Mail** is therefore invisible until a real compose (`make new outgoing message`). The hang is **Automation denied**, not “Mail.app could not be reached” / “app not available”.

`tell application "Mail" to get name` can succeed while compose still hangs. The smoke test’s Mail step runs that real compose (then discards the outgoing message, or on an older daemon saves a clearly named Draft) so the deny fails **setup**, not a later production `mail_send`. The same Allow-via-prompt applies to **Messages** for `messages_send`; `messages_send` with `dry_run=true` likewise never talks to Messages.app. Smoke also live-enumerates Messages accounts (nothing is sent). **`--apply` fails closed if Mail, Messages, Contacts, or Calendar Automation is missing.**

#### Which process macOS is actually asking about

This is the part that decides whether writes work on your setup. macOS attributes an Apple event to the **responsible process**, not to whichever binary sent it. When an MCP client launches this server over stdio, the *client app* is responsible for everything node does — so the grant that matters belongs to the host app, not to node.

#### Reads and writes are different mechanisms

Worth separating, because they fail for different reasons and have different fixes. This applies to **both** Contacts and Calendar:

| | **Reads** (`contacts_search`, `contacts_lookup`, `calendar_date`, `calendar_free_time`, indexing) | **Writes** (`contacts_add/edit/remove`, `calendar_add/edit/remove/rsvp`) |
|---|---|---|
| How | sqlite query straight against `AddressBook-v22.abcddb` / `Calendar.sqlitedb` | Contacts.app (`CNContactStore`) / Calendar.app (EventKit) |
| Gated by | **Full Disk Access** on the responsible process | The **AddressBook** / **calendars** privacy classes, which require the host to hold `com.apple.security.personal-information.addressbook` / `…​.calendars` |
| Typical failure | `EPERM` / "unable to open database" | denial with **no prompt at all** |
| Fix | grant FDA to the responsible process | run the write where node is the responsible process |

So an `EPERM` reading `~/Library/Application Support/AddressBook/Sources/…` is almost always a Full Disk Access or attribution problem — **not** evidence of the entitlement gap. The server labels it that way in its logs so the two do not get conflated.

The entitlement gap bites on the **write** path: **a host app that cannot be granted Contacts or Calendars access blocks that CRUD no matter what node is allowed to do.**

Claude Desktop is the documented example. A `codesign` dump of the shipped app shows it carries **neither** personal-information entitlement — the only ones present are location and photos-library:

```bash
codesign -d --entitlements - /Applications/Claude.app 2>/dev/null | grep personal-information
# no com.apple.security.personal-information.addressbook
# no com.apple.security.personal-information.calendars
```

Under hardened runtime that means macOS denies AddressBook and Calendars access to anything Claude.app is responsible for, silently and without a prompt. It is a property of the host application: not a Full Disk Access problem, not a `tccutil` problem, and not something this package can patch, since one vendor cannot add entitlements to another vendor's signed app — no re-sign of Claude.app is proposed or required.

**So: Claude Desktop Contacts *and* Calendar CRUD are unsupported host limitations, not package defects.** The ship gate for both is the **Node host — Mini with Full Disk Access** (plus any Automation grants), which is exactly what the write bridge below makes available to every client.

#### The fix: let the indexer daemon own the writes

The **indexer daemon** is started by launchd, so node is the responsible process for its Apple events and macOS can grant AddressBook and Calendars access to node directly.

From 2.0.0, the daemon therefore doubles as a **write bridge**. When it is running, any MCP stdio process hands privacy-gated writes to it over a user-only unix socket at `~/.apple-tools-mcp/writer.sock` (mode 0600, inside your 0700 app directory — local only, nothing on the network). The daemon performs the write under its own TCC identity and returns what happened.

So the supported configuration for writes is: **run the indexer daemon** ([LaunchAgent setup below](#always-on-indexer-mac-mini-launchagent)) on the Mac that owns the data. Then:

| Host | Reads (incl. Contacts + Calendar) | Mail / Messages writes | Calendar CRUD | Contacts CRUD |
|------|-----------------------------------|------------------------|---------------|----------------|
| Node host: indexer daemon or `node index.js` from a terminal | Yes (FDA on node) | Yes | **Yes — ship gate host** | **Yes — ship gate host** |
| Any stdio client **with the daemon running** | Yes | Yes (via the bridge) | Yes (via the bridge) | Yes (via the bridge) |
| Claude Desktop, **no daemon running** | Yes — reads are sqlite + FDA, unaffected by the entitlements | Yes, if Claude is granted Automation for Mail/Messages | **No — host limitation** (no calendars entitlement) | **No — host limitation** (no addressbook entitlement) |

If a write is denied and no write-bridge socket is listening, the tool uses **Terminal.app + printed `process.execPath` Automation** copy — it does **not** tell MacBook users to start `apple-tools-indexer`. On Mini, when `writer.sock` is up, missing-grant copy may mention the LaunchAgent / write bridge. Contacts and Calendar denials each name their own privacy class and note that reads are unaffected.

#### Verifying Mail Automation plus Contacts and Calendar CRUD on a Node host

The smoke test drives writes through **the same dispatcher the MCP tools use**, so when the write bridge is up the work executes inside the indexer daemon. That matters: the thing being proven is the shipping path, not the Automation rights of whatever shell you happened to type the command into.

**Ship-gate procedure (Mini):** do this after the [Automation first-run](#2b-grant-automation-for-write-tools-first-run--ship-gate) above. The LaunchAgent must own `node`; an embedded agent shell, IDE terminal, or MCP host app subprocess is not the ship-gate host.

1. **Make sure the indexer LaunchAgent is running**, so the bridge is listening:

   ```bash
   pgrep -fl apple-tools-indexer
   ls -l ~/.apple-tools-mcp/writer.sock
   ```

2. **Check out the tip / unpack the tarball** you are gating, in a short-lived directory. The global install stays untouched.

3. **Dry run first.** It creates, edits, and deletes nothing on Contacts/Calendar — but it is not a no-op: it reads your contacts from the AddressBook database, calls `calendar_list_calendars` (a **live Calendar.app query and therefore a real TCC touch**), runs a **live Mail compose** (`make new outgoing message`) because `mail_send` `dry_run` never touches Mail, and live-enumerates **Messages** accounts because `messages_send` `dry_run` never touches Messages. A refused Calendar listing, Mail compose, or Messages lookup is `WARN` on a dry run. `--apply` fails closed if **Mail, Messages, Contacts, or Calendar** Automation is still denied.

   ```bash
   npm run smoke:writes
   ```

4. **Prove real CRUD.** This creates a clearly-named test contact and a test event roughly a year out, edits each, and deletes both again:

   ```bash
   node scripts/smoke-writes.js --apply                  # first writable calendar
   node scripts/smoke-writes.js --apply --calendar=Work  # pick the calendar
   node scripts/smoke-writes.js --apply --keep           # leave the test items behind
   ```

The header prints the write path it chose (`indexer daemon via write bridge` or `in this process`), and the read path (sqlite + FDA) is reported separately from the write paths (Mail.app compose, Contacts.app, Calendar.app), so a failure tells you which mechanism refused. A Mail **compose-probe** hang is **TCC / Automation denied**, not “app not available”. A `mail_send` / `mail_reply` / `mail_forward` hang after `send` is a **timeout** (`ETIMEDOUT` / `-1712`) unless Mail reports `-1743` / `-10004`; check Sent before retrying.

**The parent process matters.** With `--apply` and **no bridge listening**, the smoke test **refuses to run** rather than executing in-process and calling the result a package failure. Running it from an embedded agent shell, an IDE terminal, or a host app's subprocess is *not* the ship-gate context on its own, because macOS attributes the Apple events to that parent. Either start the LaunchAgent (preferred, and what production clients use), or run it from **Terminal.app**, where node is the responsible process, and pass `--allow-local` to acknowledge that:

```bash
node scripts/smoke-writes.js --apply --allow-local   # only from Terminal.app / launchd
```

Expected results: **PASS on the Node host with the bridge up — this is the ship gate for Mail, Messages, Contacts, and Calendar writes.** `--apply` fails closed if any of those four Automation grants is missing. On Claude Desktop with no daemon running, Contacts and Calendar CRUD are both expected to fail; that is the documented host limitation above, not a regression. Mail and Messages still need their own **node → Mail** / **node → Messages** grants; a Contacts/Calendar grant does not cover them.

### 3. Configure your MCP client

This server speaks MCP over **stdio**. Any compatible client can run it — Claude Desktop is one example, not the only one. Other stdio MCP clients work the same way: register the command below in that client's MCP settings.

**Command**

- `npx` with args `["-y", "apple-tools-mcp"]` (npm install)
- or `node` with args `["/absolute/path/to/Apple-Tools-MCP/index.js"]` (from source)

**Example: Claude Desktop**

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-tools": {
      "command": "npx",
      "args": ["-y", "apple-tools-mcp"]
    }
  }
}
```

Other clients use their own settings UI or config file. Use the same `command` and `args`; only the file path or UI differs.

MCP clients are **short-lived stdio** processes: they exit when the client closes stdin. Always-on indexing belongs on the **indexer daemon**, not a sleep-pipe wrapper around this binary.

### 4. Restart your MCP client

Quit and reopen the client so it loads the server. For Claude Desktop, fully quit (Cmd+Q) and reopen.

## Building the Index

On first use, a vector index of your emails, messages, and calendar events is built automatically. Email history is unlimited by default. This may take a while depending on the volume of data.

**Who indexes**

- **Indexer daemon running** (recommended on Mac Mini): the daemon owns `~/.apple-tools-mcp/indexer.lock` and refreshes `~/.apple-tools-mcp/vector-index/`. MCP stdio clients only search; they do not start background refresh.
- **No daemon** (default MacBook / Claude Desktop / Cursor): the MCP stdio process indexes **locally on startup**, same as previous versions, then exits when the client disconnects.

You can manually rebuild the index (stop the indexer daemon first if it is running, so it is not writing at the same time):

```bash
# Index all email history (default)
npm run build-index

# Optional: cap email lookback (e.g. for a faster test rebuild)
APPLE_TOOLS_INDEX_DAYS_BACK=30 npm run build-index
```

The index is stored in `~/.apple-tools-mcp/vector-index/`.

## Index refresh interval

Resolved **once at process start**. Precedence (highest wins):

1. `INDEX_INTERVAL_MS` environment variable (milliseconds or human form: `30s`, `1m`, `5m`, `1h`)
2. `~/.apple-tools-mcp/config.json` keys `indexInterval` or `indexIntervalMs`
3. Product default: **5 minutes** (`300000` ms) — typical MacBook / MCP local-fallback

Values are **clamped** to **15 seconds** minimum and **6 hours** maximum. Invalid JSON, unknown keys, and unparseable intervals are logged and ignored (the process does not crash). The effective interval is logged at start, for example:

```text
Effective index refresh interval: 1m (60000 ms) [source=config]
```

A warn line is also logged when clamping occurs.

### Example `~/.apple-tools-mcp/config.json` (Mac Mini)

Recommended Mini always-on interval is **1 minute**. 30 seconds is allowed (at or above the 15s floor).

```json
{
  "indexInterval": "1m"
}
```

Equivalent: `"indexIntervalMs": 60000`, or `INDEX_INTERVAL_MS=60000` (env overrides the file).

Missing `config.json` is fine — env then the 5-minute default apply.

## Always-on indexer (Mac Mini LaunchAgent)

On Mini, run the **indexer daemon**, not a sleep-pipe wrapper around `apple-tools-mcp`. Claude Desktop and other clients still attach via short-lived stdio MCP (`npx -y apple-tools-mcp` or the global `apple-tools-mcp` bin).

The daemon does two jobs: it refreshes the vector index, and it serves the **write bridge** at `~/.apple-tools-mcp/writer.sock` so stdio clients can perform Mail / Messages / Contacts / Calendar writes that their host app cannot be granted (see [step 2b](#2b-grant-automation-for-write-tools-first-run--ship-gate)). When macOS prompts, Allow **`node`** (the LaunchAgent binary) to control Mail.app, Messages.app, Contacts.app, and Calendar.app. Do not approve the MCP client / host app that launched a short-lived stdio server, and do not try to add `node` via **+** in the Contacts or Calendars privacy lists.

**Keep Contacts.app, Mail.app, and Messages.app running all the time** on the Mini (and on any MacBook that does local writes). Quitting them makes Apple Events to those apps unreliable (`-600` / “application isn't running”), which is a cold-launch miss — not a missing Automation grant. The Contacts write path launches Contacts.app before add/edit/remove, but do not rely on that instead of leaving the apps open. **Calendar.app does not need to stay open**; Calendar writes use EventKit.

The indexer does **not** post product Notification Center / `display notification` / UserNotifications toasts. `Apple Tools MCP indexer running` is a **stderr** line only (the plist redirects it to a file). That does **not** silence macOS Background Items or “running in the background” notices for `node` / the LaunchAgent — those are OS notices, and this package does not suppress them. It also does not suppress OS Allow dialogs. The [permissions command](#2b-grant-automation-for-write-tools-first-run--ship-gate) still needs those dialogs.

The bridge is created before the daemon touches the vector index, so writes stay available even when the index is missing, locked, or mid-rebuild. Confirm it after an upgrade with `ls -l ~/.apple-tools-mcp/writer.sock` (it should be a `srw-------` socket); the daemon removes it on shutdown.

**Entrypoint:** `node index.js --mode=indexer`  
**Convenience bin:** `apple-tools-indexer` (`bin/apple-tools-indexer.js`; npm global install provides it)  
**npm script (clone only):** `npm run indexer`  
**One-shot rebuild:** `npm run build-index` (stop the indexer daemon first)

LaunchAgent should invoke **node + `--mode=indexer`** on the **global** package (Mini has no git clone). LaunchAgent does not inherit your shell `PATH`, so use absolute paths from `which node` and `npm root -g`.

```bash
which node
# Use this path (and the LaunchAgent plist). Examples only — not universal:
#   Mini ship-gate host: /Users/petercoates/.local/node/bin/node
#   Apple Silicon Homebrew: /opt/homebrew/bin/node
#   Intel Homebrew / usr/local: /usr/local/bin/node

npm root -g
# Example: /opt/homebrew/lib/node_modules
```

Example `~/Library/LaunchAgents/com.apple-tools-mcp.indexer.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.apple-tools-mcp.indexer</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/opt/homebrew/lib/node_modules/apple-tools-mcp/index.js</string>
    <string>--mode=indexer</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/apple-tools-indexer.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/apple-tools-indexer.err.log</string>
</dict>
</plist>
```

Replace the node and `node_modules` paths with the values from `which node` and `npm root -g`. Load it with:

```bash
launchctl load ~/Library/LaunchAgents/com.apple-tools-mcp.indexer.plist
```

KeepAlive belongs on this indexer job only — not on the MCP stdio process.

## Available Tools

Once configured, your MCP client can use these tools:

### Universal Search

| Tool | Description |
|------|-------------|
| `smart_search` | Intelligent search across all sources - automatically determines which to search |
| `person_search` | Find ALL communication with a person across Mail, Messages, and Calendar |

### Email Tools

| Tool | Description |
|------|-------------|
| `mail_search` | Semantic search for emails with filters (sender, recipient, attachments, mailbox) |
| `mail_recent` | Get most recent emails (supports unread filter) |
| `mail_date` | Get emails from a specific date ("today", "yesterday", "Nov 13") |
| `mail_read` | Read full email content by file path |
| `mail_senders` | List most frequent email senders |
| `mail_thread` | Get all emails in a conversation thread |

### Messages Tools

| Tool | Description |
|------|-------------|
| `messages_search` | Semantic search for iMessages/SMS with filters |
| `messages_recent` | Get most recent messages |
| `messages_conversation` | Get full conversation history with a contact |
| `messages_contacts` | List all contacts you've messaged |

### Calendar Tools

| Tool | Description |
|------|-------------|
| `calendar_search` | Semantic search for events with filters |
| `calendar_date` | Get events on a specific date (live Calendar.app, not the search index) |
| `calendar_upcoming` | Get next N upcoming events |
| `calendar_week` | Get all events for current or future week |
| `calendar_free_time` | Find available time slots on a date (live Calendar.app, not the search index) |
| `calendar_recurring` | List recurring events |

### Contacts Tools

| Tool | Description |
|------|-------------|
| `contacts_search` | Search contacts by name, email, phone, or organization |
| `contacts_lookup` | Look up a specific contact's full details |

### Admin Tools

| Tool | Description |
|------|-------------|
| `rebuild_index` | Rebuild search index for one or all sources |
| `audit_index` | Audit index health and coverage |

## Write Tools (2.0.0)

Write tools change your data. They do not use the vector index, so they keep working while the indexer daemon holds the lock.

Two arguments are available on **every** write tool:

| Argument | Type | Meaning |
|----------|------|---------|
| `dry_run` | boolean | Preview only. Reports what *would* happen and changes nothing. Always wins, even together with `confirm`. |
| `confirm` | boolean | Approves an action that is otherwise blocked (deletes, multi-recipient sends). |

### Confirm / dry-run rules

- **Deletes always need `confirm: true`** — `mail_trash`, `calendar_remove`, `contacts_remove`, and `contacts_edit` when it clears every email or phone. Without it the call returns a `CONFIRMATION REQUIRED` preview and changes nothing. There is no bulk delete tool and no silent mass delete: one id per call.
- **Multi-recipient sends always need `confirm: true`** — `mail_send` / `mail_forward` when `to` + `cc` + `bcc` total more than one address, `mail_reply` with `reply_all: true`, and `messages_send` to multiple handles or to a group chat. A single-recipient send runs on the first call.
- **`mail_draft` is exempt from the recipient rule** because a draft is never delivered.
- **`dry_run` and confirm-blocked calls are not deliveries.** Planned writes return `ok: false`, `planned: true`, `delivered: false`, and MCP sets `isError: true`, so a client that only checks `isError` cannot treat a preview as sent. The text is `DRY RUN` / `CONFIRMATION REQUIRED` and never `verified in Sent`. Re-run with `dry_run=false` (and `confirm=true` when required) to actually send.
- Responses name what happened (tool, ids, recipients, titles) and never echo message bodies — including on the error path.
- Writes never invent data. A missing or malformed `message_id`, `event_id`, `contact_id`, `chat_id`, or recipient is refused with a message saying so. Calendar times must be explicit local datetimes (`YYYY-MM-DD HH:MM`); natural language such as "next Tuesday" is rejected for writes.

### Mail write tools

| Tool | Arguments | Confirm rule |
|------|-----------|--------------|
| `mail_send` | `to[]` (required), `cc[]`, `bcc[]`, `subject` (required), `body` (required), `body_format` (`plain` \| `html`) | `confirm` when total recipients > 1 |
| `mail_draft` | `to[]` (required), `cc[]`, `bcc[]`, `subject`, `body`, `body_format` | none (saved to Drafts, not sent) |
| `mail_reply` | `message_id` or `file_path`, `body` (required), `reply_all`, `save_as_draft` | `confirm` when `reply_all: true` |
| `mail_forward` | `message_id` or `file_path`, `to[]` (required), `body`, `save_as_draft` | `confirm` when recipients > 1 |
| `mail_mark` | `message_id` or `file_path`, `status` (`read` \| `unread`, default `read`) | none |
| `mail_archive` | `message_id` or `file_path` | none |
| `mail_trash` | `message_id` or `file_path` | **`confirm` required** |

`body_format: "html"` uses the same compose path with a tag-stripped body pasted into Mail's native editor. It does **not** set Mail's `content` or `html content` — those setters cite-wrap the whole message (`>` prefixes and `<blockquote type="cite">`, same iOS purple bar). Mail may still generate its own HTML alternative from the native compose. The default is plain text.

**Compose is not quoted.** `mail_send` / `mail_draft` (plain and html) call `make new outgoing message` **without** AppleScript `content:` so `newMessage` is a real Mail object, then paste the body into the compose window (System Events). Mail's `mailto` command was shipped in 2.0.4 and **fails on Mini/MacBook Mail**: it does not return an outgoing message (`newMessage` undefined, AppleScript **-2753**). On current Mail (Ventura+, FB11734014) `content` / `html content` store the body as a citation: every plain-text line prefixed with `>`, plus a `multipart/alternative` HTML part wrapped in `<blockquote type="cite">`. Desktop Mail often hides the bar with inline styles; iOS Mail paints the whole body purple with a left quote bar — even when the subject is not `Re:`/`Fwd:` and there is no `In-Reply-To`. Reply and forward still quote the original, which is expected.

Paste uses System Events, so **node needs Accessibility** (Privacy & Security → Accessibility) in addition to Automation → Mail. That Accessibility deny is not a Mail Automation deny (`-1743` / `-10004`). Body focus uses `text area` / `scroll area` / `text field` and `UI element whose role is "AXWebArea"` — never the System Events class `web area`, which does not compile on macOS 26.x (**-2741**, “Expected class name but found identifier”).

**Compose body focus (2.0.8).** After `make new outgoing message`, To and Subject are AppleScript properties (never paste). Cmd-V runs only after the caret leaves the header: a tall `AXWebArea` (HTML compose body), a tall `text area` (plain compose; short To/Subject fields are skipped), Subject then Tab, or a click in the lower two-thirds of the compose window. If focus is still a header field, the tool raises `BODY_FOCUS_FAILED` and does **not** paste. After paste it checks To/Cc/Bcc counts, the exact subject, and that the native body contains the intended text. A mismatch is `BODY_PASTE_MISDIRECTED`: the outgoing message is deleted and nothing is sent. Quote-prefix Sent prove and Sent/Outbox verify stay gated on this paste-focus contract — a MacBook 2.0.7 live `mail_send` with Accessibility allowed still hit `BODY_PASTE_MISDIRECTED` when Cmd-V landed in To/Subject (`ATP-207-SENT-PROVE-20260921-084048`).

**mail_send success is Sent/Outbox verify (2.0.7).** AppleScript `send` returning without throw is not enough. After a real send the tool looks in **Sent** and **Outbox** and reports success only if the message is there. The success text names the delivery state (`mailbox: sent` + `delivery: sent`, or `mailbox: outbox` + `delivery: outbox` while still sending). If verify misses, the tool returns a failure (`isError`) — not success. Hang/timeout recover matches **To + subject** (and Message-ID when compose captured one). It never matches subject alone (short subjects like `test` are unsafe). `from` / account selection is out of scope; Mail's default From is used.

**Manual prove (2.0.8 on the Mac host):** `mail_send` a short plain message and a short `body_format: "html"` message whose body looks like ordinary paragraphs (for example `<p>Quick note</p>`), neither with a `Re:`/`Fwd:` subject. The caret must land in the **body** (not To/Subject): no `BODY_FOCUS_FAILED` / `BODY_PASTE_MISDIRECTED`, and the intended text must be in the native body before send. Inspect each Sent `.emlx`: the text/plain part must not prefix every body line with `>`, and any HTML alternative must not wrap the whole body in `<blockquote type="cite">`. Compose must succeed (no `-2753` / undefined `newMessage`, no **-2741** on body focus). That quote-prefix dual-host Sent prove is a separate bar from the 2.0.7 verify contract.

Emails are addressed by their RFC822 **Message-ID**. Pass `message_id`, or pass the `file_path` from `mail_search` / `mail_recent` and the server reads the Message-ID out of the `.emlx` headers for you. `mail_archive` moves the message to its account's Archive (or All Mail) mailbox; `mail_trash` moves it to that account's Trash.

**Send timeout vs TCC — check Sent before retrying.** `mail_send` / `mail_reply` / `mail_forward` can hang after Mail has already put the message in Sent. That hang is a **timeout** (`ETIMEDOUT` / `-1712` / AppleEvent timed out), not a TCC deny. The same hang-vs-TCC split applies to **find / reply / open before send** — an Allowed `ETIMEDOUT` there is never `MAIL_TCC_GUIDANCE`. Real Mail Automation denials report **`-1743`**, **`-10004`**, or “not authorized to send Apple events”. After a send hang the tool looks in Sent (and Outbox) and returns **success** if the message is there — never label a delivered send as TCC fail or timeout. Replies match `In-Reply-To` or an exact recent `Re:` + original subject (the fallback compose does not set reply headers). Forwards match the intended recipient plus an exact `Fwd:` subject or the original Message-ID in a forwarded body — not `In-Reply-To`, and not an unrelated `Fwd:` that only shares a To. Compose (`mail_send`) matches the intended **To plus exact subject** (and Message-ID when available), never subject alone. Neither scan treats the original itself as this send. A real send that returns without throw is also verified the same way before success. If Sent-verify misses, the error tells you it was a hang (or a verify-miss after send returned) and to check Sent. **Clients must Sent-check before retrying a timed-out send**; retrying a message that already landed sends a second copy. This is not a silent TCC grant.

### Messages write tool

| Tool | Arguments | Confirm rule |
|------|-----------|--------------|
| `messages_send` | `to[]` or `chat_id`, `text`, `attachment_path`, `service` (`auto` \| `imessage` \| `sms`) | `confirm` for multiple handles or a group chat |

Supported identifiers:

- **`to`** — phone numbers in E.164 form (`+15551234567`) or Apple ID email addresses. These map to a Messages `participant` on the iMessage (or SMS relay) service.
- **`chat_id`** — the chat GUID of an existing conversation, for example `iMessage;-;+15551234567` (1:1) or `iMessage;+;chat123456789` (group). The GUID is checked against `~/Library/Messages/chat.db` before anything is sent, so an unknown chat id is refused rather than delivered somewhere unexpected. The same lookup counts participants, which is how group chats are detected for the confirm rule.
- **`service`** — `auto` (default) tries iMessage and falls back to the SMS relay; `imessage` and `sms` pin the service.
- **`attachment_path`** — an absolute path to a file that already exists on this Mac. Text and attachment can be sent together.

### Calendar write tools

| Tool | Arguments | Confirm rule |
|------|-----------|--------------|
| `calendar_list_calendars` | none | none (read-only helper) |
| `calendar_add` | `calendar_name` (required), `title` (required), `start` (required), `end`, `all_day`, `location`, `notes`, recurrence args, `alerts_minutes_before[]` | none |
| `calendar_edit` | `event_id` (required), optional `eventkit_id` from add, plus any of `title`, `start`, `end`, `location`, `notes`, recurrence args, `alerts_minutes_before[]`, `replace_alerts` | none |
| `calendar_remove` | `event_id` (required), optional `eventkit_id` from add, optional `calendar_name` | **`confirm` required** |
| `calendar_rsvp` | `event_id` (required), `response` (`accept` \| `decline` \| `tentative`), `attendee_email` | none |

Events are addressed by their **iCalendar UID**, reported as `Event ID` by `calendar_date` and returned by `calendar_add`. Run `calendar_list_calendars` first so new events land on the intended calendar instead of the default one.

`calendar_add`, `calendar_edit`, and `calendar_remove` share the same write-bridge RPC (`{ tool, args }` into launchd-owned node). They do not use a different socket or calendar account. Calendar.app’s dictionary has **`delete` only** — there is no `remove` or `move to trash`.

Non-recurring `calendar_add` **must** create through **EventKit** and print `via: EventKit` plus `eventkit_id`. Mini `cd74071`: EventKit had `eventKitCalendars=1` but `default=[id NSTaggedPointerString]` — JXA `String(title)` prints the ObjC class, not the calendar name, so the title match missed the only writable calendar. Titles and `calendarIdentifier` are `ObjC.unwrap`d; a single writable calendar or `defaultCalendarForNewEvents` is used when the name does not match. There is **no AppleScript fallback** for non-recurring add.

`calendar_edit` and `calendar_remove` take `eventkit_id` from add (`calendarUUID:eventUUID` on Mini). writeOnly EventKit (`status=4`) can create and read ids off the saved `EKEvent`, but **cannot re-query** via `eventWithIdentifier` — Mini `2cdf44d` failed add on that post-save lookup. Add therefore returns ids from the in-memory event. The indexer write-bridge keeps a long-lived EventKit osascript session that caches the `EKEvent` so edit/remove call `saveEvent` / `removeEvent` without a fetch. When `eventkit_id` is present and the session misses, Calendar.app uid lookup is skipped so iCloud cannot hang. `ETIMEDOUT` / `-1712` is **`timeout`**, never TCC. Failures print `osascript kind=… error=… codes=…`. `--apply` fails closed unless add printed `via: EventKit` and `eventkit_id`.

`--apply` prefers an **On My Mac** calendar when EventKit lists one. `--calendar=` still wins. The Mini host’s first writable calendar named **Calendar** (no On My Mac / iCloud label) is fine if EventKit create actually runs.

Like Contacts, calendar writes go through Calendar.app rather than writing `Calendar.sqlitedb` directly. Reads query that database for speed, but edits must go through the app so iCloud sync, invitations, and alarms behave correctly.

**Supported recurrence patterns.** Either pass structured arguments or a raw `recurrence` RRULE:

| Argument | Values |
|----------|--------|
| `frequency` | `daily`, `weekly`, `monthly`, `yearly` |
| `interval` | 1-366 (e.g. `2` with `weekly` = every other week) |
| `count` | 1-1000 occurrences (cannot be combined with `until`) |
| `until` | explicit local datetime; emitted as a UTC `UNTIL` |
| `by_day` | `MO TU WE TH FR SA SU` (weekly patterns) |
| `recurrence` | raw RRULE instead of the above, e.g. `FREQ=WEEKLY;INTERVAL=1;COUNT=10` |

`{ frequency: "weekly", interval: 2, by_day: ["MO","WE"], count: 10 }` becomes `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10`. Anything outside this grammar is refused.

**Alerts.** `alerts_minutes_before` takes up to 5 whole minute values (0 to 40320, i.e. four weeks) and creates display alarms. On `calendar_edit`, supplying alerts replaces the event's existing alarms; `replace_alerts: true` removes them without adding new ones.

**RSVP.** `calendar_rsvp` sets your attendee participation status on the invitation. Some macOS versions refuse to write that property from AppleScript; when that happens the tool says so explicitly (and asks you to answer in Calendar) rather than reporting a silent success.

### Contacts write tools

| Tool | Arguments | Confirm rule |
|------|-----------|--------------|
| `contacts_add` | `first_name`, `last_name`, `organization`, `job_title`, `emails[]`, `email_label`, `phones[]`, `phone_label` | none |
| `contacts_edit` | `contact_id` (required), any of the above, `replace_emails`, `replace_phones` | **`confirm` required** when replacing with an empty list |
| `contacts_remove` | `contact_id` (required) | **`confirm` required** |

Contacts are addressed by their Contacts.app person id (for example `ABCD1234-...:ABPerson`), reported as `Contact ID` by `contacts_search` and `contacts_lookup` and returned by `contacts_add`. At least one of `first_name`, `last_name`, or `organization` is required to create a contact. Writes go through Contacts.app, never by writing the AddressBook database directly (that breaks iCloud sync). Keep **Contacts, Mail, and Messages** running for write reliability; the Contacts write path launches Contacts.app before CRUD if it was quit. Calendar does not need to stay open (EventKit).

### Example write calls

```jsonc
// Preview first - nothing is sent
{ "name": "mail_send", "arguments": { "to": ["a@example.com"], "subject": "Status", "body": "All good", "dry_run": true } }

// Single recipient: sends on the first call
{ "name": "mail_send", "arguments": { "to": ["a@example.com"], "subject": "Status", "body": "All good" } }

// Two recipients: blocked until confirmed
{ "name": "mail_send", "arguments": { "to": ["a@example.com", "b@example.com"], "subject": "Status", "body": "All good", "confirm": true } }

// Recurring event with an alert
{ "name": "calendar_add", "arguments": { "calendar_name": "Work", "title": "Standup", "start": "2026-09-21 09:00", "end": "2026-09-21 09:15", "frequency": "weekly", "by_day": ["MO","TU","WE","TH","FR"], "alerts_minutes_before": [10] } }

// Delete: preview, then confirm
{ "name": "calendar_remove", "arguments": { "event_id": "EVT-UID", "confirm": true } }
```

### Not included

No Apple **Reminders** tools ship in this package, by design. Notes, FaceTime, and Files automation are also out of scope.

## Example Queries

Ask your MCP client things like:

- "Find emails from John about the quarterly report"
- "What messages did I get from Mom last week?"
- "When is my next dentist appointment?"
- "Search for emails about the AWS bill from November"
- "Find all calendar events with Zoom links"
- "What's Sarah's phone number?"
- "Show me all communication with David from last month"

## Privacy & Security

- **Local Processing**: All embeddings are generated locally using Xenova/Transformers
- **No Cloud Services**: No data is sent to external servers; the write bridge is a local unix socket, never a network port
- **Reads are read-only**: Search and lookup tools never modify your data. The [write tools](#write-tools-200) are the only ones that change anything, and they are opt-in per call, with `confirm` required for deletes and multi-recipient sends
- **No credentials**: The server holds no tokens or passwords. It uses the Mail, Messages, Calendar, and Contacts apps you are already signed into
- **Your Data**: The vector index is stored locally in your home directory

## Troubleshooting

### "Authorization denied" errors

Ensure Node.js has Full Disk Access (see Installation step 2).

### A write tool reports that macOS denied the automation

The message names which process macOS was actually asking about. Work through it in this order:

1. **MacBook / Terminal (`permissions` CLI):** there is **no** always-on indexer. Re-run `apple-tools-mcp permissions` from **Terminal.app**, Allow the **printed `process.execPath`**, and check System Settings → Privacy & Security → **Automation** for that node → Contacts, Calendar, Mail, and Messages. Do **not** start `apple-tools-indexer`.
2. **Mini only:** `pgrep -fl apple-tools-indexer` / `~/.apple-tools-mcp/writer.sock`. If the LaunchAgent is the product host, start it so writes run under launchd-owned node (see [Mini ship-gate](#mini-ship-gate-host-setup)).
3. **Did you approve the Automation prompts for `node`?** Re-run `apple-tools-mcp permissions` with the product `node` (it prints `process.execPath`). Open System Settings → Privacy & Security → **Automation** and confirm **that printed node** is allowed to control **Mail**, **Messages**, Contacts, and Calendar. On Mini the LaunchAgent binary is whatever the plist / `which node` reports (`/Users/petercoates/.local/node/bin/node` is a Mini *example* only). MacBook Claude nvm is `/Users/petercoates/.nvm/versions/node/v22.21.1/bin/node`, not Homebrew. Watch the host — Allow **`node`**, not any other app. Contacts or Calendar being allowed does **not** grant Mail. A `mail_send` hang is **Automation denied**, not “Mail.app could not be reached”; `dry_run` never talks to Mail so it cannot detect this. Do **not** approve the MCP client / host app that launched a short-lived stdio server, and do **not** try to add `node` via **+** in the Contacts or Calendars privacy lists — those panes often have no Add button. `tccutil reset AppleEvents` re-arms the Automation prompt so you can Allow **`node`** again. Full Disk Access is a separate read grant; npm Trusted Publisher / tokens are unrelated.
4. **Mini: is the daemon's node binary the one with Full Disk Access?** LaunchAgents do not inherit your shell `PATH`; confirm the plist points at the same path `which node` reports.
5. **Is it actually the write path?** Contacts or Calendar *reads* failing with `EPERM` is a Full Disk Access / attribution problem, not the entitlement gap — fix FDA for the responsible process. Contacts or Calendar *CRUD* failing with no prompt under Claude Desktop is the [documented host limitation](#reads-and-writes-are-different-mechanisms): Claude.app carries neither the addressbook nor the calendars entitlement. On Mini, start the daemon so the write goes through the bridge. On MacBook, use Terminal.app + the printed node.
6. **"Contacts.app / Calendar.app could not be reached"** with the app clearly installed is an **Automation / responsible-process** failure, not a missing app — macOS reports a refused Apple event as `-1728` / "can't get application". On MacBook / Terminal, Allow the printed `process.execPath`. On Mini, the write bridge / LaunchAgent may apply. A Contacts `-600` / “application isn't running” is a **cold launch**, not Automation — keep Contacts, Mail, and Messages running; Calendar does not need to stay open.
7. **`calendar_remove` FAIL after add/edit PASS** is a delete-path failure, not missing Calendar Automation. Same write-bridge RPC. Read the `osascript kind=/error=` line: `kind=timeout` + `ETIMEDOUT` / `-1712` is an iCloud/CalDAV hang or Calendar confirmation dialog — **not** TCC. `EVENTKIT_NOT_FOUND status=4` is writeOnly EventKit failing to see an AppleScript-created event (add must go through EventKit). `-1743` / `-10004` is a real Automation deny. Paste that line if it still FAILs.
8. **Prove the Mini host itself works** with `node scripts/smoke-writes.js --apply` on the Node host with the LaunchAgent running; it routes through the bridge and separates the read and write mechanisms for you.

### A write returned "CONFIRMATION REQUIRED"

That is the safety gate, not a failure. Deletes and multi-recipient sends need `confirm: true`; the message states exactly what would have happened. Use `dry_run: true` for a preview.

### Empty search results

1. Check that the index was built: `ls ~/.apple-tools-mcp/vector-index/`
2. Rebuild the index if needed: `npm run build-index`

### Server not appearing in the MCP client

1. Verify your client config is valid (JSON files must be valid JSON)
2. Restart the MCP client completely (for Claude Desktop: Cmd+Q, then reopen)
3. Check the client's MCP logs for errors

### Force rebuild the index

If the index becomes corrupted or out of sync:

```bash
# If the Mini indexer LaunchAgent is running, unload it first
# launchctl unload ~/Library/LaunchAgents/com.apple-tools-mcp.indexer.plist

# Remove existing index files
rm -rf ~/.apple-tools-mcp/vector-index
rm -f ~/.apple-tools-mcp/index-meta.json
rm -f ~/.apple-tools-mcp/indexer.lock

# Restart the indexer daemon or your MCP client to trigger a fresh rebuild
```

### Monitor indexing progress

Watch the MCP server logs in your client. Log locations vary by client; Claude Desktop example:

```bash
tail -f ~/Library/Logs/Claude/mcp-server-apple-tools.log
```

### Audit the index

Check index health and coverage:

```bash
# Quick audit
npm run audit

# Detailed audit saved to file
npm run audit -- --reporter=verbose > audit-report.txt
```

## Development

```bash
# Clone the repo
git clone https://github.com/sfls1397/Apple-Tools-MCP.git
cd Apple-Tools-MCP

# Install dependencies
npm install

# Install test dependencies
npm install -D vitest @vitest/coverage-v8 fast-check

# Run tests
npm test

# Run the indexer daemon (owns indexer.lock + vector-index refresh)
npm run indexer

# One-shot rebuild (stop the indexer daemon first)
npm run build-index

# Run tests with verbose coverage report
npx vitest run --coverage --reporter=verbose

# Run audit to check index health
npm run audit

# Prove the write path on this host (dry run)
npm run smoke:writes

# Real CRUD — the extra -- is required so npm forwards --apply
npm run smoke:writes -- --apply
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run the tests: `npm test`
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk)
- Vector search powered by [LanceDB](https://lancedb.com/)
- Local embeddings via [Xenova/Transformers](https://github.com/xenova/transformers.js)
