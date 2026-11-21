
import net from "net";
import fs from "fs";
import path from "path";

export const WRITE_SOCKET_NAME = "writer.sock";
export const DEFAULT_REQUEST_TIMEOUT_MS = 90000;
const MAX_FRAME_BYTES = 1024 * 1024;

export function defaultSocketPath(home = process.env.HOME || "") {
  return path.join(home, ".apple-tools-mcp", WRITE_SOCKET_NAME);
}

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
          if (Number.isFinite(request.expiresAt) && Date.now() >= request.expiresAt) {
            response = { ok: false, sendStarted: false, message: "Write bridge request expired before execution; nothing was started." };
          } else {
            response = await handler(request.tool, request.args || {});
          }
        } catch (e) {
          response = { ok: false, message: `Write bridge error: ${e.message}` };
        }
        socket.end(JSON.stringify(response) + "\n");
      });

      socket.on("error", () => socket.destroy());
    });

    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        probeSocket(socketPath)
          .then((alive) => {
            if (alive) {
              reject(new Error("Another apple-tools-mcp write bridge is already listening"));
              return;
            }
            try {
              fs.unlinkSync(socketPath);
            } catch {
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
      }
      log(`Write bridge listening at ${socketPath}`);
      resolve({
        socketPath,
        close: () => {
          try {
            server.close();
          } catch {
          }
          try {
            fs.unlinkSync(socketPath);
          } catch {
          }
        }
      });
    };

    server.listen(socketPath, finish);
  });
}

export function probeSocket(socketPath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
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

export function requestWriteViaBridge({ socketPath, tool, args, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  const expiresAt = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    if (!socketPath) {
      resolve({ delivered: false, response: null, error: "no socket path", mayHaveStarted: false });
      return;
    }

    let settled = false;
    let mayHaveStarted = false;
    let buffer = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        client.destroy();
      } catch {
      }
      resolve({ ...value, mayHaveStarted });
    };

    const client = net.connect(socketPath);
    client.setEncoding("utf8");
    const deadline = setTimeout(() => finish({ delivered: false, response: null, error: "write bridge timed out" }), timeoutMs);

    client.on("connect", () => {
      mayHaveStarted = true;
      client.write(JSON.stringify({ tool, args: args || {}, expiresAt }) + "\n");
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
        }
      }
      finish({ delivered: false, response: null, error: "write bridge closed without a response" });
    });

    client.on("error", (e) => finish({ delivered: false, response: null, error: e.code || e.message }));
    client.on("close", () => finish({ delivered: false, response: null, error: "write bridge closed without a response" }));
  });
}
