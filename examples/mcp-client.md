# MacBook MCP client setup (Streamable HTTP, v3.0.0+)

`--transport=http` exposes the same tools as stdio mode (including writes:
sending iMessage, editing contacts/calendar) over the network, so every
request must carry the bearer token from `apple-tools-mcp http-token`.
This HTTP transport is for connecting the MacBook's Claude Desktop,
Claude Code, and Codex Desktop to the MCP server on the Mac Mini. ChatGPT
Desktop is also a target, but its current custom MCP support does not
accept a private server directly in the desktop app.

## Server on the Mac Mini

Set `httpHost` in `~/.apple-tools-mcp/config.json` to the Mini's LAN or
Tailscale IP (or set `APPLE_TOOLS_HTTP_HOST` to that address), then restart
the HTTP server. The default `127.0.0.1` bind only accepts clients on the
Mini. Retrieve the token on the Mini with `apple-tools-mcp http-token`.

## Claude Desktop on the MacBook

Install this package on the MacBook and find the absolute path of
`apple-tools-http-proxy` with `command -v apple-tools-http-proxy`. In
`~/Library/Application Support/Claude/claude_desktop_config.json`, add a
local MCP server entry using that path:

```json
{
  "mcpServers": {
    "apple-tools": {
      "command": "/absolute/path/to/apple-tools-http-proxy",
      "args": ["http://<mini-address>:8421/mcp"],
      "env": { "APPLE_TOOLS_MCP_TOKEN": "<token-from-mini>" }
    }
  }
}
```

Merge this entry into any existing `mcpServers` object, then fully quit and
reopen Claude Desktop. This local proxy makes the private-network request
from the MacBook. Claude Desktop's **custom connector** instead connects
from Anthropic's cloud and cannot use the Mini's private LAN or Tailscale IP.
[Anthropic documents the distinction](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
The example puts the token in Claude Desktop's local configuration; restrict
that file to your account.

## Claude Code on the MacBook

```bash
claude mcp add --transport http apple-tools http://<mini-address>:8421/mcp \
  -H "Authorization: Bearer <token-from-mini>" \
  -s user
```

`<mini-address>` is the Mini's LAN or Tailscale IP, matching the address
on which the server listens.

## Codex Desktop on the MacBook

Make the token from the Mini available as `APPLE_TOOLS_MCP_TOKEN` in the
MacBook environment that runs Codex, then add the server:

```bash
codex mcp add apple-tools --url http://<mini-address>:8421/mcp \
  --bearer-token-env-var APPLE_TOOLS_MCP_TOKEN
```

The Codex CLI and desktop app share MCP configuration, but the token
environment variable must be available to whichever Codex process connects.
[OpenAI's Codex MCP setup guide](https://developers.openai.com/learn/docs-mcp)
describes their shared configuration.

## Network access

For access away from the LAN, run Tailscale on both the Mini and MacBook and
use the Mini's Tailscale IP. Use TLS or a trusted private network before
sending the bearer token across the network. Keep the Mini's HTTP server
running while either client uses its tools.

## ChatGPT Desktop on the MacBook

[OpenAI currently documents custom MCP apps for ChatGPT web](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt),
not ChatGPT Desktop. ChatGPT also cannot connect directly to the Mini's
private address. If you use ChatGPT web, OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
is the documented way to reach a private MCP server, subject to the
account and workspace access described there. This repository's HTTP
server does not by itself enable the requested ChatGPT Desktop connection.

## Getting/rotating the token

```bash
apple-tools-mcp http-token              # print the current token (generates one if missing)
```

On the Mini, the token lives in the macOS Keychain (service
`apple-tools-mcp-http`), never in the server's config file or the repo. To
rotate it, delete the Keychain item and restart the HTTP server — it'll
generate a new one on the next run —
then update every client that was using the old value.
