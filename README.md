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

**Do not add `node` via the + button in System Settings → Privacy & Security → Contacts or Calendars.** On current macOS those panes often have **no Add button**, and that instruction is not the ship-gate setup — it failed on the Mini.

#### Mini ship-gate host setup

This is the first-run flow for Contacts and Calendar **writes** on the Mac Mini. Do it on the Mini UI (or Screen Sharing to Mini), with the indexer LaunchAgent owning `node`:

1. Open **System Settings → Privacy & Security → Automation**.
2. Run write prove-out with the **indexer LaunchAgent** owning `node` (`~/.apple-tools-mcp/writer.sock` / launchd). Against the tip, with the LaunchAgent up:

   ```bash
   npm run smoke:writes --apply
   ```

   That is the ship-gate context. An embedded agent shell, IDE terminal, or MCP host app subprocess is **not** the ship-gate host unless the write bridge is up and the work executes inside launchd-owned `node`.
3. When prompts appear, click **Allow** for **`node`** — on this Mini that is `/Users/petercoates/.local/node/bin/node` — to control **Contacts** and **Calendar**. Do **not** approve the MCP client / host app that launched a short-lived stdio server. Other machines use whatever path the LaunchAgent plist / `which node` reports.
4. **Full Disk Access** on `node` is a separate grant and covers **reads** (Mail / Messages / Calendar / AddressBook databases). Contacts and Calendar **writes** need the Automation / Apple Events grants to Contacts.app and Calendar.app.
5. npm Trusted Publisher / publish tokens are unrelated to TCC. Do not confuse them with this setup.

If you dismissed a prompt, re-open **Automation** and turn the **node → Contacts** / **node → Calendar** toggles back on. `tccutil reset AppleEvents` re-arms Automation prompts. Do not use `tccutil reset AddressBook` / `tccutil reset Calendar` as a substitute for adding `node` to those privacy lists — that is not how this ship gate is granted.

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

If a write is denied and no daemon is listening, the tool says so and tells you to start `apple-tools-indexer`, rather than failing with a bare AppleScript error. Contacts and Calendar denials each name their own privacy class and note that reads are unaffected.

#### Verifying Contacts and Calendar CRUD on a Node host

The smoke test drives writes through **the same dispatcher the MCP tools use**, so when the write bridge is up the work executes inside the indexer daemon. That matters: the thing being proven is the shipping path, not the Automation rights of whatever shell you happened to type the command into.

**Ship-gate procedure (Mini):** do this after the [Automation first-run](#2b-grant-automation-for-write-tools-first-run--ship-gate) above. The LaunchAgent must own `node`; an embedded agent shell, IDE terminal, or MCP host app subprocess is not the ship-gate host.

1. **Make sure the indexer LaunchAgent is running**, so the bridge is listening:

   ```bash
   pgrep -fl apple-tools-indexer
   ls -l ~/.apple-tools-mcp/writer.sock
   ```

2. **Check out the tip / unpack the tarball** you are gating, in a short-lived directory. The global install stays untouched.

3. **Dry run first.** It creates, edits, and deletes nothing — but it is not a no-op: it reads your contacts from the AddressBook database and calls `calendar_list_calendars`, which is a **live Calendar.app query and therefore a real TCC touch** that can raise an Automation prompt or be denied. Because the run changes nothing, a refused listing is reported as `WARN` rather than failing the run.

   ```bash
   npm run smoke:writes
   ```

4. **Prove real CRUD.** This creates a clearly-named test contact and a test event roughly a year out, edits each, and deletes both again:

   ```bash
   node scripts/smoke-writes.js --apply                  # first writable calendar
   node scripts/smoke-writes.js --apply --calendar=Work  # pick the calendar
   node scripts/smoke-writes.js --apply --keep           # leave the test items behind
   ```

The header prints the write path it chose (`indexer daemon via write bridge` or `in this process`), and the read path (sqlite + FDA) is reported separately from the two write paths (Contacts.app, Calendar.app), so a failure tells you which mechanism refused.

**The parent process matters.** With `--apply` and **no bridge listening**, the smoke test **refuses to run** rather than executing in-process and calling the result a package failure. Running it from an embedded agent shell, an IDE terminal, or a host app's subprocess is *not* the ship-gate context on its own, because macOS attributes the Apple events to that parent. Either start the LaunchAgent (preferred, and what production clients use), or run it from **Terminal.app**, where node is the responsible process, and pass `--allow-local` to acknowledge that:

```bash
node scripts/smoke-writes.js --apply --allow-local   # only from Terminal.app / launchd
```

Expected results: **PASS on the Node host with the bridge up — this is the ship gate for Contacts and Calendar writes.** On Claude Desktop with no daemon running, Contacts and Calendar CRUD are both expected to fail; that is the documented host limitation above, not a regression.

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

The daemon does two jobs: it refreshes the vector index, and it serves the **write bridge** at `~/.apple-tools-mcp/writer.sock` so stdio clients can perform Contacts/Calendar writes that their host app cannot be granted (see [step 2b](#2b-grant-automation-for-write-tools-first-run--ship-gate)). When macOS prompts, Allow **`node`** (the LaunchAgent binary) to control Contacts.app and Calendar.app. Do not approve the MCP client / host app that launched a short-lived stdio server, and do not try to add `node` via **+** in the Contacts or Calendars privacy lists.

The bridge is created before the daemon touches the vector index, so writes stay available even when the index is missing, locked, or mid-rebuild. Confirm it after an upgrade with `ls -l ~/.apple-tools-mcp/writer.sock` (it should be a `srw-------` socket); the daemon removes it on shutdown.

**Entrypoint:** `node index.js --mode=indexer`  
**Convenience bin:** `apple-tools-indexer` (same file; npm global install provides it)  
**npm script (clone only):** `npm run indexer`  
**One-shot rebuild:** `npm run build-index` (stop the indexer daemon first)

LaunchAgent should invoke **node + `--mode=indexer`** on the **global** package (Mini has no git clone). LaunchAgent does not inherit your shell `PATH`, so use absolute paths from `which node` and `npm root -g`.

```bash
which node
# This Mini (ship-gate host): /Users/petercoates/.local/node/bin/node
# Apple Silicon Homebrew example: /opt/homebrew/bin/node
# Intel Homebrew / usr/local example: /usr/local/bin/node

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

`body_format: "html"` sets Mail's `html content` and keeps a tag-stripped plain-text alternative in `content`; the default is plain text. HTML support is whatever Mail.app offers — if a Mail version rejects the property, the message still goes out as plain text.

Emails are addressed by their RFC822 **Message-ID**. Pass `message_id`, or pass the `file_path` from `mail_search` / `mail_recent` and the server reads the Message-ID out of the `.emlx` headers for you. `mail_archive` moves the message to its account's Archive (or All Mail) mailbox; `mail_trash` moves it to that account's Trash.

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
| `calendar_edit` | `event_id` (required) plus any of `title`, `start`, `end`, `location`, `notes`, recurrence args, `alerts_minutes_before[]`, `replace_alerts` | none |
| `calendar_remove` | `event_id` (required) | **`confirm` required** |
| `calendar_rsvp` | `event_id` (required), `response` (`accept` \| `decline` \| `tentative`), `attendee_email` | none |

Events are addressed by their **iCalendar UID**, reported as `Event ID` by `calendar_date` and returned by `calendar_add`. Run `calendar_list_calendars` first so new events land on the intended calendar instead of the default one.

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

Contacts are addressed by their Contacts.app person id (for example `ABCD1234-...:ABPerson`), reported as `Contact ID` by `contacts_search` and `contacts_lookup` and returned by `contacts_add`. At least one of `first_name`, `last_name`, or `organization` is required to create a contact. Writes go through Contacts.app, never by writing the AddressBook database directly (that breaks iCloud sync).

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

1. **Is the indexer daemon running?** `pgrep -fl apple-tools-indexer`. If not, start it — the daemon is the supported host for Contacts and Calendar writes (see [step 2b](#2b-grant-automation-for-write-tools-first-run--ship-gate)).
2. **Did you approve the Automation prompts for `node`?** Open System Settings → Privacy & Security → **Automation** and confirm **node** (the LaunchAgent binary; on this Mini `/Users/petercoates/.local/node/bin/node`) is allowed to control Contacts and Calendar. Do **not** approve the MCP client / host app that launched a short-lived stdio server, and do **not** try to add `node` via **+** in the Contacts or Calendars privacy lists — those panes often have no Add button. `tccutil reset AppleEvents` re-arms Automation prompts. Full Disk Access is a separate read grant; npm Trusted Publisher / tokens are unrelated.
3. **Is the daemon's node binary the one with Full Disk Access?** LaunchAgents do not inherit your shell `PATH`; confirm the plist points at the same path `which node` reports.
4. **Is it actually the write path?** Contacts or Calendar *reads* failing with `EPERM` is a Full Disk Access / attribution problem, not the entitlement gap — fix FDA for the responsible process. Contacts or Calendar *CRUD* failing with no prompt under Claude Desktop is the [documented host limitation](#reads-and-writes-are-different-mechanisms): Claude.app carries neither the addressbook nor the calendars entitlement. Start the daemon and the write succeeds through the bridge.
5. **"Contacts.app / Calendar.app could not be reached"** with the app clearly installed is an **Automation / responsible-process** failure, not a missing app — macOS reports a refused Apple event as `-1728` / "can't get application". The tool says so and points at the bridge. Start the LaunchAgent, or run from Terminal.app and approve the Automation prompt.
6. **Prove the host itself works** with `node scripts/smoke-writes.js --apply` on the Node host with the LaunchAgent running; it routes through the bridge and separates the read and write mechanisms for you.

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

# Prove the write path on this host (dry run; add --apply for real CRUD)
npm run smoke:writes
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
