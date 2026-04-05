import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
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
const BACKGROUND_PROCESS_DIR = path.join(RUNTIME_DIR, "background_processes");
const SESSION_METADATA_PATH = path.join(RUNTIME_DIR, "sessions.json");
const BACKGROUND_PROCESS_METADATA_PATH = path.join(RUNTIME_DIR, "background_processes.json");
const MAX_OUTPUT = Number(process.env.TERMUX_MCP_MAX_OUTPUT || 64 * 1024);
const MAX_SESSION_READ_BYTES = Number(process.env.TERMUX_MCP_MAX_SESSION_READ_BYTES || 12 * 1024);
const MAX_PROCESS_READ_BYTES = Number(process.env.TERMUX_MCP_MAX_PROCESS_READ_BYTES || 12 * 1024);
const MAX_IMAGE_BYTES = Number(process.env.TERMUX_MCP_MAX_IMAGE_BYTES || 8 * 1024 * 1024);
const SESSION_IDLE_MS = Number(process.env.TERMUX_MCP_SESSION_IDLE_MS || 30 * 60 * 1000);
const RECENT_SESSION_TTL_MS = Number(process.env.TERMUX_MCP_RECENT_SESSION_TTL_MS || 10 * 60 * 1000);
const BACKGROUND_STOP_GRACE_MS = Number(process.env.TERMUX_MCP_BACKGROUND_STOP_GRACE_MS || 3000);
const ROOTS = (process.env.TERMUX_MCP_ALLOWED_ROOTS || HOME)
  .split(path.delimiter)
  .map((value) => path.resolve(value))
  .filter(Boolean);

const app = express();
const transports = new Map();
const shellSessions = new Map();
const recentSessionSnapshots = new Map();
const backgroundProcesses = new Map();
const backgroundProcessHandles = new Map();

await fsp.mkdir(SESSION_DIR, { recursive: true });
await fsp.mkdir(BACKGROUND_PROCESS_DIR, { recursive: true });

function normalizePath(inputPath) {
  const expanded = inputPath.startsWith("~") ? path.join(HOME, inputPath.slice(1)) : inputPath;
  const candidate = path.resolve(expanded);
  const allowed = ROOTS.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error(`Path is outside allowed roots: ${candidate}`);
  }
  return candidate;
}

function normalizePathRelativeTo(baseDir, inputPath) {
  const expanded = inputPath.startsWith("~") ? path.join(HOME, inputPath.slice(1)) : inputPath;
  const candidate = path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
  return normalizePath(candidate);
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

function clampPositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), max);
}

function splitUtf8Prefix(text, maxBytes) {
  if (!text) {
    return { head: "", tail: "", headBytes: 0 };
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { head: text, tail: "", headBytes: Buffer.byteLength(text, "utf8") };
  }

  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }

  const head = text.slice(0, end);
  return {
    head,
    tail: text.slice(end),
    headBytes: Buffer.byteLength(head, "utf8")
  };
}

function keepUtf8Tail(text, maxBytes) {
  if (!text) {
    return { text: "", droppedBytes: 0 };
  }
  const size = Buffer.byteLength(text, "utf8");
  if (size <= maxBytes) {
    return { text, droppedBytes: 0 };
  }

  let start = Math.max(0, text.length - maxBytes);
  while (start < text.length && Buffer.byteLength(text.slice(start), "utf8") > maxBytes) {
    start += 1;
  }

  const kept = text.slice(start);
  return {
    text: kept,
    droppedBytes: size - Buffer.byteLength(kept, "utf8")
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function guessImageMimeType(realPath) {
  const ext = path.extname(realPath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sendSignalToPid(pid, signal, useProcessGroup = false) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (useProcessGroup && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall back to direct PID below.
    }
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isPidRunning(pid);
}

function buildSessionSnapshot(session, status = "running", extra = {}) {
  return {
    session_id: session.id,
    cwd: session.cwd,
    shell: session.command,
    pid: session.process?.pid ?? null,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    status,
    buffered_bytes: Buffer.byteLength(session.stdout, "utf8"),
    dropped_bytes: session.droppedBytes,
    ...extra
  };
}

function buildRecentSessionSnapshot(session, reason, shellExitCode = null, shellExitSignal = null) {
  return {
    ...buildSessionSnapshot(session, "closed", {
      close_reason: reason,
      shell_exit_code: shellExitCode,
      shell_exit_signal: shellExitSignal,
      closed_at: Date.now()
    }),
    expires_at: Date.now() + RECENT_SESSION_TTL_MS
  };
}

function pruneRecentSessionSnapshots() {
  const now = Date.now();
  for (const [sessionId, snapshot] of recentSessionSnapshots.entries()) {
    if ((snapshot.expires_at || 0) <= now) {
      recentSessionSnapshots.delete(sessionId);
    }
  }
}

function saveSessionMetadata() {
  pruneRecentSessionSnapshots();
  const active_sessions = [...shellSessions.values()]
    .map((session) => buildSessionSnapshot(session))
    .sort((a, b) => b.updated_at - a.updated_at);
  const recent_sessions = [...recentSessionSnapshots.values()]
    .map(({ expires_at, ...snapshot }) => snapshot)
    .sort((a, b) => b.updated_at - a.updated_at);
  return fsp.writeFile(
    SESSION_METADATA_PATH,
    JSON.stringify({ active_sessions, recent_sessions }, null, 2)
  );
}

function registerRecentSessionSnapshot(session, reason, shellExitCode = null, shellExitSignal = null) {
  recentSessionSnapshots.set(
    session.id,
    buildRecentSessionSnapshot(session, reason, shellExitCode, shellExitSignal)
  );
}

function appendSessionOutput(session, text) {
  const combined = session.stdout + text;
  const { text: kept, droppedBytes } = keepUtf8Tail(combined, MAX_OUTPUT * 2);
  session.stdout = kept;
  session.droppedBytes += droppedBytes;
  session.updatedAt = Date.now();
}

function readBufferedOutput(session, maxBytes, consume = true) {
  const safeMaxBytes = clampPositiveInt(maxBytes, MAX_SESSION_READ_BYTES, MAX_OUTPUT);
  const { head, tail, headBytes } = splitUtf8Prefix(session.stdout, safeMaxBytes);
  const remainingBytes = Buffer.byteLength(tail, "utf8");
  const droppedBytes = session.droppedBytes;

  if (consume) {
    session.stdout = tail;
    session.droppedBytes = 0;
  }

  return {
    output: head,
    returnedBytes: headBytes,
    remainingBytes,
    hasMore: remainingBytes > 0,
    droppedBytes
  };
}

function writeSessionInput(session, input, raw = false) {
  const payload = raw || input.endsWith("\n") ? input : `${input}\n`;
  session.process.stdin.write(payload);
  session.updatedAt = Date.now();
  void saveSessionMetadata();
  return Buffer.byteLength(payload, "utf8");
}

function createShellSession(cwd) {
  const realCwd = normalizePath(cwd || HOME);
  const child = childProcess.spawn(process.env.SHELL || "sh", [], {
    cwd: realCwd,
    env: process.env,
    stdio: "pipe"
  });

  const id = randomId("session");
  const session = {
    id,
    cwd: realCwd,
    command: process.env.SHELL || "sh",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stdout: "",
    droppedBytes: 0,
    process: child
  };

  child.stdout.on("data", (chunk) => {
    appendSessionOutput(session, chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    appendSessionOutput(session, chunk.toString());
  });
  child.on("close", (code, signal) => {
    registerRecentSessionSnapshot(session, "shell_closed", code ?? null, signal ?? null);
    shellSessions.delete(id);
    void saveSessionMetadata();
  });

  shellSessions.set(id, session);
  void saveSessionMetadata();
  return session;
}

function getMissingSessionToolResult(sessionId, action) {
  pruneRecentSessionSnapshots();
  const recentSnapshot = recentSessionSnapshots.get(sessionId);
  if (recentSnapshot) {
    const { expires_at, ...snapshot } = recentSnapshot;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Session ${sessionId} is no longer active, so ${action} could not be completed. Last known state: ${JSON.stringify(snapshot, null, 2)}`
        }
      ],
      structuredContent: {
        session_id: sessionId,
        reason: "session_closed",
        snapshot
      }
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown session: ${sessionId}` }],
    structuredContent: {
      session_id: sessionId,
      reason: "unknown_session"
    }
  };
}

async function runCommand(command, cwd, timeoutMs) {
  const realCwd = normalizePath(cwd || HOME);
  return await new Promise((resolve) => {
    const child = childProcess.spawn(command, {
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

function buildSearchCommand(realPath, query) {
  const safePath = JSON.stringify(realPath);
  const safeQuery = JSON.stringify(query);
  return `command -v rg >/dev/null 2>&1 && rg -n --no-heading --fixed-strings --color never ${safeQuery} ${safePath} || grep -RInF ${safeQuery} ${safePath}`;
}

function extractPatchedFiles(patchText) {
  const modifiedFiles = new Set();
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      modifiedFiles.add(line.slice(4).split("\t")[0].replace(/^[ab]\//, ""));
    } else if (line.startsWith("*** Add File: ")) {
      modifiedFiles.add(line.slice("*** Add File: ".length));
    } else if (line.startsWith("*** Update File: ")) {
      modifiedFiles.add(line.slice("*** Update File: ".length));
    }
  }
  return [...modifiedFiles];
}

function buildBackgroundProcessSnapshot(record) {
  return {
    process_id: record.id,
    pid: record.pid,
    command: record.command,
    cwd: record.cwd,
    stdout_path: record.stdoutPath,
    stderr_path: record.stderrPath,
    started_at: record.startedAt,
    updated_at: record.updatedAt,
    stopped_at: record.stoppedAt,
    status: record.status,
    exit_code: record.exitCode,
    exit_signal: record.exitSignal
  };
}

async function saveBackgroundProcessMetadata() {
  const items = [...backgroundProcesses.values()]
    .map((record) => ({
      ...buildBackgroundProcessSnapshot(record),
      read_offsets: record.readOffsets
    }))
    .sort((a, b) => b.updated_at - a.updated_at);
  await fsp.writeFile(BACKGROUND_PROCESS_METADATA_PATH, JSON.stringify(items, null, 2));
}

async function loadBackgroundProcessMetadata() {
  try {
    const raw = await fsp.readFile(BACKGROUND_PROCESS_METADATA_PATH, "utf8");
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) {
      return;
    }
    items.forEach((item) => {
      if (!item || !item.process_id || !Number.isInteger(item.pid)) {
        return;
      }
      backgroundProcesses.set(item.process_id, {
        id: item.process_id,
        pid: item.pid,
        command: item.command || "",
        cwd: item.cwd || HOME,
        stdoutPath: item.stdout_path || "",
        stderrPath: item.stderr_path || "",
        startedAt: item.started_at || Date.now(),
        updatedAt: item.updated_at || Date.now(),
        stoppedAt: item.stopped_at || null,
        status: item.status || "running",
        exitCode: item.exit_code ?? null,
        exitSignal: item.exit_signal ?? null,
        readOffsets: {
          stdout: item.read_offsets?.stdout || 0,
          stderr: item.read_offsets?.stderr || 0
        }
      });
    });
    for (const record of backgroundProcesses.values()) {
      refreshBackgroundProcessStatus(record);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Failed to load background process metadata:", error);
    }
  }
}

function refreshBackgroundProcessStatus(record) {
  if (record.status === "running" && !isPidRunning(record.pid)) {
    record.status = record.exitSignal ? "stopped" : "exited";
    record.updatedAt = Date.now();
    record.stoppedAt = record.stoppedAt || Date.now();
  }
  return record;
}

function ensureBackgroundProcess(processId) {
  const record = backgroundProcesses.get(processId);
  if (!record) {
    throw new Error(`Unknown background process: ${processId}`);
  }
  refreshBackgroundProcessStatus(record);
  return record;
}

function appendFileSyncSafe(filePath, text) {
  try {
    fs.appendFileSync(filePath, text);
  } catch {
    // Best effort only.
  }
}

async function startBackgroundProcess(command, cwd, env = {}, stdoutPathInput, stderrPathInput) {
  const realCwd = normalizePath(cwd || HOME);
  const processId = randomId("bg");
  const stdoutPath = stdoutPathInput
    ? normalizePathRelativeTo(realCwd, stdoutPathInput)
    : path.join(BACKGROUND_PROCESS_DIR, `${processId}.stdout.log`);
  const stderrPath = stderrPathInput
    ? normalizePathRelativeTo(realCwd, stderrPathInput)
    : path.join(BACKGROUND_PROCESS_DIR, `${processId}.stderr.log`);

  await fsp.mkdir(path.dirname(stdoutPath), { recursive: true });
  await fsp.mkdir(path.dirname(stderrPath), { recursive: true });

  const stdoutFd = fs.openSync(stdoutPath, "a");
  const stderrFd = fs.openSync(stderrPath, "a");

  let child;
  try {
    child = childProcess.spawn(command, {
      cwd: realCwd,
      env: { ...process.env, ...env },
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", stdoutFd, stderrFd]
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }

  const record = {
    id: processId,
    pid: child.pid,
    command,
    cwd: realCwd,
    stdoutPath,
    stderrPath,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    stoppedAt: null,
    status: "running",
    exitCode: null,
    exitSignal: null,
    readOffsets: {
      stdout: 0,
      stderr: 0
    }
  };

  backgroundProcesses.set(processId, record);
  backgroundProcessHandles.set(processId, child);
  child.on("close", (code, signal) => {
    record.status = signal ? "stopped" : "exited";
    record.exitCode = code ?? null;
    record.exitSignal = signal ?? null;
    record.updatedAt = Date.now();
    record.stoppedAt = Date.now();
    backgroundProcessHandles.delete(processId);
    void saveBackgroundProcessMetadata();
  });
  child.on("error", (error) => {
    record.status = "failed";
    record.exitCode = null;
    record.exitSignal = null;
    record.updatedAt = Date.now();
    record.stoppedAt = Date.now();
    backgroundProcessHandles.delete(processId);
    appendFileSyncSafe(stderrPath, `\n[termux-mcp] background process failed: ${String(error)}\n`);
    void saveBackgroundProcessMetadata();
  });
  child.unref();
  await saveBackgroundProcessMetadata();
  return record;
}

async function stopBackgroundProcess(record, signal = "SIGTERM", forceAfterMs = BACKGROUND_STOP_GRACE_MS) {
  refreshBackgroundProcessStatus(record);
  if (record.status !== "running") {
    return record;
  }

  const sent = sendSignalToPid(record.pid, signal || "SIGTERM", true);
  if (!sent) {
    throw new Error(`Failed to signal background process ${record.id} (${record.pid})`);
  }

  if (signal !== "SIGKILL") {
    const exited = await waitForPidExit(record.pid, forceAfterMs);
    if (!exited) {
      sendSignalToPid(record.pid, "SIGKILL", true);
      await waitForPidExit(record.pid, 1000);
      record.exitSignal = "SIGKILL";
    } else {
      record.exitSignal = signal;
    }
  } else {
    await waitForPidExit(record.pid, 1000);
    record.exitSignal = "SIGKILL";
  }

  refreshBackgroundProcessStatus(record);
  if (record.status === "running") {
    record.status = "stopped";
    record.stoppedAt = Date.now();
  }
  record.updatedAt = Date.now();
  await saveBackgroundProcessMetadata();
  return record;
}

async function readFileChunk(filePath, offset, maxBytes, peek) {
  const safeMaxBytes = clampPositiveInt(maxBytes, MAX_PROCESS_READ_BYTES, MAX_OUTPUT);
  const stats = await fsp.stat(filePath).catch((error) => {
    if (error?.code === "ENOENT") {
      return { size: 0 };
    }
    throw error;
  });
  const safeOffset = Math.min(Math.max(offset, 0), stats.size);
  const bytesToRead = Math.min(safeMaxBytes, Math.max(stats.size - safeOffset, 0));
  if (bytesToRead === 0) {
    return {
      output: "",
      nextOffset: safeOffset,
      remainingBytes: Math.max(stats.size - safeOffset, 0),
      hasMore: false
    };
  }

  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, safeOffset);
    const output = buffer.subarray(0, bytesRead).toString("utf8");
    const nextOffset = peek ? safeOffset : safeOffset + bytesRead;
    return {
      output,
      nextOffset,
      remainingBytes: Math.max(stats.size - nextOffset, 0),
      hasMore: stats.size > nextOffset
    };
  } finally {
    await handle.close();
  }
}

async function readBackgroundProcessOutput(record, stream, maxBytes, peek) {
  const targetStream = stream || "combined";
  if (targetStream === "stdout" || targetStream === "stderr") {
    const filePath = targetStream === "stdout" ? record.stdoutPath : record.stderrPath;
    const currentOffset = record.readOffsets[targetStream] || 0;
    const chunk = await readFileChunk(filePath, currentOffset, maxBytes, peek);
    if (!peek) {
      record.readOffsets[targetStream] = chunk.nextOffset;
      record.updatedAt = Date.now();
      await saveBackgroundProcessMetadata();
    }
    return {
      stream: targetStream,
      output: chunk.output,
      remainingBytes: chunk.remainingBytes,
      hasMore: chunk.hasMore
    };
  }

  const stdoutChunk = await readBackgroundProcessOutput(record, "stdout", Math.floor(maxBytes / 2), peek);
  const stderrChunk = await readBackgroundProcessOutput(record, "stderr", Math.ceil(maxBytes / 2), peek);
  const parts = [];
  if (stdoutChunk.output) {
    parts.push(`== stdout ==\n${stdoutChunk.output}`);
  }
  if (stderrChunk.output) {
    parts.push(`== stderr ==\n${stderrChunk.output}`);
  }
  return {
    stream: "combined",
    output: parts.join("\n"),
    remainingBytes: stdoutChunk.remainingBytes + stderrChunk.remainingBytes,
    hasMore: stdoutChunk.hasMore || stderrChunk.hasMore
  };
}

await loadBackgroundProcessMetadata();

setInterval(() => {
  const now = Date.now();
  for (const session of shellSessions.values()) {
    if (now - session.updatedAt > SESSION_IDLE_MS) {
      session.process.kill("SIGTERM");
      registerRecentSessionSnapshot(session, "idle_timeout", null, "SIGTERM");
      shellSessions.delete(session.id);
    }
  }
  pruneRecentSessionSnapshots();
  for (const record of backgroundProcesses.values()) {
    refreshBackgroundProcessStatus(record);
  }
  void saveSessionMetadata();
  void saveBackgroundProcessMetadata();
}, 60 * 1000).unref();

function createMcpServer() {
  const server = new McpServer({
    name: "termux-mcp",
    version: "0.2.0"
  });

  server.tool(
    "exec_command",
    "Execute a short-lived one-shot shell command in an allowed working directory. Do not use this for servers, watchers, tail -f, sleep loops, or anything expected to stay running; use start_background_process for detached services and start_session/write_session for interactive foreground work.",
    {
      command: z.string().min(1),
      cwd: z.string().default(HOME),
      timeout_ms: z.number().int().positive().max(300000).default(20000)
    },
    async ({ command, cwd, timeout_ms }) => {
      const result = await runCommand(command, cwd, timeout_ms);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: result.exitCode !== 0
      };
    }
  );

  server.tool(
    "start_session",
    "Start a persistent shell session for interactive or stateful foreground shell work. Use this when later commands need the same shell state or cwd. Do not use it as the preferred way to launch detached services; use start_background_process for long-running servers.",
    {
      cwd: z.string().default(HOME),
      command: z.string().optional()
    },
    async ({ cwd, command }) => {
      const session = createShellSession(cwd);
      if (command?.trim()) {
        writeSessionInput(session, command, false);
      }
      const snapshot = buildSessionSnapshot(session);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(snapshot, null, 2)
          }
        ],
        structuredContent: snapshot
      };
    }
  );

  server.tool(
    "list_sessions",
    "List active shell sessions.",
    {},
    async () => {
      const sessions = [...shellSessions.values()]
        .map((session) => buildSessionSnapshot(session))
        .sort((a, b) => b.updated_at - a.updated_at);
      return {
        content: [{ type: "text", text: JSON.stringify({ sessions }, null, 2) }],
        structuredContent: { sessions }
      };
    }
  );

  server.tool(
    "write_session",
    "Write input into a running shell session. By default a trailing newline is added so shell commands execute normally. Use raw=true only for direct stdin writes to an already-running interactive program. If the command is meant to keep running in the background after the tool returns, use start_background_process instead.",
    {
      session_id: z.string(),
      input: z.string(),
      raw: z.boolean().default(false)
    },
    async ({ session_id, input, raw }) => {
      const session = shellSessions.get(session_id);
      if (!session) {
        return getMissingSessionToolResult(session_id, "writing to the session");
      }

      const written = writeSessionInput(session, input, raw);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ session_id, raw, written }, null, 2)
          }
        ],
        structuredContent: { session_id, raw, written }
      };
    }
  );

  server.tool(
    "read_session",
    "Read buffered output from a running shell session.",
    {
      session_id: z.string(),
      max_bytes: z.number().int().positive().max(MAX_OUTPUT).default(MAX_SESSION_READ_BYTES),
      peek: z.boolean().default(false)
    },
    async ({ session_id, max_bytes, peek }) => {
      const session = shellSessions.get(session_id);
      if (!session) {
        return getMissingSessionToolResult(session_id, "reading the session");
      }

      const readResult = readBufferedOutput(session, max_bytes, !peek);
      const snapshot = buildSessionSnapshot(session);
      const summaryLines = [
        `Read ${readResult.returnedBytes} bytes from session ${session_id}.`,
        `Remaining unread bytes: ${readResult.remainingBytes}.`
      ];
      if (peek) {
        summaryLines.push("Peek mode was enabled, so this chunk was not consumed.");
      }
      if (readResult.droppedBytes > 0) {
        summaryLines.push(`Warning: ${readResult.droppedBytes} older buffered bytes were dropped before this read.`);
      }
      const body = readResult.output || "(no new output)";
      return {
        content: [{ type: "text", text: `${summaryLines.join(" ")}\n\n${body}` }],
        structuredContent: {
          ...snapshot,
          output: readResult.output,
          returned_bytes: readResult.returnedBytes,
          remaining_bytes: readResult.remainingBytes,
          has_more: readResult.hasMore,
          dropped_bytes: readResult.droppedBytes,
          peek
        }
      };
    }
  );

  server.tool(
    "kill_session",
    "Stop a running shell session entirely.",
    {
      session_id: z.string()
    },
    async ({ session_id }) => {
      const session = shellSessions.get(session_id);
      if (!session) {
        return getMissingSessionToolResult(session_id, "killing the session");
      }

      session.process.kill("SIGTERM");
      registerRecentSessionSnapshot(session, "killed", null, "SIGTERM");
      shellSessions.delete(session_id);
      await saveSessionMetadata();
      return {
        content: [{ type: "text", text: JSON.stringify({ session_id, stopped: true }, null, 2) }],
        structuredContent: {
          session_id,
          stopped: true
        }
      };
    }
  );

  server.tool(
    "start_background_process",
    "Start a detached background process with log files so AI can observe long-running services without blocking. This is the preferred tool for HTTP servers, dev servers, watchers, bot loops, and other tasks meant to keep running after the tool call returns.",
    {
      command: z.string().min(1),
      cwd: z.string().default(HOME),
      stdout_path: z.string().optional(),
      stderr_path: z.string().optional(),
      env: z.record(z.string()).default({})
    },
    async ({ command, cwd, stdout_path, stderr_path, env }) => {
      const record = await startBackgroundProcess(command, cwd, env, stdout_path, stderr_path);
      const snapshot = buildBackgroundProcessSnapshot(record);
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
        structuredContent: snapshot
      };
    }
  );

  server.tool(
    "list_background_processes",
    "List tracked background processes started by termux-mcp.",
    {},
    async () => {
      const processes = [...backgroundProcesses.values()]
        .map((record) => buildBackgroundProcessSnapshot(refreshBackgroundProcessStatus(record)))
        .sort((a, b) => b.started_at - a.started_at);
      await saveBackgroundProcessMetadata();
      return {
        content: [{ type: "text", text: JSON.stringify({ processes }, null, 2) }],
        structuredContent: { processes }
      };
    }
  );

  server.tool(
    "read_process_output",
    "Read bounded stdout or stderr chunks from a tracked background process. Use this to monitor services started with start_background_process without flooding context.",
    {
      process_id: z.string(),
      stream: z.enum(["stdout", "stderr", "combined"]).default("combined"),
      max_bytes: z.number().int().positive().max(MAX_OUTPUT).default(MAX_PROCESS_READ_BYTES),
      peek: z.boolean().default(false)
    },
    async ({ process_id, stream, max_bytes, peek }) => {
      const record = ensureBackgroundProcess(process_id);
      const result = await readBackgroundProcessOutput(record, stream, max_bytes, peek);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                process_id,
                stream: result.stream,
                has_more: result.hasMore,
                remaining_bytes: result.remainingBytes,
                output: result.output
              },
              null,
              2
            )
          }
        ],
        structuredContent: {
          ...buildBackgroundProcessSnapshot(record),
          stream: result.stream,
          output: result.output,
          has_more: result.hasMore,
          remaining_bytes: result.remainingBytes,
          peek
        }
      };
    }
  );

  server.tool(
    "stop_background_process",
    "Stop a tracked background process with graceful termination followed by a forced kill if needed.",
    {
      process_id: z.string(),
      signal: z.enum(["SIGTERM", "SIGKILL"]).default("SIGTERM"),
      force_after_ms: z.number().int().positive().max(30000).default(BACKGROUND_STOP_GRACE_MS)
    },
    async ({ process_id, signal, force_after_ms }) => {
      const record = ensureBackgroundProcess(process_id);
      const stopped = await stopBackgroundProcess(record, signal, force_after_ms);
      return {
        content: [{ type: "text", text: JSON.stringify(buildBackgroundProcessSnapshot(stopped), null, 2) }],
        structuredContent: buildBackgroundProcessSnapshot(stopped)
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
        content: [{ type: "text", text: JSON.stringify({ path: realPath, content: limitText(content) }, null, 2) }],
        structuredContent: {
          path: realPath,
          content: limitText(content)
        }
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
      const result = {
        path: realPath,
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
        }))
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    }
  );

  server.tool(
    "search_text",
    "Search text recursively with rg when available and fall back to grep when needed.",
    {
      path: z.string().default(HOME),
      query: z.string().min(1)
    },
    async ({ path: inputPath, query }) => {
      const realPath = normalizePath(inputPath);
      const result = await runCommand(buildSearchCommand(realPath, query), realPath, 20000);
      const matches = result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [file, lineNumber, ...rest] = line.split(":");
          return {
            file,
            line: Number.parseInt(lineNumber || "0", 10) || 0,
            text: rest.join(":")
          };
        });
      return {
        content: [{ type: "text", text: JSON.stringify({ ...result, matches }, null, 2) }],
        structuredContent: {
          ...result,
          matches
        },
        isError: result.exitCode !== 0 && matches.length === 0
      };
    }
  );

  server.tool(
    "apply_patch",
    "Apply a unified diff patch inside allowed paths and report which files were touched.",
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
        const modifiedFiles = extractPatchedFiles(patch);
        const applied = result.exitCode === 0;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  cwd: realCwd,
                  applied,
                  modified_files: modifiedFiles,
                  exit_code: result.exitCode,
                  signal: result.signal,
                  stdout: result.stdout,
                  stderr: result.stderr
                },
                null,
                2
              )
            }
          ],
          structuredContent: {
            cwd: realCwd,
            applied,
            modified_files: modifiedFiles,
            exit_code: result.exitCode,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr
          },
          isError: !applied
        };
      } finally {
        await fsp.rm(tmpPatch, { force: true });
      }
    }
  );

  server.tool(
    "view_image",
    "Load an image file from disk and return real image content that multimodal clients can pass to models.",
    {
      path: z.string()
    },
    async ({ path: inputPath }) => {
      const realPath = normalizePath(inputPath);
      const mimeType = guessImageMimeType(realPath);
      if (!mimeType) {
        throw new Error(`Unsupported image type for ${realPath}`);
      }
      const stats = await fsp.stat(realPath);
      if (stats.size > MAX_IMAGE_BYTES) {
        throw new Error(`Image is too large to return through MCP (${stats.size} bytes > ${MAX_IMAGE_BYTES} bytes)`);
      }
      const data = await fsp.readFile(realPath);
      return {
        content: [
          {
            type: "text",
            text: `Loaded image ${path.basename(realPath)} (${mimeType}, ${stats.size} bytes) from ${realPath}.`
          },
          {
            type: "image",
            data: data.toString("base64"),
            mimeType
          }
        ],
        structuredContent: {
          path: realPath,
          mime_type: mimeType,
          size: stats.size,
          modified_at: stats.mtime.toISOString()
        }
      };
    }
  );

  return server;
}

app.use(express.json({ limit: "8mb" }));

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
    roots: ROOTS,
    active_sessions: shellSessions.size,
    tracked_background_processes: backgroundProcesses.size
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
  for (const record of backgroundProcesses.values()) {
    if (record.status === "running") {
      sendSignalToPid(record.pid, "SIGTERM", true);
    }
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
