# apple-tools-mcp

An MCP (Model Context Protocol) server for Apple Mail, Messages, Calendar, and Contacts on macOS. Search them in plain language, send mail and messages, and create, edit, or remove calendar events and contacts. It talks to any MCP client over stdio. Search embeddings and the write bridge stay on your Mac.

## Requirements

- macOS
- Node.js 18 or later
- The permissions below, on the Mac that holds the Mail, Messages, Calendar, and Contacts data

## Setup

### 1. Install

```bash
npm install -g apple-tools-mcp
```

Or from source:

```bash
git clone https://github.com/sfls1397/Apple-Tools-MCP.git
cd Apple-Tools-MCP
npm install
```

A global install uses `npx` in the client config below. A clone uses `node` and the full path to `index.js`.

After you install or upgrade, run the permissions command in the next section. `npm install` only prints a reminder. It cannot click Allow for you.

### 2. Permissions

Two grants, and they do different jobs.

**Full Disk Access** lets the server read the Mail, Messages, Calendar, and Contacts databases.

**Automation** lets it send mail, send messages, and change calendar events and contacts through those apps. Mail compose also needs **Accessibility**, because the message body is pasted into Mail's window through System Events.

#### Full Disk Access

1. In Terminal, run `which node` and copy the path it prints.
2. Open **System Settings → Privacy & Security → Full Disk Access**.
3. Click **+**.
4. Press **Cmd+Shift+G**, paste the path, and press Enter.
5. Select `node` and turn its toggle on.

#### Automation, Accessibility, and System Events

Run this from **Terminal.app**, so the prompts attach to node and not to your editor or chat app:

```bash
$(which node) $(which apple-tools-mcp) permissions
```

From a clone, `npm run permissions` does the same thing. `npx apple-tools-mcp permissions` also works.

The command prints `process.execPath`. That path is the node binary macOS will ask about. Click **Allow** for that binary. If it warns that the command you typed started a different node, run it again with the printed path in front:

```bash
/absolute/path/to/node $(which apple-tools-mcp) permissions
```

Allow **node** to control Mail, Messages, Contacts, Calendar, and System Events. Each app is its own switch. Allowing Contacts does not allow Mail.

Then open **System Settings → Privacy & Security → Accessibility** and turn on the same node binary. Without that, Mail compose cannot paste the body.

The command does real work so the prompts can appear. It opens a Mail compose window and throws it away (nothing is sent), lists Messages accounts (nothing is sent), creates and deletes a throwaway contact, lists calendars without creating events, and checks System Events. It exits with an error until Mail, Messages, Contacts, Calendar, and System Events are all allowed.

`dry_run` on `mail_send` or `messages_send` does not talk to those apps, so a dry run will not pop the prompts and will not tell you whether Automation is allowed. A real send that hangs after you denied Mail is an Automation denial, not "Mail could not be reached."

If you clicked **Don't Allow**, macOS will not ask again. Open **System Settings → Privacy & Security → Automation**, turn the switch on for that node and that app, then run `apple-tools-mcp permissions` again.

Do not add node with the **+** button under **Privacy & Security → Contacts** or **Calendars**. Those lists are not how these writes are granted, and on current macOS they often have no Add button.

Leave **Mail, Messages, and Contacts** running. If they are quit, writes to them often fail even when Automation is allowed. Calendar does not need to stay open.

#### If your chat app cannot hold the grants

macOS treats these actions as coming from the app that launched the server. A chat app that starts a short-lived MCP process is that app. Some of them cannot be granted Contacts or Calendar access, no matter what you allow for node.

Run the indexer in the next section. It is a normal node process, so the Automation grants you gave node apply. Your MCP client sends writes to it through a local socket at `~/.apple-tools-mcp/writer.sock`. When a prompt appears, allow **node**, not the chat app.

### 3. Connect your MCP client

Any stdio MCP client can run the server. The command is the same; only the client's settings screen changes.

Global install:

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

From a clone, use `node` and the absolute path to `index.js` instead of `npx`.

Claude Desktop keeps this in `~/Library/Application Support/Claude/claude_desktop_config.json`. Quit the client completely and reopen it after you save.

The MCP process is short-lived: it exits when the client disconnects. Ongoing indexing belongs on the indexer, not on a wrapper that holds this process open.

### 4. Indexer

On first use the server builds a search index of your mail, messages, and calendar events. That can take a while if you have a lot of mail. The index is stored in `~/.apple-tools-mcp/vector-index/`.

Run the indexer so the index stays current and so writes go through node:

```bash
apple-tools-indexer
```

That command is `node index.js --mode=indexer`. A global install provides `apple-tools-indexer` (`bin/apple-tools-indexer.js`). From a clone, use `npm run indexer`.

To keep it running across logins, use a LaunchAgent. LaunchAgents do not see your shell `PATH`, so put in the absolute paths from `which node` and `npm root -g`.

Save this as `~/Library/LaunchAgents/com.apple-tools-mcp.indexer.plist` and replace both paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.apple-tools-mcp.indexer</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/path/to/node_modules/apple-tools-mcp/index.js</string>
    <string>--mode=indexer</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/apple-tools-indexer.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/apple-tools-indexer.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.apple-tools-mcp.indexer.plist
```

The refresh interval is chosen once, when the process starts. The default is 5 minutes. Set `INDEX_INTERVAL_MS` (`30s`, `1m`, `1h`, or a number of milliseconds) or add this to `~/.apple-tools-mcp/config.json`:

```json
{
  "indexInterval": "1m"
}
```

Values are clamped to 15 seconds through 6 hours. A missing config file is fine; the 5-minute default is used.

If you do not run the indexer, the MCP process indexes when it starts, then exits when the client disconnects. Writes then run inside that process, and macOS attributes them to the app that launched it.

### 5. Another computer (optional)

The same tools are available over HTTP, with a bearer token on every request. stdio on this Mac does not use the token.

```bash
apple-tools-http
apple-tools-mcp http-token
```

`~/.apple-tools-mcp/config.json` (the same file as the index interval):

```json
{
  "httpHost": "127.0.0.1",
  "httpPort": 8421
}
```

`127.0.0.1` accepts connections only on this Mac. Set `httpHost` to a LAN or Tailscale address when a client on another machine should connect. `APPLE_TOOLS_HTTP_HOST` and `APPLE_TOOLS_HTTP_PORT` override the file. Do not send the token over an open network.

An example LaunchAgent is `examples/com.apple-tools-http.plist`. How to point Claude and other clients at it, including `apple-tools-http-proxy`, is in `examples/mcp-client.md`.

## Index commands

Stop the indexer before a manual rebuild so two processes are not writing the index at once.

```bash
# Rebuild (all email history)
npm run build-index

# Optional shorter email lookback
APPLE_TOOLS_INDEX_DAYS_BACK=30 npm run build-index
```

Your client can also call `rebuild_index`.

Force a clean rebuild when the index is corrupt or out of date:

```bash
launchctl unload ~/Library/LaunchAgents/com.apple-tools-mcp.indexer.plist

rm -rf ~/.apple-tools-mcp/vector-index
rm -f ~/.apple-tools-mcp/index-meta.json
rm -f ~/.apple-tools-mcp/indexer.lock
```

Start the indexer or your MCP client again so it builds a new index.

Watch progress. With the LaunchAgent above:

```bash
tail -f /tmp/apple-tools-indexer.err.log
```

Client logs depend on the app. Claude Desktop:

```bash
tail -f ~/Library/Logs/Claude/mcp-server-apple-tools.log
```

Audit coverage against the source databases:

```bash
npm run audit
npm run audit -- --reporter=verbose > audit-report.txt
```

Your client can also call `audit_index`.

## Available tools

### Universal search

| Tool | Description |
|------|-------------|
| `smart_search` | Search across mail, messages, and calendar. Picks the sources from the question. |
| `person_search` | Find communication with one person across Mail, Messages, and Calendar. |

### Email

| Tool | Description |
|------|-------------|
| `mail_search` | Semantic search, with filters for sender, recipient, attachments, and mailbox. |
| `mail_recent` | Most recent emails. Can limit to unread. |
| `mail_date` | Emails from a date such as "today", "yesterday", or "Nov 13". |
| `mail_read` | Full email content by file path. |
| `mail_senders` | Most frequent senders. |
| `mail_thread` | Every email in a conversation. |

### Messages

| Tool | Description |
|------|-------------|
| `messages_search` | Semantic search for iMessage and SMS, with filters. |
| `messages_recent` | Most recent messages. |
| `messages_conversation` | Full conversation with a contact. |
| `messages_contacts` | Contacts you have messaged. |

### Calendar

| Tool | Description |
|------|-------------|
| `calendar_search` | Semantic search for events, with filters. |
| `calendar_date` | Events on a date, read live from Calendar rather than the search index. |
| `calendar_upcoming` | Next upcoming events. |
| `calendar_week` | Events for this week or a future week. |
| `calendar_free_time` | Open time on a date, read live from Calendar rather than the search index. |
| `calendar_recurring` | Recurring events. |

### Contacts

| Tool | Description |
|------|-------------|
| `contacts_search` | Search by name, email, phone, or organization. |
| `contacts_lookup` | Full details for one contact. |

### Index

| Tool | Description |
|------|-------------|
| `rebuild_index` | Rebuild the search index for one source or all of them. |
| `audit_index` | Check index health and coverage. |

## Write tools

Write tools change your data. They do not use the search index, so they work while the indexer is rebuilding.

Every write tool accepts:

| Argument | Meaning |
|----------|---------|
| `dry_run` | Preview only. Nothing is sent or changed. This wins even if `confirm` is also set. |
| `confirm` | Approves an action that is otherwise blocked. |

Deletes need `confirm: true`: `mail_trash`, `calendar_remove`, `contacts_remove`, and `contacts_edit` when it clears every email or phone. One id per call. There is no bulk delete.

Sends to more than one person need `confirm: true`: `mail_send` and `mail_forward` when To, Cc, and Bcc add up to more than one address, `mail_reply` with `reply_all: true`, and `messages_send` to several people or to a group chat. A single recipient sends on the first call. `mail_draft` never sends, so it does not need that confirm.

A dry run or a call that still needs confirm does not deliver anything. The result is `ok: false`, `planned: true`, `delivered: false`, and the client may mark it as an error. The text says `DRY RUN` or `CONFIRMATION REQUIRED`. Run it again with `dry_run` false, and with `confirm: true` when the tool asked for it.

Responses name the action, ids, and recipients. They do not echo message bodies.

A missing or malformed id or recipient is refused. Calendar times are local datetimes, `YYYY-MM-DD HH:MM`. Phrases like "next Tuesday" are rejected on writes.

### Mail

| Tool | Arguments | Confirm |
|------|-----------|---------|
| `mail_send` | `to[]` (required), `cc[]`, `bcc[]`, `subject` (required), `body` (required), `body_format` (`plain` or `html`) | when recipients > 1 |
| `mail_draft` | `to[]` (required), `cc[]`, `bcc[]`, `subject`, `body`, `body_format` | no (saved to Drafts) |
| `mail_reply` | `message_id` or `file_path`, `body` (required), `reply_all`, `save_as_draft` | when `reply_all` is true |
| `mail_forward` | `message_id` or `file_path`, `to[]` (required), `body`, `save_as_draft` | when recipients > 1 |
| `mail_mark` | `message_id` or `file_path`, `status` (`read` or `unread`, default `read`) | no |
| `mail_archive` | `message_id` or `file_path` | no |
| `mail_trash` | `message_id` or `file_path` | yes |

Pass the RFC822 Message-ID, or the `file_path` from `mail_search` or `mail_recent` and the server reads the Message-ID from the file. `mail_archive` moves the message to that account's Archive (or All Mail). `mail_trash` moves it to Trash.

`body_format: "html"` pastes the text into Mail's compose window. Mail may still create its own HTML version. New mail is a new message, not a quoted reply. Reply and forward still include the original.

A send is successful only after the message is in **Sent** or still in **Outbox**. If the call times out, check Sent before you try again. Retrying a message that already went out sends a second copy. A timeout is not the same thing as a denied Automation prompt.

Compose needs the Accessibility and System Events grants from the permissions section.

### Messages

| Tool | Arguments | Confirm |
|------|-----------|---------|
| `messages_send` | `to[]` or `chat_id`, `text`, `attachment_path`, `service` (`auto`, `imessage`, or `sms`) | several handles, or a group chat |

- `to` is a phone number in E.164 form (`+15551234567`) or an Apple ID email.
- `chat_id` is an existing conversation id, such as `iMessage;-;+15551234567` or `iMessage;+;chat123456789`. It is checked against Messages before anything is sent. That lookup is also how group chats are detected.
- `service`: `auto` (default) tries iMessage and can fall back to SMS; `imessage` and `sms` pin the service.
- `attachment_path` is an absolute path to a file that already exists on this Mac. Text and a file can go together.

### Calendar

| Tool | Arguments | Confirm |
|------|-----------|---------|
| `calendar_list_calendars` | none | no. Lists calendars so you can pick one. |
| `calendar_add` | `calendar_name` (required), `title` (required), `start` (required), `end`, `all_day`, `location`, `notes`, recurrence, `alerts_minutes_before[]` | no |
| `calendar_edit` | `event_id` (required), optional `eventkit_id` from add, plus any of `title`, `start`, `end`, `location`, `notes`, recurrence, `alerts_minutes_before[]`, `replace_alerts` | no |
| `calendar_remove` | `event_id` (required), optional `eventkit_id` from add, optional `calendar_name` | yes |
| `calendar_rsvp` | `event_id` (required), `response` (`accept`, `decline`, or `tentative`), `attendee_email` | no |

`calendar_date` and `calendar_add` report the event id. Pass that id to edit, remove, and RSVP. Run `calendar_list_calendars` first so a new event lands on the calendar you mean. `calendar_add` also returns `eventkit_id`; pass it back on edit and remove.

Recurrence is either structured fields or one raw rule:

| Argument | Values |
|----------|--------|
| `frequency` | `daily`, `weekly`, `monthly`, `yearly` |
| `interval` | 1–366 |
| `count` | 1–1000 occurrences. Do not combine with `until`. |
| `until` | local datetime |
| `by_day` | `MO` `TU` `WE` `TH` `FR` `SA` `SU` |
| `recurrence` | a raw rule such as `FREQ=WEEKLY;INTERVAL=1;COUNT=10` |

`alerts_minutes_before` takes up to five values, from 0 to 40320 minutes (four weeks). On edit, supplying alerts replaces the existing ones. `replace_alerts: true` removes them without adding new ones.

`calendar_rsvp` sets your response on an invitation. If that macOS version will not write it, the tool says so instead of pretending it worked.

### Contacts

| Tool | Arguments | Confirm |
|------|-----------|---------|
| `contacts_add` | `first_name`, `last_name`, `organization`, `job_title`, `emails[]`, `email_label`, `phones[]`, `phone_label` | no |
| `contacts_edit` | `contact_id` (required), any of the add fields, `replace_emails`, `replace_phones` | yes, when replacing with an empty list |
| `contacts_remove` | `contact_id` (required) | yes |

Use the contact id from `contacts_search`, `contacts_lookup`, or `contacts_add`. Creating a contact needs at least one of `first_name`, `last_name`, or `organization`. Writes go through Contacts, which keeps iCloud in sync.

### Examples

```jsonc
{ "name": "mail_send", "arguments": { "to": ["a@example.com"], "subject": "Status", "body": "All good", "dry_run": true } }

{ "name": "mail_send", "arguments": { "to": ["a@example.com"], "subject": "Status", "body": "All good" } }

{ "name": "mail_send", "arguments": { "to": ["a@example.com", "b@example.com"], "subject": "Status", "body": "All good", "confirm": true } }

{ "name": "calendar_add", "arguments": { "calendar_name": "Work", "title": "Standup", "start": "2026-09-21 09:00", "end": "2026-09-21 09:15", "frequency": "weekly", "by_day": ["MO","TU","WE","TH","FR"], "alerts_minutes_before": [10] } }

{ "name": "calendar_remove", "arguments": { "event_id": "EVT-UID", "confirm": true } }
```

This package does not include Reminders, Notes, FaceTime, or Files.

## Example questions

- "Find emails from John about the quarterly report"
- "What messages did I get from Mom last week?"
- "When is my next dentist appointment?"
- "Search for emails about the AWS bill from November"
- "Find all calendar events with Zoom links"
- "What's Sarah's phone number?"
- "Show me all communication with David from last month"

## Privacy

Search and the index read your mail, messages, calendar, and contacts on this Mac. Write tools send messages and change events and contacts. Deletes and multi-recipient sends wait for `confirm`.

Embeddings are computed locally. Nothing is uploaded. The write bridge is a socket in your home directory, not a network port. The server stores no passwords; it uses the Apple apps you are already signed into. The index stays in `~/.apple-tools-mcp/`.

## Troubleshooting

**"Authorization denied" or the databases will not open.** Full Disk Access is missing or it was granted to a different `node` than the one that is running. Repeat the Full Disk Access steps with `which node`.

**A write is denied, or sending mail hangs.** Automation was not granted for the node that is actually running. Run `apple-tools-mcp permissions` from Terminal.app and allow the printed `process.execPath` for Mail, Messages, Contacts, Calendar, and System Events. Allow node, not the chat app. If you previously clicked Don't Allow, turn the switch on in Automation and run the command again. `dry_run` does not talk to Mail, so it will not catch this.

**"CONFIRMATION REQUIRED".** The safety check worked. Pass `confirm: true`, or use `dry_run: true` if you only wanted a preview.

**Search returns nothing.** Check `ls ~/.apple-tools-mcp/vector-index/`. If it is missing or stale, rebuild with the commands above.

**The server does not show up in the client.** Confirm the config is valid JSON, then quit the client completely and reopen it.

## Development

```bash
git clone https://github.com/sfls1397/Apple-Tools-MCP.git
cd Apple-Tools-MCP
npm install
npm test
npm run indexer
npm run build-index
npm run audit
npm run smoke:writes
npm run smoke:writes -- --apply
```

`npm run smoke:writes` checks the write path without creating lasting contacts or events. `npm run smoke:writes -- --apply` performs real creates, edits, and deletes, then removes the test items. The extra `--` is required so npm forwards `--apply`. `--apply` fails if Mail, Messages, Contacts, or Calendar Automation is missing.

## License

MIT License. See [LICENSE](LICENSE).

## Acknowledgments

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk)
- [LanceDB](https://lancedb.com/)
- [Hugging Face Transformers.js](https://github.com/huggingface/transformers.js)
