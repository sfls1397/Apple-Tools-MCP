# apple-tools-mcp

An MCP (Model Context Protocol) server that provides semantic search across Apple Mail, Messages, Calendar, and Contacts on macOS. Use natural language to search your emails, iMessages, calendar events, and contacts directly from Claude.

## Features

- **Semantic Search**: Find emails, messages, and events using natural language queries
- **Vector Indexing**: Uses LanceDB for fast similarity search with local embeddings
- **Privacy-First**: All processing happens locally on your Mac - no data leaves your machine
- **Smart Deduplication**: Handles IMAP duplicates, prioritizing INBOX over Junk/Trash
- **Date Intelligence**: Understands queries like "last week", "yesterday", "March 2024"

## Requirements

- **macOS** (Ventura 13.0 or later recommended)
- **Node.js** 18.0 or later
- **Claude Desktop** app
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

If you installed from source, point Claude Desktop at the local `index.js` instead of `npx` in step 3:

```json
"command": "node",
"args": ["/absolute/path/to/Apple-Tools-MCP/index.js"]
```

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

### 3. Configure Claude Desktop

Add to your Claude Desktop config file:

**Location:** `~/Library/Application Support/Claude/claude_desktop_config.json`

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

### 4. Restart Claude Desktop

Quit and reopen Claude Desktop to load the MCP server.

## Building the Index

On first use, the server will automatically build a vector index of your emails, messages, and calendar events. Email history is unlimited by default. This may take a while depending on the volume of data.

You can manually rebuild the index:

```bash
# Index all email history (default)
npm run build-index

# Optional: cap email lookback (e.g. for a faster test rebuild)
APPLE_TOOLS_INDEX_DAYS_BACK=30 npm run build-index
```

The index is stored in `~/.apple-tools-mcp/vector-index/`.

## Available Tools

Once configured, Claude can use these tools:

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

Ask Claude things like:

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

### Server not appearing in Claude

1. Verify your config file syntax is valid JSON
2. Restart Claude Desktop completely (Cmd+Q, then reopen)
3. Check Claude's MCP logs for errors

### Force rebuild the index

If the index becomes corrupted or out of sync:

```bash
# Remove existing index files
rm -rf ~/.apple-tools-mcp/vector-index
rm -f ~/.apple-tools-mcp/index-meta.json
rm -f ~/.apple-tools-mcp/indexer.lock

# Restart Claude Desktop to trigger a fresh rebuild
```

### Monitor indexing progress

Watch the MCP server logs in real-time:

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

# Run tests with verbose coverage report
npx vitest run --coverage --reporter=verbose

# Build index with debug output
npm run build-index

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
