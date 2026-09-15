# apple-tools-mcp

An MCP (Model Context Protocol) server that provides semantic search across Apple Mail, Messages, Calendar, and Contacts on macOS. Use natural language to search your emails, iMessages, calendar events, and contacts from any compatible MCP client over stdio.

## Features

- **Semantic Search**: Find emails, messages, and events using natural language queries
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

### 3. Configure your MCP client

This server speaks MCP over **stdio**. Any compatible client can run it — Claude Desktop is one example, not the only one. Cursor, Grok Bot, and other stdio MCP clients work the same way: register the command below in that client's MCP settings.

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

On Mini, run the **indexer daemon**, not a sleep-pipe wrapper around `apple-tools-mcp`. Grok Bot, Claude Desktop, and other clients still attach via short-lived stdio MCP (`npx -y apple-tools-mcp` or the global `apple-tools-mcp` bin).

**Entrypoint:** `node index.js --mode=indexer`  
**Convenience bin:** `apple-tools-indexer` (same file; npm global install provides it)  
**npm script (clone only):** `npm run indexer`  
**One-shot rebuild:** `npm run build-index` (stop the indexer daemon first)

LaunchAgent should invoke **node + `--mode=indexer`** on the **global** package (Mini has no git clone). LaunchAgent does not inherit your shell `PATH`, so use absolute paths from `which node` and `npm root -g`.

```bash
which node
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
- **No Cloud Services**: No data is sent to external servers
- **Read-Only**: The server only reads data, never modifies your Mail/Messages/Calendar
- **Your Data**: The vector index is stored locally in your home directory

## Troubleshooting

### "Authorization denied" errors

Ensure Node.js has Full Disk Access (see Installation step 2).

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
