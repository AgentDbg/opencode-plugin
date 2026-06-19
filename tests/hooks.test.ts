/**
 * End-to-end hook tests using synthetic OpenCode events and temp directories.
 *
 * Each test gets its own temp data dir (via MAIDA_DATA_DIR) so there is
 * no filesystem coupling between tests. No OpenCode process needed.
 *
 * Payloads match the real @opencode-ai/sdk Event types (v1.3.x).
 */

import { existsSync, readFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "@maida-ai/core";
import type { Event } from "@opencode-ai/sdk";
import { buildHookMap } from "../src/hooks.js";
import { clearAllSessions } from "../src/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let hooks: { event?: (input: { event: Event }) => Promise<void> };
let savedEnv: string | undefined;

function makeTempDir(): string {
  const dir = join(tmpdir(), `maida-oc-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function fireEvent(type: string, properties: Record<string, unknown>): Promise<void> {
  await hooks.event!({ event: { type, properties } as never });
}

function makeSessionInfo(id: string, overrides?: Record<string, unknown>) {
  return {
    id,
    projectID: "proj-1",
    directory: "/tmp/test",
    title: "",
    version: "1",
    time: { created: Date.now(), updated: Date.now() },
    ...overrides,
  };
}

function readRunDir(dataDir: string): string {
  const runsDir = join(dataDir, "runs");
  const entries = readdirSync(runsDir);
  if (entries.length === 0) throw new Error("no run dirs found");
  return join(runsDir, entries[0]);
}

function readMetaJson(dataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(readRunDir(dataDir), "meta.json"), "utf-8"));
}

function readSpans(dataDir: string): Record<string, unknown>[] {
  const spansPath = join(readRunDir(dataDir), "spans.jsonl");
  if (!existsSync(spansPath)) return [];
  const raw = readFileSync(spansPath, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

function readEvents(dataDir: string): Record<string, unknown>[] {
  const meta = readMetaJson(dataDir);
  const spans = readSpans(dataDir);
  const events: Record<string, unknown>[] = [
    {
      event_type: "RUN_START",
      run_id: meta.trace_id,
      payload: { run_name: meta.run_name },
      ts: meta.started_at,
    },
  ];

  // Spans are stored flat (parent_span_id: null) and grouped by trace_id, so
  // they are classified by their attributes rather than by parent linkage.
  for (const span of spans) {
    const attrs = (span.attributes ?? {}) as Record<string, unknown>;
    const spanEvents = (span.events ?? []) as Record<string, unknown>[];

    // The run-summary root span written by finalizeRun -> RUN_END.
    if ("maida.run_name" in attrs && "maida.status" in attrs) {
      events.push({
        event_type: "RUN_END",
        payload: { status: attrs["maida.status"] },
        ts: span.end_time ?? span.start_time,
      });
      continue;
    }

    if ("gen_ai.system" in attrs || "gen_ai.operation.name" in attrs) {
      const responseEvent = spanEvents.find((ev) => ev.name === "gen_ai.assistant.message");
      events.push({
        event_type: "LLM_CALL",
        payload: {
          response: ((responseEvent?.attributes ?? {}) as Record<string, unknown>).content,
          status: span.status_code === "ERROR" ? "error" : "ok",
        },
        duration_ms: span.duration_ms,
        ts: span.start_time,
      });
    } else if (attrs["maida.tool_name"]) {
      const argsEvent = spanEvents.find((ev) => ev.name === "maida.tool.args");
      const resultEvent = spanEvents.find((ev) => ev.name === "maida.tool.result");
      const rawArgs = ((argsEvent?.attributes ?? {}) as Record<string, unknown>).args;
      const rawResult = ((resultEvent?.attributes ?? {}) as Record<string, unknown>).result;
      events.push({
        event_type: "TOOL_CALL",
        payload: {
          tool_name: attrs["maida.tool_name"],
          args: typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs,
          result: typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult,
          status: span.status_code === "ERROR" ? "error" : "ok",
        },
        duration_ms: span.duration_ms,
        ts: span.start_time,
      });
    } else if (attrs["maida.event_type"] === "LOOP_WARNING") {
      const loopEvent = spanEvents.find((ev) => ev.name === "maida.loop.warning");
      events.push({
        event_type: "LOOP_WARNING",
        payload: loopEvent?.attributes ?? {},
        ts: span.start_time,
      });
    } else if (attrs["maida.event_type"] === "ERROR") {
      events.push({
        event_type: "ERROR",
        payload: {
          error_type: attrs["maida.error_type"],
          message: attrs["maida.error_message"],
        },
        ts: span.start_time,
      });
    }
  }

  return events.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
}

function eventTypes(events: Record<string, unknown>[]): string[] {
  return events.map((e) => e.event_type as string);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  savedEnv = process.env.MAIDA_DATA_DIR;
  tempDir = makeTempDir();
  process.env.MAIDA_DATA_DIR = tempDir;
  const config = loadConfig();
  hooks = buildHookMap(config);
  clearAllSessions();
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.MAIDA_DATA_DIR;
  } else {
    process.env.MAIDA_DATA_DIR = savedEnv;
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session.created -> RUN_START", () => {
  it("creates current trace metadata with status running", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-1") });

    const meta = readMetaJson(tempDir);
    expect(meta.status).toBe("running");
    expect(meta.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(meta.run_name).toBe("opencode:sess-1");
    expect(existsSync(join(readRunDir(tempDir), "run.json"))).toBe(false);
    expect(existsSync(join(readRunDir(tempDir), "events.jsonl"))).toBe(false);

    const events = readEvents(tempDir);
    expect(eventTypes(events)).toContain("RUN_START");
  });
});

describe("session.deleted -> RUN_END(ok)", () => {
  it("finalizes run with status ok and writes RUN_START + RUN_END", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-2") });
    await fireEvent("session.deleted", { info: makeSessionInfo("sess-2") });

    const meta = readMetaJson(tempDir);
    expect(meta.status).toBe("ok");
    expect(meta.ended_at).toBeTruthy();
    expect(typeof meta.duration_ms).toBe("number");
    const rootSpans = readSpans(tempDir).filter(
      (span) => "maida.run_name" in ((span.attributes ?? {}) as Record<string, unknown>),
    );
    expect(rootSpans).toHaveLength(1);

    const types = eventTypes(readEvents(tempDir));
    expect(types[0]).toBe("RUN_START");
    expect(types[types.length - 1]).toBe("RUN_END");
  });
});

describe("session.error -> ERROR + RUN_END(error)", () => {
  it("emits ERROR event and finalizes with status error", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-3") });
    await fireEvent("session.error", {
      sessionID: "sess-3",
      error: { type: "unknown", message: "something broke" },
    });

    const meta = readMetaJson(tempDir);
    expect(meta.status).toBe("error");

    const events = readEvents(tempDir);
    const types = eventTypes(events);
    expect(types).toContain("ERROR");
    expect(types[types.length - 1]).toBe("RUN_END");

    const errorEv = events.find((e) => e.event_type === "ERROR");
    const payload = errorEv!.payload as Record<string, unknown>;
    expect(payload.message).toBe("something broke");
  });
});

describe("message.part.updated -> LLM_CALL (flush-on-next-message)", () => {
  it("accumulates deltas and flushes one LLM_CALL per message id", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-4") });

    await fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-4", messageID: "msg-1", type: "text", text: "Hello " },
      delta: "Hello ",
    });
    await fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-4", messageID: "msg-1", type: "text", text: "Hello world!" },
      delta: "world!",
    });

    let events = readEvents(tempDir);
    expect(eventTypes(events)).not.toContain("LLM_CALL");

    await fireEvent("message.part.updated", {
      part: { id: "p2", sessionID: "sess-4", messageID: "msg-2", type: "text", text: "Next turn" },
      delta: "Next turn",
    });

    events = readEvents(tempDir);
    const llmCalls = events.filter((e) => e.event_type === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);

    const payload = llmCalls[0].payload as Record<string, unknown>;
    expect(payload.response).toBe("Hello world!");
    expect(payload.status).toBe("ok");
  });

  it("flushes pending LLM call on session.deleted", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-5") });

    await fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-5", messageID: "msg-1", type: "text", text: "only message" },
      delta: "only message",
    });

    await fireEvent("session.deleted", { info: makeSessionInfo("sess-5") });

    const events = readEvents(tempDir);
    const llmCalls = events.filter((e) => e.event_type === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);

    const payload = llmCalls[0].payload as Record<string, unknown>;
    expect(payload.response).toBe("only message");
  });

  it("flushes pending LLM call on session.idle", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-idle") });

    await fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-idle", messageID: "msg-1", type: "text", text: "idle flush" },
      delta: "idle flush",
    });

    await fireEvent("session.idle", { sessionID: "sess-idle" });

    const events = readEvents(tempDir);
    const llmCalls = events.filter((e) => e.event_type === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);
  });

  it("ignores non-text parts", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-nontext") });

    await fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-nontext", messageID: "msg-1", type: "reasoning", text: "thinking..." },
    });

    await fireEvent("session.idle", { sessionID: "sess-nontext" });

    const events = readEvents(tempDir);
    const llmCalls = events.filter((e) => e.event_type === "LLM_CALL");
    expect(llmCalls).toHaveLength(0);
  });
});

describe("message.part.updated (tool) -> TOOL_CALL", () => {
  it("emits TOOL_CALL with correct tool_name and status ok", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-6") });

    await fireEvent("message.part.updated", {
      part: {
        id: "p1",
        sessionID: "sess-6",
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: { status: "pending", input: { command: "ls -la" } },
      },
    });
    await fireEvent("message.part.updated", {
      part: {
        id: "p2",
        sessionID: "sess-6",
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: { status: "completed", input: { command: "ls -la" }, output: "file1.txt\nfile2.txt", title: "bash" },
      },
    });

    const events = readEvents(tempDir);
    const toolCalls = events.filter((e) => e.event_type === "TOOL_CALL");
    expect(toolCalls).toHaveLength(1);

    const payload = toolCalls[0].payload as Record<string, unknown>;
    expect(payload.tool_name).toBe("bash");
    expect(payload.status).toBe("ok");
    expect(payload.args).toEqual({ command: "ls -la" });
    expect(payload.result).toBe("file1.txt\nfile2.txt");
    expect(toolCalls[0].duration_ms).toBeTypeOf("number");

    await fireEvent("session.deleted", { info: makeSessionInfo("sess-6") });

    const meta = readMetaJson(tempDir);
    const counts = meta.counts as Record<string, number>;
    expect(counts.tool_calls).toBe(1);
  });

  it("records args from pending tool call", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-args") });

    await fireEvent("message.part.updated", {
      part: {
        id: "p1",
        sessionID: "sess-args",
        messageID: "m1",
        type: "tool",
        callID: "call-a",
        tool: "read",
        state: { status: "pending", input: { filePath: "/etc/hosts" } },
      },
    });
    await fireEvent("message.part.updated", {
      part: {
        id: "p2",
        sessionID: "sess-args",
        messageID: "m1",
        type: "tool",
        callID: "call-a",
        tool: "read",
        state: { status: "completed", input: { filePath: "/etc/hosts" }, output: "127.0.0.1 localhost", title: "read" },
      },
    });

    await fireEvent("session.deleted", { info: makeSessionInfo("sess-args") });

    const events = readEvents(tempDir);
    const toolCalls = events.filter((e) => e.event_type === "TOOL_CALL");
    const payload = toolCalls[0].payload as Record<string, unknown>;
    expect(payload.args).toEqual({ filePath: "/etc/hosts" });
  });

  it("redacts sensitive tool payloads in raw spans.jsonl", async () => {
    const secret = "sk-live-secret";
    await fireEvent("session.created", { info: makeSessionInfo("sess-redact") });

    await fireEvent("message.part.updated", {
      part: {
        id: "p1",
        sessionID: "sess-redact",
        messageID: "m1",
        type: "tool",
        callID: "call-secret",
        tool: "bash",
        state: { status: "pending", input: { api_key: secret, command: "echo ok" } },
      },
    });
    await fireEvent("message.part.updated", {
      part: {
        id: "p2",
        sessionID: "sess-redact",
        messageID: "m1",
        type: "tool",
        callID: "call-secret",
        tool: "bash",
        state: { status: "completed", output: { token: secret, ok: true } },
      },
    });

    await fireEvent("session.deleted", { info: makeSessionInfo("sess-redact") });

    const rawSpans = readFileSync(join(readRunDir(tempDir), "spans.jsonl"), "utf-8");
    expect(rawSpans).not.toContain(secret);

    const [toolSpan] = readSpans(tempDir).filter(
      (span) => "maida.tool_name" in ((span.attributes ?? {}) as Record<string, unknown>),
    );
    const spanEvents = toolSpan.events as Record<string, unknown>[];
    const args = JSON.parse(String(((spanEvents[0].attributes ?? {}) as Record<string, unknown>).args));
    const result = JSON.parse(String(((spanEvents[1].attributes ?? {}) as Record<string, unknown>).result));
    expect(args.api_key).toBe("__REDACTED__");
    expect(result.token).toBe("__REDACTED__");
  });
});

describe("loop detection -> LOOP_WARNING", () => {
  it("emits LOOP_WARNING after 3 repeated identical tool calls", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-loop") });

    for (let i = 0; i < 3; i++) {
      await fireEvent("message.part.updated", {
        part: {
          id: `p-start-${i}`,
          sessionID: "sess-loop",
          messageID: `m${i}`,
          type: "tool",
          callID: `lc-${i}`,
          tool: "search",
          state: { status: "pending", input: { query: "same query" } },
        },
      });
      await fireEvent("message.part.updated", {
        part: {
          id: `p-end-${i}`,
          sessionID: "sess-loop",
          messageID: `m${i}`,
          type: "tool",
          callID: `lc-${i}`,
          tool: "search",
          state: { status: "completed", input: { query: "same query" }, output: "no results", title: "search" },
        },
      });
    }

    const events = readEvents(tempDir);
    const warnings = events.filter((e) => e.event_type === "LOOP_WARNING");
    expect(warnings.length).toBeGreaterThanOrEqual(1);

    const payload = warnings[0].payload as Record<string, unknown>;
    expect(payload.pattern).toContain("TOOL_CALL:search");
    expect(payload.repetitions).toBe(3);
  });

  it("deduplicates LOOP_WARNING — same pattern does not emit twice", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-dedup") });

    for (let i = 0; i < 6; i++) {
      await fireEvent("message.part.updated", {
        part: {
          id: `p-start-${i}`,
          sessionID: "sess-dedup",
          messageID: `m${i}`,
          type: "tool",
          callID: `dd-${i}`,
          tool: "search",
          state: { status: "pending", input: { query: "same" } },
        },
      });
      await fireEvent("message.part.updated", {
        part: {
          id: `p-end-${i}`,
          sessionID: "sess-dedup",
          messageID: `m${i}`,
          type: "tool",
          callID: `dd-${i}`,
          tool: "search",
          state: { status: "completed", input: { query: "same" }, output: "nope", title: "search" },
        },
      });
    }

    const events = readEvents(tempDir);
    const warnings = events.filter((e) => e.event_type === "LOOP_WARNING");
    expect(warnings).toHaveLength(1);
  });
});

describe("current trace storage contract", () => {
  it("stamps every span and meta.json with the current spec_version", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-spec") });

    await fireEvent("message.part.updated", {
      part: {
        id: "p1",
        sessionID: "sess-spec",
        messageID: "m1",
        type: "tool",
        callID: "sv-1",
        tool: "bash",
        state: { status: "pending", input: { command: "echo test" } },
      },
    });
    await fireEvent("message.part.updated", {
      part: {
        id: "p2",
        sessionID: "sess-spec",
        messageID: "m1",
        type: "tool",
        callID: "sv-1",
        tool: "bash",
        state: { status: "completed", input: { command: "echo test" }, output: "test", title: "bash" },
      },
    });

    await fireEvent("session.deleted", { info: makeSessionInfo("sess-spec") });

    const meta = readMetaJson(tempDir);
    expect(meta.spec_version).toBe("0.2");

    const spans = readSpans(tempDir);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.spec_version).toBe("0.2");
      expect(span.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(span.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(span).toHaveProperty("status_description");
    }

    // Spans nest under a single run root whose id is the first 16 hex of the
    // trace id; every other span references it as parent.
    const expectedRoot = String(meta.trace_id).slice(0, 16);
    const roots = spans.filter((span) => span.parent_span_id === null);
    expect(roots).toHaveLength(1);
    expect(roots[0].span_id).toBe(expectedRoot);
    for (const span of spans) {
      if (span.parent_span_id !== null) {
        expect(span.parent_span_id).toBe(expectedRoot);
      }
    }
  });
});

describe("run counts", () => {
  it("counts reflect correct tallies after mixed events", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-counts") });

    await fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-counts", messageID: "m1", type: "text", text: "response text" },
      delta: "response text",
    });
    await fireEvent("session.idle", { sessionID: "sess-counts" });

    await fireEvent("message.part.updated", {
      part: {
        id: "p2",
        sessionID: "sess-counts",
        messageID: "m2",
        type: "tool",
        callID: "tc-1",
        tool: "bash",
        state: { status: "pending", input: { command: "ls" } },
      },
    });
    await fireEvent("message.part.updated", {
      part: {
        id: "p3",
        sessionID: "sess-counts",
        messageID: "m2",
        type: "tool",
        callID: "tc-1",
        tool: "bash",
        state: { status: "completed", input: { command: "ls" }, output: "ok", title: "bash" },
      },
    });

    await fireEvent("session.deleted", { info: makeSessionInfo("sess-counts") });

    const meta = readMetaJson(tempDir);
    const counts = meta.counts as Record<string, number>;
    expect(counts.llm_calls).toBe(1);
    expect(counts.tool_calls).toBe(1);
    expect(counts.errors).toBe(0);
  });
});

describe("message.updated -> RUN_START (fallback for resumed sessions)", () => {
  it("creates run when session was already created before plugin loaded", async () => {
    await fireEvent("message.updated", {
      info: { id: "msg-1", sessionID: "sess-resume", role: "user", time: { created: Date.now() }, agent: "build", model: { providerID: "opencode", modelID: "test" } },
    });

    const meta = readMetaJson(tempDir);
    expect(meta.status).toBe("running");
    expect(meta.run_name).toBe("opencode:sess-resume");
  });

  it("session.created takes precedence over message.updated", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-pref") });
    await fireEvent("message.updated", {
      info: { id: "msg-2", sessionID: "sess-pref", role: "user", time: { created: Date.now() }, agent: "build", model: { providerID: "opencode", modelID: "test" } },
    });

    const events = readEvents(tempDir);
    const starts = events.filter((e) => e.event_type === "RUN_START");
    expect(starts).toHaveLength(1);
  });
});

describe("server.instance.disposed -> RUN_END(ok) for all sessions", () => {
  it("ends all active sessions on server.instance.disposed", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-a") });
    await fireEvent("session.created", { info: makeSessionInfo("sess-b") });

    await fireEvent("server.instance.disposed", { directory: "/tmp/test" });

    const runsDir = join(tempDir, "runs");
    const entries = readdirSync(runsDir);
    expect(entries).toHaveLength(2);

    for (const entry of entries) {
      const meta = JSON.parse(readFileSync(join(runsDir, entry, "meta.json"), "utf-8"));
      expect(meta.status).toBe("ok");
      expect(readFileSync(join(runsDir, entry, "spans.jsonl"), "utf-8")).toContain(entry);
    }
  });

  it("flushes pending LLM call on server.instance.disposed", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-flush") });

    await fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-flush", messageID: "m1", type: "text", text: "unflushed response" },
      delta: "unflushed response",
    });

    await fireEvent("server.instance.disposed", { directory: "/tmp/test" });

    const events = readEvents(tempDir);
    const llmCalls = events.filter((e) => e.event_type === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);

    const payload = llmCalls[0].payload as Record<string, unknown>;
    expect(payload.response).toBe("unflushed response");
  });
});
