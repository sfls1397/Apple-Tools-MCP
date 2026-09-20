/**
 * Local write bridge between a short-lived MCP stdio process and the
 * long-lived indexer daemon.
 *
 * Why this exists: macOS attributes an Apple event (and Contacts/Calendar
 * access) to the *responsible process* of whoever sends it. When a host app
 * spawns this server over stdio, the host - not node - is responsible, so a
 * host without the Contacts/Calendars automation entitlement makes those
 * writes fail regardless of node's own Full Disk Access. The indexer daemon
 * is started by launchd, so node is responsible for its Apple events.
 *
 * The daemon therefore listens on a user-only unix socket and performs writes
 * on behalf of stdio clients. Nothing leaves the machine: AF_UNIX socket,
 * 0600, inside ~/.apple-tools-mcp/.
 */

import net from "net";
import fs from "fs";
import path from "path";

export const WRITE_SOCKET_NAME = "writer.sock";
export const DEFAULT_REQUEST_TIMEOUT_MS = 90000;
const MAX_FRAME_BYTES = 1024 * 1024;

export function defaultSocketPath(home = process.env.HOME || "") {
  return path.join(home, ".apple-tools-mcp", WRITE_SOCKET_NAME);
}

/**
 * Start the bridge server. Safe to call when a stale socket file is left over
 * from a crash: an unconnectable socket file is removed first.
 *
 * @param {object} opts
 * @param {string} opts.socketPath
 * @param {(tool: string, args: object) => Promise<object>|object} opts.handler
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ socketPath: string, close: () => void }>}
 */
export function startWriteBridgeServer({ socketPath, handler, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(socketPath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      reject(e);
      return;
    }

    const server = net.createServer({ allowHalfOpen: false }, (socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      let handled = false;

      socket.on("data", async (chunk) => {
        if (handled) return;
        buffer += chunk;
        if (buffer.length > MAX_FRAME_BYTES) {
          socket.end(JSON.stringify({ ok: false, message: "Request too large" }) + "\n");
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        handled = true;

        let response;
        try {
          const request = JSON.parse(buffer.slice(0, newline));
          response = await handler(request.tool, request.args || {});
        } catch (e) {
          response = { ok: false, message: `Write bridge error: ${e.message}` };
        }
        socket.end(JSON.stringify(response) + "\n");
      });

      socket.on("error", () => socket.destroy());
    });

    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        // Either a live daemon or a stale file. Probe it: a refused connect
        // means nothing is listening, so the file can be replaced.
        probeSocket(socketPath)
          .then((alive) => {
            if (alive) {
              reject(new Error("Another apple-tools-mcp write bridge is already listening"));
              return;
            }
            try {
              fs.unlinkSync(socketPath);
            } catch {
              // best effort; listen will fail again below if it is still there
            }
            server.listen(socketPath, () => finish());
          })
          .catch(reject);
        return;
      }
      reject(e);
    });

    const finish = () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // Socket files on some filesystems reject chmod; the parent dir is 0700.
      }
      log(`Write bridge listening at ${socketPath}`);
      resolve({
        socketPath,
        close: () => {
          try {
            server.close();
          } catch {
            // already closed
          }
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // already gone
          }
        }
      });
    };

    server.listen(socketPath, finish);
  });
}

/**
 * @returns {Promise<boolean>} true when something is listening on the socket
 */
export function probeSocket(socketPath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const client = net.connect(socketPath);
    client.setTimeout(timeoutMs);
    client.on("connect", () => done(true));
    client.on("error", () => done(false));
    client.on("timeout", () => done(false));
  });
}

/**
 * Ask the daemon to run a write.
 *
 * @returns {Promise<{ delivered: boolean, response: object|null, error: string|null }>}
 */
export function requestWriteViaBridge({ socketPath, tool, args, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (!socketPath) {
      resolve({ delivered: false, response: null, error: "no socket path" });
      return;
    }

    let settled = false;
    let buffer = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const client = net.connect(socketPath);
    client.setEncoding("utf8");
    client.setTimeout(timeoutMs);

    client.on("connect", () => {
      client.write(JSON.stringify({ tool, args: args || {} }) + "\n");
    });

    client.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish({ delivered: true, response: JSON.parse(buffer.slice(0, newline)), error: null });
      } catch (e) {
        finish({ delivered: false, response: null, error: `malformed bridge response: ${e.message}` });
      }
    });

    client.on("end", () => {
      if (settled) return;
      if (buffer.trim().length > 0) {
        try {
          finish({ delivered: true, response: JSON.parse(buffer.trim()), error: null });
          return;
        } catch {
          // fall through to the generic failure below
        }
      }
      finish({ delivered: false, response: null, error: "write bridge closed without a response" });
    });

    client.on("timeout", () => finish({ delivered: false, response: null, error: "write bridge timed out" }));
    client.on("error", (e) => finish({ delivered: false, response: null, error: e.code || e.message }));
  });
}
