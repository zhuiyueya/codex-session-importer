#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const APP_CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";
const MIGRATION_SOURCE = "claude-code";
const PROVIDER_ID = "external-transcript";
const SCRIPT_VERSION = "1.0.0";
const IMPORT_TIMEOUT_MS = 120_000;

class ImportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ImportError";
    this.details = details;
  }
}

function usage() {
  return `Usage:
  node import_session.mjs --input PATH --title TITLE [options]

Required:
  --input PATH                  Markdown, JSON, or JSONL transcript
  --title TITLE                 User-visible Codex thread title

Options:
  --cwd PATH                    Thread working directory (default: current directory)
  --expected-messages N         Require an exact message count
  --expected-first TEXT         Require an exact first user message
  --expected-last-contains TEXT Require the last assistant message to contain TEXT
  --auth-mode apiKey|any        Required Codex auth mode (default: apiKey)
  --model NAME                  Override the configured model for thread resume
  --model-provider NAME         Override the configured model provider
  --force-new                   Create another thread even if this source was imported
  --keep-intermediate           Keep the deterministic source file (default)
  --remove-intermediate         Remove it after a verified import
  --offline                     Parse and validate only; incompatible with --commit
  --commit                      Perform the import; omitted means dry-run
  --help                        Show this help`;
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    authMode: "apiKey",
    commit: false,
    forceNew: false,
    keepIntermediate: true,
    offline: false,
  };
  const valueFlags = new Map([
    ["--input", "input"],
    ["--title", "title"],
    ["--cwd", "cwd"],
    ["--expected-messages", "expectedMessages"],
    ["--expected-first", "expectedFirst"],
    ["--expected-last-contains", "expectedLastContains"],
    ["--auth-mode", "authMode"],
    ["--model", "model"],
    ["--model-provider", "modelProvider"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (valueFlags.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ImportError(`${flag} requires a value`);
      }
      options[valueFlags.get(flag)] = value;
      index += 1;
      continue;
    }
    if (flag === "--commit") options.commit = true;
    else if (flag === "--force-new") options.forceNew = true;
    else if (flag === "--keep-intermediate") options.keepIntermediate = true;
    else if (flag === "--remove-intermediate") options.keepIntermediate = false;
    else if (flag === "--offline") options.offline = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new ImportError(`Unknown option: ${flag}`);
  }

  if (options.help) return options;
  if (!options.input) throw new ImportError("--input is required");
  if (!options.title?.trim()) throw new ImportError("--title is required");
  if (!new Set(["apiKey", "any"]).has(options.authMode)) {
    throw new ImportError("--auth-mode must be apiKey or any");
  }
  if (options.offline && options.commit) {
    throw new ImportError("--offline cannot be combined with --commit");
  }
  if (options.expectedMessages !== undefined) {
    const parsed = Number(options.expectedMessages);
    if (!Number.isSafeInteger(parsed) || parsed < 2) {
      throw new ImportError("--expected-messages must be an integer of at least 2");
    }
    options.expectedMessages = parsed;
  }
  return options;
}

function normalizeContent(content) {
  if (typeof content === "string") return content.replaceAll("\r\n", "\n").trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .replaceAll("\r\n", "\n")
      .trim();
  }
  throw new ImportError("Message content must be a string or an array of text blocks");
}

function normalizeMessage(raw, position) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ImportError(`Message ${position} must be an object`);
  }
  const role = String(raw.role ?? "").toLowerCase();
  if (!new Set(["user", "assistant"]).has(role)) {
    throw new ImportError(`Message ${position} has unsupported role: ${raw.role ?? "missing"}`);
  }
  const content = normalizeContent(raw.content);
  if (!content) throw new ImportError(`Message ${position} is empty`);
  return { role, content };
}

function parseMarkdown(text) {
  const marker = /^##[ \t]+(?:(\d+)[.)]?[ \t]+)?(用户|User|Human|ChatGPT|Assistant)[ \t]*$/gim;
  const matches = [...text.matchAll(marker)];
  if (!matches.length) {
    throw new ImportError("No supported Markdown role headings were found");
  }
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const label = match[2].toLowerCase();
    const role = new Set(["用户", "user", "human"]).has(label) ? "user" : "assistant";
    return normalizeMessage({ role, content: text.slice(start, end) }, index + 1);
  });
}

function parseTranscript(text, inputPath) {
  const trimmed = text.trim();
  if (!trimmed) throw new ImportError("The transcript is empty");

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const rawMessages = Array.isArray(parsed) ? parsed : parsed?.messages;
      if (!Array.isArray(rawMessages)) {
        throw new ImportError("JSON input must be an array or contain a messages array");
      }
      return rawMessages.map((message, index) => normalizeMessage(message, index + 1));
    } catch (error) {
      if (error instanceof ImportError) throw error;
      if (trimmed.startsWith("[")) {
        throw new ImportError(`Invalid JSON transcript: ${error.message}`);
      }
    }
  }

  const extension = extname(inputPath).toLowerCase();
  if (extension === ".jsonl" || trimmed.startsWith("{")) {
    try {
      return trimmed
        .split("\n")
        .filter((line) => line.trim())
        .map((line, index) => normalizeMessage(JSON.parse(line), index + 1));
    } catch (error) {
      if (error instanceof ImportError) throw error;
      throw new ImportError(`Invalid JSONL transcript: ${error.message}`);
    }
  }
  return parseMarkdown(text);
}

function validateMessages(messages, options) {
  if (messages.length < 2) throw new ImportError("At least one user/assistant pair is required");
  for (let index = 0; index < messages.length; index += 1) {
    const expectedRole = index % 2 === 0 ? "user" : "assistant";
    if (messages[index].role !== expectedRole) {
      throw new ImportError(`Expected ${expectedRole} at message ${index + 1}, found ${messages[index].role}`);
    }
  }
  if (messages.length % 2 !== 0) {
    throw new ImportError("The transcript ends with an unmatched user message");
  }
  if (options.expectedMessages !== undefined && messages.length !== options.expectedMessages) {
    throw new ImportError(`Expected ${options.expectedMessages} messages, found ${messages.length}`);
  }
  if (options.expectedFirst !== undefined && messages[0].content !== options.expectedFirst) {
    throw new ImportError("The first user message does not match --expected-first");
  }
  if (
    options.expectedLastContains !== undefined &&
    !messages.at(-1).content.includes(options.expectedLastContains)
  ) {
    throw new ImportError("The last assistant message does not contain --expected-last-contains");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(seed) {
  const bytes = Buffer.from(sha256(seed).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cwdSlug(cwd) {
  return cwd.replaceAll("\\", "-").replaceAll("/", "-").replace(/[^A-Za-z0-9._-]/g, "-");
}

function buildIntermediate(messages, cwd, title, forceNew) {
  const transcriptHash = sha256(JSON.stringify({ schema: 1, cwd, messages }));
  const sourceSeed = forceNew ? `${transcriptHash}:${randomUUID()}` : transcriptHash;
  const sessionId = deterministicUuid(`session:${sourceSeed}`);
  const outputPath = resolve(homedir(), ".claude", "projects", cwdSlug(cwd), `${sessionId}.jsonl`);
  const baseTimeMs = Date.now() - messages.length * 1000;
  let parentUuid = null;
  const records = messages.map((message, index) => {
    const uuid = deterministicUuid(`${sessionId}:message:${index + 1}`);
    const timestamp = new Date(baseTimeMs + index * 1000).toISOString();
    const common = {
      parentUuid,
      isSidechain: false,
      type: message.role,
      uuid,
      timestamp,
      userType: "external",
      entrypoint: "cli",
      cwd,
      sessionId,
      version: SCRIPT_VERSION,
      gitBranch: "HEAD",
    };
    parentUuid = uuid;
    if (message.role === "user") {
      return {
        ...common,
        message: { role: "user", content: message.content },
        origin: { kind: "human" },
        promptSource: "typed",
      };
    }
    const compactId = uuid.replaceAll("-", "");
    return {
      ...common,
      message: {
        id: `msg_${compactId}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        model: "external-transcript",
        stop_reason: "end_turn",
        stop_details: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      requestId: `req_${compactId}`,
    };
  });
  return {
    outputPath,
    sessionId,
    transcriptHash,
    text: `${records.map(JSON.stringify).join("\n")}\n`,
    title,
  };
}

function resolveCodexBinary() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  if (existsSync(APP_CODEX_PATH)) return APP_CODEX_PATH;
  return "codex";
}

class AppServerClient {
  constructor(binary) {
    this.binary = binary;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = [];
    this.stderr = "";
  }

  async start() {
    this.child = spawn(this.binary, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.rejectAll(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`));
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "import-codex-session",
        title: "Import Codex Session",
        version: SCRIPT_VERSION,
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new ImportError(`App Server ${pending.method} failed: ${message.error.message}`, {
          code: message.error.code,
        }));
      } else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const waiterIndex = this.notificationWaiters.findIndex(
      (waiter) => waiter.method === message.method && waiter.predicate(message.params),
    );
    if (waiterIndex >= 0) {
      const [waiter] = this.notificationWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    } else {
      this.notifications.push(message);
      if (this.notifications.length > 500) this.notifications.shift();
    }
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    const payload = { method, id };
    if (params !== undefined) payload.params = params;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(new ImportError(`Timed out waiting for App Server ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve: resolveRequest, reject: rejectRequest, timer, method });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  waitForNotification(method, predicate = () => true, timeoutMs = IMPORT_TIMEOUT_MS) {
    const bufferedIndex = this.notifications.findIndex(
      (message) => message.method === method && predicate(message.params),
    );
    if (bufferedIndex >= 0) {
      const [message] = this.notifications.splice(bufferedIndex, 1);
      return Promise.resolve(message.params);
    }
    return new Promise((resolveWait, rejectWait) => {
      const waiter = { method, predicate, resolve: resolveWait, reject: rejectWait };
      waiter.timer = setTimeout(() => {
        const index = this.notificationWaiters.indexOf(waiter);
        if (index >= 0) this.notificationWaiters.splice(index, 1);
        rejectWait(new ImportError(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.notificationWaiters.push(waiter);
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters = [];
  }

  async close() {
    this.closed = true;
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await new Promise((resolveClose) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGKILL");
        resolveClose();
      }, 1500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }
}

function findImportHistory(histories, sourcePath) {
  for (const history of histories?.data ?? []) {
    for (const success of history.successes ?? []) {
      if (success.itemType === "SESSIONS" && success.source === sourcePath) {
        return { importId: history.importId, ...success };
      }
    }
  }
  return null;
}

async function storedThreadExists(client, threadId) {
  try {
    await client.request("thread/read", { threadId, includeTurns: false });
    return true;
  } catch (error) {
    if (error.message.includes("thread not loaded")) return false;
    throw error;
  }
}

function detectIncludesPath(response, sourcePath) {
  return (response?.items ?? []).some(
    (item) =>
      item.itemType === "SESSIONS" &&
      (item.details?.sessions ?? []).some((session) => session.path === sourcePath),
  );
}

function importedMessages(thread) {
  const messages = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const content = (item.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (content && content !== "<EXTERNAL SESSION IMPORTED>") {
          messages.push({ role: "user", content });
        }
      } else if (item.type === "agentMessage") {
        const content = item.text.replaceAll("\r\n", "\n").trim();
        if (content && content !== "<EXTERNAL SESSION IMPORTED>") {
          messages.push({ role: "assistant", content });
        }
      }
    }
  }
  return messages;
}

function meaningfulTurnCount(thread) {
  return (thread.turns ?? []).filter((turn) =>
    (turn.items ?? []).some((item) => {
      if (item.type === "userMessage") {
        return (item.content ?? []).some(
          (part) => part.type === "text" && part.text.trim() !== "<EXTERNAL SESSION IMPORTED>",
        );
      }
      return item.type === "agentMessage" && item.text.trim() !== "<EXTERNAL SESSION IMPORTED>";
    }),
  ).length;
}

function assertEqual(actual, expected, label, details) {
  if (actual !== expected) {
    throw new ImportError(`${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`, details);
  }
}

function verifyImportedThread(thread, resumeResult, expectedMessages, options, threadId) {
  const details = { threadId };
  assertEqual(thread.name, options.title, "Thread title mismatch", details);
  assertEqual(resolve(thread.cwd), options.cwd, "Thread cwd mismatch", details);
  assertEqual(thread.historyMode, "legacy", "Thread history mode mismatch", details);
  assertEqual(resumeResult.model, options.model, "Resumed model mismatch", details);
  assertEqual(resumeResult.modelProvider, options.modelProvider, "Model provider mismatch", details);
  assertEqual(thread.canAcceptDirectInput, true, "Thread does not accept direct input", details);

  const actualMessages = importedMessages(thread);
  assertEqual(actualMessages.length, expectedMessages.length, "Imported message count mismatch", details);
  assertEqual(meaningfulTurnCount(thread), expectedMessages.length / 2, "Imported turn count mismatch", details);
  for (let index = 0; index < expectedMessages.length; index += 1) {
    assertEqual(actualMessages[index]?.role, expectedMessages[index].role, `Role mismatch at message ${index + 1}`, details);
    assertEqual(
      actualMessages[index]?.content,
      expectedMessages[index].content,
      `Content mismatch at message ${index + 1}`,
      details,
    );
  }
}

async function resumeAndVerify(client, threadId, messages, options) {
  await client.request("thread/name/set", { threadId, name: options.title });
  const resumeResult = await client.request(
    "thread/resume",
    {
      threadId,
      model: options.model,
      modelProvider: options.modelProvider,
      cwd: options.cwd,
      excludeTurns: false,
    },
    IMPORT_TIMEOUT_MS,
  );
  const readResult = await client.request(
    "thread/read",
    { threadId, includeTurns: true },
    IMPORT_TIMEOUT_MS,
  );
  verifyImportedThread(readResult.thread, resumeResult, messages, options, threadId);
  return readResult.thread;
}

async function preflight(client, options) {
  const [accountResult, configResult, histories] = await Promise.all([
    client.request("account/read", { refreshToken: false }),
    client.request("config/read", { includeLayers: false }),
    client.request("externalAgentConfig/import/readHistories"),
  ]);
  const authMode = accountResult?.account?.type ?? "none";
  if (options.authMode !== "any" && authMode !== options.authMode) {
    throw new ImportError(`Codex auth mode must be ${options.authMode}; found ${authMode}`);
  }
  options.model ??= configResult?.config?.model;
  options.modelProvider ??= configResult?.config?.model_provider;
  if (!options.model) throw new ImportError("No Codex model is configured; pass --model");
  if (!options.modelProvider) {
    throw new ImportError("No Codex model provider is configured; pass --model-provider");
  }
  return { authMode, histories };
}

function safeSummaryBase(options, messages, intermediate) {
  return {
    mode: options.commit ? "commit" : "dry-run",
    input: options.input,
    title: options.title,
    cwd: options.cwd,
    messageCount: messages.length,
    turnCount: messages.length / 2,
    transcriptSha256: intermediate.transcriptHash,
    firstMessageSha256: sha256(messages[0].content),
    lastMessageSha256: sha256(messages.at(-1).content),
    intermediatePath: intermediate.outputPath,
  };
}

async function run(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  options.input = resolve(options.input);
  options.cwd = resolve(options.cwd);
  options.title = options.title.trim();

  if (!existsSync(options.input) || !statSync(options.input).isFile()) {
    throw new ImportError(`Input file does not exist: ${options.input}`);
  }
  if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
    throw new ImportError(`Working directory does not exist: ${options.cwd}`);
  }

  const messages = parseTranscript(readFileSync(options.input, "utf8"), options.input);
  validateMessages(messages, options);
  const intermediate = buildIntermediate(messages, options.cwd, options.title, options.forceNew);
  const summary = safeSummaryBase(options, messages, intermediate);

  if (options.offline) {
    process.stdout.write(`${JSON.stringify({ ...summary, status: "validated-offline" }, null, 2)}\n`);
    return;
  }

  const client = new AppServerClient(resolveCodexBinary());
  try {
    await client.start();
    const { authMode, histories } = await preflight(client, options);
    summary.authMode = authMode;
    summary.model = options.model;
    summary.modelProvider = options.modelProvider;
    let previous = findImportHistory(histories, intermediate.outputPath);
    if (previous && !(await storedThreadExists(client, previous.target))) {
      summary.staleImportHistoryTarget = previous.target;
      previous = null;
    }

    if (previous && !options.forceNew) {
      summary.threadId = previous.target;
      summary.importId = previous.importId;
      if (!options.commit) {
        process.stdout.write(`${JSON.stringify({ ...summary, status: "already-imported" }, null, 2)}\n`);
        return;
      }
      await resumeAndVerify(client, previous.target, messages, options);
      if (!options.keepIntermediate && existsSync(intermediate.outputPath)) {
        unlinkSync(intermediate.outputPath);
        summary.intermediateRemoved = true;
      }
      process.stdout.write(`${JSON.stringify({ ...summary, status: "verified-existing" }, null, 2)}\n`);
      return;
    }

    if (!options.commit) {
      process.stdout.write(`${JSON.stringify({ ...summary, status: "ready-to-import" }, null, 2)}\n`);
      return;
    }

    mkdirSync(dirname(intermediate.outputPath), { recursive: true });
    writeFileSync(intermediate.outputPath, intermediate.text, { encoding: "utf8", mode: 0o600 });

    const detection = await client.request(
      "externalAgentConfig/detect",
      {
        includeHome: true,
        cwds: [options.cwd],
        maxSessions: 500,
        migrationSource: MIGRATION_SOURCE,
      },
      IMPORT_TIMEOUT_MS,
    );
    if (!detectIncludesPath(detection, intermediate.outputPath)) {
      throw new ImportError("Codex did not detect the intermediate session; it was preserved for inspection", {
        intermediatePath: intermediate.outputPath,
      });
    }

    const migrationItem = {
      itemType: "SESSIONS",
      description: `Import external transcript ${basename(options.input)}`,
      cwd: null,
      details: {
        sessions: [{ path: intermediate.outputPath, cwd: options.cwd, title: options.title }],
      },
    };
    const importResponse = await client.request(
      "externalAgentConfig/import",
      {
        migrationItems: [migrationItem],
        migrationSource: MIGRATION_SOURCE,
        source: "import-codex-session",
        providerId: PROVIDER_ID,
      },
      IMPORT_TIMEOUT_MS,
    );
    summary.importId = importResponse.importId;
    const completed = await client.waitForNotification(
      "externalAgentConfig/import/completed",
      (params) => params?.importId === importResponse.importId,
      IMPORT_TIMEOUT_MS,
    );
    const sessionResult = (completed.itemTypeResults ?? []).find((result) => result.itemType === "SESSIONS");
    if (!sessionResult || sessionResult.failures?.length) {
      const failure = sessionResult?.failures?.[0];
      throw new ImportError(`Session import failed: ${failure?.message ?? "no success result"}`, {
        importId: importResponse.importId,
        intermediatePath: intermediate.outputPath,
      });
    }
    const success = (sessionResult.successes ?? []).find(
      (item) => item.source === intermediate.outputPath,
    );
    if (!success?.target) {
      throw new ImportError("Session import completed without a target thread ID", {
        importId: importResponse.importId,
        intermediatePath: intermediate.outputPath,
      });
    }
    summary.threadId = success.target;
    await resumeAndVerify(client, success.target, messages, options);

    if (!options.keepIntermediate && existsSync(intermediate.outputPath)) {
      unlinkSync(intermediate.outputPath);
      summary.intermediateRemoved = true;
    }
    process.stdout.write(`${JSON.stringify({ ...summary, status: "imported-and-verified" }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

export {
  AppServerClient,
  buildIntermediate,
  importedMessages,
  parseArgs,
  parseTranscript,
  validateMessages,
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  run(process.argv.slice(2)).catch((error) => {
    const payload = {
      status: "error",
      error: error.message,
      ...(error instanceof ImportError ? error.details : {}),
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}
