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
import { buildHookMap } from "../src/hooks.js";
import type { OcHooks } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let hooks: OcHooks;
let savedEnv: string | undefined;

function makeTempDir(): string {
  const dir = join(tmpdir(), `agentdbg-oc-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Fire an event through the `event` hook (matches SDK Event shape). */
function fireEvent(type: string, properties: Record<string, unknown>): void {
  hooks.event!({ event: { type, properties } as never });
}

/** Build a minimal SDK Session object for session.created/deleted payloads. */
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
  it("creates run.json with status running and spec_version 0.1", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-1") });

    const meta = readRunJson(tempDir);
    expect(meta.status).toBe("running");
    expect(meta.spec_version).toBe("0.1");
    expect(meta.run_name).toBe("opencode:sess-1");

    const events = readEvents(tempDir);
    expect(eventTypes(events)).toContain("RUN_START");
  });
});

describe("session.deleted -> RUN_END(ok)", () => {
  it("finalizes run with status ok and writes RUN_START + RUN_END", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-2") });
    fireEvent("session.deleted", { info: makeSessionInfo("sess-2") });

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
  it("emits ERROR event and finalizes with status error", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-3") });
    fireEvent("session.error", {
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
  it("accumulates deltas and flushes one LLM_CALL per message id", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-4") });

    fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-4", messageID: "msg-1", type: "text", text: "Hello " },
      delta: "Hello ",
    });
    fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-4", messageID: "msg-1", type: "text", text: "Hello world!" },
      delta: "world!",
    });

    let events = readEvents(tempDir);
    expect(eventTypes(events)).not.toContain("LLM_CALL");

    fireEvent("message.part.updated", {
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

  it("flushes pending LLM call on session.deleted", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-5") });

    fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-5", messageID: "msg-1", type: "text", text: "only message" },
      delta: "only message",
    });

    fireEvent("session.deleted", { info: makeSessionInfo("sess-5") });

    const events = readEvents(tempDir);
    const llmCalls = events.filter((e) => e.event_type === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);

    const payload = llmCalls[0].payload as Record<string, unknown>;
    expect(payload.response).toBe("only message");
  });

  it("flushes pending LLM call on session.idle", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-idle") });

    fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-idle", messageID: "msg-1", type: "text", text: "idle flush" },
      delta: "idle flush",
    });

    fireEvent("session.idle", { sessionID: "sess-idle" });

    const events = readEvents(tempDir);
    const llmCalls = events.filter((e) => e.event_type === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);
  });

  it("ignores non-text parts", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-nontext") });

    fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-nontext", messageID: "msg-1", type: "reasoning", text: "thinking..." },
    });

    fireEvent("session.idle", { sessionID: "sess-nontext" });

    const events = readEvents(tempDir);
    const llmCalls = events.filter((e) => e.event_type === "LLM_CALL");
    expect(llmCalls).toHaveLength(0);
  });
});

describe("tool.execute.before/after -> TOOL_CALL", () => {
  it("emits TOOL_CALL with correct tool_name and status ok", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-6") });

    hooks["tool.execute.before"]!(
      { sessionID: "sess-6", tool: "bash", callID: "call-1" },
      { args: { command: "ls -la" } },
    );
    hooks["tool.execute.after"]!(
      { sessionID: "sess-6", tool: "bash", callID: "call-1", args: { command: "ls -la" } },
      { title: "bash", output: "file1.txt\nfile2.txt", metadata: {} },
    );

    const events = readEvents(tempDir);
    const toolCalls = events.filter((e) => e.event_type === "TOOL_CALL");
    expect(toolCalls).toHaveLength(1);

    const payload = toolCalls[0].payload as Record<string, unknown>;
    expect(payload.tool_name).toBe("bash");
    expect(payload.status).toBe("ok");
    expect(payload.args).toEqual({ command: "ls -la" });
    expect(payload.result).toBe("file1.txt\nfile2.txt");
    expect(toolCalls[0].duration_ms).toBeTypeOf("number");

    fireEvent("session.deleted", { info: makeSessionInfo("sess-6") });

    const meta = readRunJson(tempDir);
    const counts = meta.counts as Record<string, number>;
    expect(counts.tool_calls).toBe(1);
  });

  it("records args from before-hook even if after-hook also provides them", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-args") });

    hooks["tool.execute.before"]!(
      { sessionID: "sess-args", tool: "read", callID: "call-a" },
      { args: { filePath: "/etc/hosts" } },
    );
    hooks["tool.execute.after"]!(
      { sessionID: "sess-args", tool: "read", callID: "call-a", args: { filePath: "/etc/hosts" } },
      { title: "read", output: "127.0.0.1 localhost", metadata: {} },
    );

    fireEvent("session.deleted", { info: makeSessionInfo("sess-args") });

    const events = readEvents(tempDir);
    const toolCalls = events.filter((e) => e.event_type === "TOOL_CALL");
    const payload = toolCalls[0].payload as Record<string, unknown>;
    expect(payload.args).toEqual({ filePath: "/etc/hosts" });
  });
});

describe("loop detection -> LOOP_WARNING", () => {
  it("emits LOOP_WARNING after 3 repeated identical tool calls", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-loop") });

    for (let i = 0; i < 3; i++) {
      hooks["tool.execute.before"]!(
        { sessionID: "sess-loop", tool: "search", callID: `lc-${i}` },
        { args: { query: "same query" } },
      );
      hooks["tool.execute.after"]!(
        { sessionID: "sess-loop", tool: "search", callID: `lc-${i}`, args: { query: "same query" } },
        { title: "search", output: "no results", metadata: {} },
      );
    }

    const events = readEvents(tempDir);
    const warnings = events.filter((e) => e.event_type === "LOOP_WARNING");
    expect(warnings.length).toBeGreaterThanOrEqual(1);

    const payload = warnings[0].payload as Record<string, unknown>;
    expect(payload.pattern).toContain("TOOL_CALL:search");
    expect(payload.repetitions).toBe(3);
  });

  it("deduplicates LOOP_WARNING — same pattern does not emit twice", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-dedup") });

    for (let i = 0; i < 6; i++) {
      hooks["tool.execute.before"]!(
        { sessionID: "sess-dedup", tool: "search", callID: `dd-${i}` },
        { args: { query: "same" } },
      );
      hooks["tool.execute.after"]!(
        { sessionID: "sess-dedup", tool: "search", callID: `dd-${i}`, args: { query: "same" } },
        { title: "search", output: "nope", metadata: {} },
      );
    }

    const events = readEvents(tempDir);
    const warnings = events.filter((e) => e.event_type === "LOOP_WARNING");
    expect(warnings).toHaveLength(1);
  });
});

describe("spec_version on events", () => {
  it("all events have spec_version 0.1", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-spec") });

    hooks["tool.execute.before"]!(
      { sessionID: "sess-spec", tool: "bash", callID: "sv-1" },
      { args: { command: "echo test" } },
    );
    hooks["tool.execute.after"]!(
      { sessionID: "sess-spec", tool: "bash", callID: "sv-1", args: { command: "echo test" } },
      { title: "bash", output: "test", metadata: {} },
    );

    fireEvent("session.deleted", { info: makeSessionInfo("sess-spec") });

    const events = readEvents(tempDir);
    for (const ev of events) {
      expect(ev.spec_version).toBe("0.1");
    }
  });
});

describe("run counts", () => {
  it("counts reflect correct tallies after mixed events", () => {
    fireEvent("session.created", { info: makeSessionInfo("sess-counts") });

    fireEvent("message.part.updated", {
      part: { id: "p1", sessionID: "sess-counts", messageID: "m1", type: "text", text: "response text" },
      delta: "response text",
    });
    fireEvent("session.idle", { sessionID: "sess-counts" });

    hooks["tool.execute.before"]!(
      { sessionID: "sess-counts", tool: "bash", callID: "tc-1" },
      { args: { command: "ls" } },
    );
    hooks["tool.execute.after"]!(
      { sessionID: "sess-counts", tool: "bash", callID: "tc-1", args: { command: "ls" } },
      { title: "bash", output: "ok", metadata: {} },
    );

    fireEvent("session.deleted", { info: makeSessionInfo("sess-counts") });

    const meta = readRunJson(tempDir);
    const counts = meta.counts as Record<string, number>;
    expect(counts.llm_calls).toBe(1);
    expect(counts.tool_calls).toBe(1);
    expect(counts.errors).toBe(0);
  });
});
