/**
 * End-to-end hook tests using synthetic OpenCode events and temp directories.
 *
 * Each test gets its own temp data dir (via AGENTDBG_DATA_DIR) so there is
 * no filesystem coupling between tests. No OpenCode process needed.
 *
 * Payloads match the real @opencode-ai/sdk Event types (v1.3.x).
 */

import { readFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "@agentdbg/core";
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
  const dir = join(tmpdir(), `agentdbg-oc-test-${randomUUID()}`);
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

function readRunJson(dataDir: string): Record<string, unknown> {
  const runsDir = join(dataDir, "runs");
  const entries = readdirSync(runsDir);
  if (entries.length === 0) throw new Error("no run dirs found");
  const runDir = join(runsDir, entries[0]);
  return JSON.parse(readFileSync(join(runDir, "run.json"), "utf-8"));
}

function readEvents(dataDir: string): Record<string, unknown>[] {
  const runsDir = join(dataDir, "runs");
  const entries = readdirSync(runsDir);
  if (entries.length === 0) return [];
  const runDir = join(runsDir, entries[0]);
  const raw = readFileSync(join(runDir, "events.jsonl"), "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

function eventTypes(events: Record<string, unknown>[]): string[] {
  return events.map((e) => e.event_type as string);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  savedEnv = process.env.AGENTDBG_DATA_DIR;
  tempDir = makeTempDir();
  process.env.AGENTDBG_DATA_DIR = tempDir;
  const config = loadConfig();
  hooks = buildHookMap(config);
  clearAllSessions();
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.AGENTDBG_DATA_DIR;
  } else {
    process.env.AGENTDBG_DATA_DIR = savedEnv;
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
  it("creates run.json with status running and spec_version 0.1", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-1") });

    const meta = readRunJson(tempDir);
    expect(meta.status).toBe("running");
    expect(meta.spec_version).toBe("0.1");
    expect(meta.run_name).toBe("opencode:sess-1");

    const events = readEvents(tempDir);
    expect(eventTypes(events)).toContain("RUN_START");
  });
});

describe("session.deleted -> RUN_END(ok)", () => {
  it("finalizes run with status ok and writes RUN_START + RUN_END", async () => {
    await fireEvent("session.created", { info: makeSessionInfo("sess-2") });
    await fireEvent("session.deleted", { info: makeSessionInfo("sess-2") });

    const meta = readRunJson(tempDir);
    expect(meta.status).toBe("ok");
    expect(meta.ended_at).toBeTruthy();
    expect(typeof meta.duration_ms).toBe("number");

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

    const meta = readRunJson(tempDir);
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

    const meta = readRunJson(tempDir);
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

describe("spec_version on events", () => {
  it("all events have spec_version 0.1", async () => {
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

    const events = readEvents(tempDir);
    for (const ev of events) {
      expect(ev.spec_version).toBe("0.1");
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

    const meta = readRunJson(tempDir);
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

    const meta = readRunJson(tempDir);
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
      const meta = JSON.parse(readFileSync(join(runsDir, entry, "run.json"), "utf-8"));
      expect(meta.status).toBe("ok");
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
