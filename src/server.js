import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import pty from "node:child_process";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const HOME = os.homedir();
const HOST = process.env.TERMUX_MCP_HOST || "0.0.0.0";
const PORT = Number(process.env.TERMUX_MCP_PORT || 8765);
const RUNTIME_DIR = process.env.TERMUX_MCP_RUNTIME_DIR || path.join(HOME, ".termux-mcp");
const SESSION_DIR = path.join(RUNTIME_DIR, "sessions");
const MAX_OUTPUT = Number(process.env.TERMUX_MCP_MAX_OUTPUT || 64 * 1024);
const SESSION_IDLE_MS = Number(process.env.TERMUX_MCP_SESSION_IDLE_MS || 30 * 60 * 1000);
const ROOTS = (process.env.TERMUX_MCP_ALLOWED_ROOTS || HOME)
  .split(":")
  .map((value) => path.resolve(value))
  .filter(Boolean);

const app = express();
const transports = new Map();
const shellSessions = new Map();

await fsp.mkdir(SESSION_DIR, { recursive: true });

function jsonResponse(status, body) {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function normalizePath(inputPath) {
  const candidate = path.resolve(inputPath.startsWith("~") ? path.join(HOME, inputPath.slice(1)) : inputPath);
  const allowed = ROOTS.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error(`Path is outside allowed roots: ${candidate}`);
  }
  return candidate;
}

function limitText(text, maxBytes = MAX_OUTPUT) {
  const size = Buffer.byteLength(text, "utf8");
  if (size <= maxBytes) {
    return text;
  }
  let output = text;
  while (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = output.slice(Math.floor(output.length / 8));
  }
  return output;
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function saveSessionMetadata() {
  const items = [...shellSessions.values()].map((session) => ({
    id: session.id,
    cwd: session.cwd,
    command: session.command,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    pid: session.process.pid
  }));
  return fsp.writeFile(path.join(RUNTIME_DIR, "sessions.json"), JSON.stringify(items, null, 2));
}

function readBufferedOutput(session) {
  const stdout = session.stdout;
  session.stdout = "";
  return stdout;
}

function ensureSession(id) {
  const session = shellSessions.get(id);
  if (!session) {
    throw new Error(`Unknown session: ${id}`);
  }
  session.updatedAt = Date.now();
  return session;
}

async function runCommand(command, cwd, timeoutMs) {
  const realCwd = normalizePath(cwd || HOME);
  return await new Promise((resolve) => {
    const child = pty.spawn(command, {
      cwd: realCwd,
      env: process.env,
      shell: true
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        child.kill("SIGTERM");
        resolved = true;
        resolve({
          exitCode: -1,
          signal: "SIGTERM",
          stdout: limitText(stdout),
          stderr: limitText(`${stderr}\nCommand timed out after ${timeoutMs}ms`)
        });
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = limitText(stdout + chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitText(stderr + chunk.toString());
    });
    child.on("close", (code, signal) => {
      if (resolved) {
        return;
      }
      clearTimeout(timer);
      resolved = true;
      resolve({
        exitCode: code ?? 0,
        signal: signal ?? null,
        stdout,
        stderr
      });
    });
  });
}

function createShellSession(command, cwd) {
  const realCwd = normalizePath(cwd || HOME);
  const child = pty.spawn(process.env.SHELL || "sh", [], {
    cwd: realCwd,
    env: process.env,
    stdio: "pipe"
  });
  const id = randomId("session");
  const session = {
    id,
    cwd: realCwd,
    command: command || process.env.SHELL || "sh",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stdout: "",
    process: child
  };
  child.stdout.on("data", (chunk) => {
    session.stdout = limitText(session.stdout + chunk.toString(), MAX_OUTPUT * 2);
    session.updatedAt = Date.now();
  });
  child.stderr.on("data", (chunk) => {
    session.stdout = limitText(session.stdout + chunk.toString(), MAX_OUTPUT * 2);
    session.updatedAt = Date.now();
  });
  child.on("close", () => {
    shellSessions.delete(id);
    void saveSessionMetadata();
  });
  shellSessions.set(id, session);
  if (command) {
    child.stdin.write(`${command}\n`);
  }
  void saveSessionMetadata();
  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const session of shellSessions.values()) {
    if (now - session.updatedAt > SESSION_IDLE_MS) {
      session.process.kill("SIGTERM");
      shellSessions.delete(session.id);
    }
  }
  void saveSessionMetadata();
}, 60 * 1000).unref();

function createMcpServer() {
  const server = new McpServer({
    name: "termux-mcp",
    version: "0.1.0"
  });

  server.tool(
    "exec_command",
    "Execute a one-shot shell command in an allowed working directory.",
    {
      command: z.string().min(1),
      cwd: z.string().default(HOME),
      timeout_ms: z.number().int().positive().max(300000).default(20000)
    },
    async ({ command, cwd, timeout_ms }) => {
      const result = await runCommand(command, cwd, timeout_ms);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  server.tool(
    "start_session",
    "Start a persistent shell session and optionally run an initial command.",
    {
      cwd: z.string().default(HOME),
      command: z.string().optional()
    },
    async ({ cwd, command }) => {
      const session = createShellSession(command, cwd);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ session_id: session.id, cwd: session.cwd, pid: session.process.pid }, null, 2)
          }
        ]
      };
    }
  );

  server.tool(
    "write_session",
    "Write stdin data into a running shell session.",
    {
      session_id: z.string(),
      input: z.string()
    },
    async ({ session_id, input }) => {
      const session = ensureSession(session_id);
      session.process.stdin.write(input);
      return {
        content: [
          { type: "text", text: JSON.stringify({ session_id, written: Buffer.byteLength(input, "utf8") }, null, 2) }
        ]
      };
    }
  );

  server.tool(
    "read_session",
    "Read buffered output from a running shell session.",
    {
      session_id: z.string()
    },
    async ({ session_id }) => {
      const session = ensureSession(session_id);
      return {
        content: [{ type: "text", text: JSON.stringify({ session_id, output: readBufferedOutput(session) }, null, 2) }]
      };
    }
  );

  server.tool(
    "kill_session",
    "Stop a running shell session.",
    {
      session_id: z.string()
    },
    async ({ session_id }) => {
      const session = ensureSession(session_id);
      session.process.kill("SIGTERM");
      shellSessions.delete(session_id);
      await saveSessionMetadata();
      return {
        content: [{ type: "text", text: JSON.stringify({ session_id, stopped: true }, null, 2) }]
      };
    }
  );

  server.tool(
    "read_file",
    "Read a text file from an allowed path.",
    {
      path: z.string()
    },
    async ({ path: inputPath }) => {
      const realPath = normalizePath(inputPath);
      const content = await fsp.readFile(realPath, "utf8");
      return {
        content: [{ type: "text", text: JSON.stringify({ path: realPath, content: limitText(content) }, null, 2) }]
      };
    }
  );

  server.tool(
    "list_files",
    "List directory entries from an allowed path.",
    {
      path: z.string().default(HOME)
    },
    async ({ path: inputPath }) => {
      const realPath = normalizePath(inputPath);
      const entries = await fsp.readdir(realPath, { withFileTypes: true });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                path: realPath,
                entries: entries.map((entry) => ({
                  name: entry.name,
                  type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
                }))
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.tool(
    "search_text",
    "Search text recursively with grep in an allowed path.",
    {
      path: z.string().default(HOME),
      query: z.string().min(1)
    },
    async ({ path: inputPath, query }) => {
      const realPath = normalizePath(inputPath);
      const result = await runCommand(`grep -RInF ${JSON.stringify(query)} ${JSON.stringify(realPath)}`, realPath, 20000);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  server.tool(
    "apply_patch",
    "Apply a unified diff patch inside allowed paths.",
    {
      patch: z.string().min(1),
      cwd: z.string().default(HOME)
    },
    async ({ patch, cwd }) => {
      const realCwd = normalizePath(cwd);
      const tmpPatch = path.join(RUNTIME_DIR, `${randomId("patch")}.diff`);
      await fsp.writeFile(tmpPatch, patch, "utf8");
      try {
        const result = await runCommand(`patch -p0 -i ${JSON.stringify(tmpPatch)}`, realCwd, 20000);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } finally {
        await fsp.rm(tmpPatch, { force: true });
      }
    }
  );

  server.tool(
    "view_image",
    "Return metadata for an image file on disk.",
    {
      path: z.string()
    },
    async ({ path: inputPath }) => {
      const realPath = normalizePath(inputPath);
      const stats = await fsp.stat(realPath);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ path: realPath, size: stats.size, modified_at: stats.mtime.toISOString() }, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

app.use(express.json({ limit: "4mb" }));

function getTransport(sessionId) {
  return sessionId ? transports.get(sessionId) : undefined;
}

async function handleMcpPost(req, res) {
  let transportEntry = req.headers["mcp-session-id"] ? transports.get(req.headers["mcp-session-id"]) : undefined;
  let activeTransport = transportEntry?.transport;

  if (!transportEntry && req.method === "POST" && isInitializeRequest(req.body)) {
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomId("mcp"),
      onsessioninitialized: (sessionId) => {
        const entry = { transport, mcpServer };
        transports.set(sessionId, entry);
        transportEntry = entry;
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
      void mcpServer.close();
    };
    await mcpServer.connect(transport);
    activeTransport = transport;
  }

  if (!activeTransport) {
    res.status(400).json({ error: "No active MCP session. Initialize first." });
    return;
  }

  await activeTransport.handleRequest(req, res, req.body);
}

app.post("/mcp", async (req, res) => {
  await handleMcpPost(req, res);
});

app.get("/mcp", async (req, res) => {
  const transport = getTransport(req.headers["mcp-session-id"]);
  if (!transport) {
    res.status(400).json({ error: "No active MCP session. Initialize first." });
    return;
  }
  await transport.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const transport = getTransport(req.headers["mcp-session-id"]);
  if (!transport) {
    res.status(400).json({ error: "No active MCP session. Initialize first." });
    return;
  }
  await transport.transport.handleRequest(req, res);
});

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    host: HOST,
    port: PORT,
    roots: ROOTS
  });
});

const httpServer = http.createServer(app);
httpServer.listen(PORT, HOST, () => {
  const pidFile = path.join(RUNTIME_DIR, "termux-mcp.pid");
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));
  console.log(`termux-mcp listening on http://${HOST}:${PORT}/mcp`);
});

function shutdown() {
  httpServer.close(() => {
    process.exit(0);
  });
  for (const session of shellSessions.values()) {
    session.process.kill("SIGTERM");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
