/**
 * Per-session mutable state and helpers for emitting Maida events.
 *
 * Each OpenCode session maps to one Maida run. This module manages
 * the session lifecycle, pending LLM/tool call buffers, and loop detection.
 */

import {
  type MaidaConfig,
  type MaidaEvent,
  EventType,
  defaultCounts,
  detectLoop,
  newEvent,
  patternKey,
  redactAndTruncate,
  buildErrorPayload,
} from "@maida-ai/core";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type {
  PendingLlmCall,
  PendingToolCall,
  SessionState,
  StoredSpan,
} from "./types.js";

const META_JSON = "meta.json";
const SPANS_JSONL = "spans.jsonl";
const OK_STATUS = "OK";
const ERROR_STATUS = "ERROR";

function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoFromMs(ts: number): string {
  return new Date(ts).toISOString();
}

function runDir(state: Pick<SessionState, "runId" | "config">): string {
  return join(state.config.data_dir, "runs", state.runId);
}

function atomicWriteJson(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.${META_JSON}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify(data, null, 2)}\n`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, content, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function appendSpan(state: SessionState, span: StoredSpan): void {
  const path = join(runDir(state), SPANS_JSONL);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeFileSync(fd, `${JSON.stringify(span)}\n`, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeMeta(
  state: SessionState,
  status: "running" | "ok" | "error",
  endedAt: string | null = null,
): void {
  const durationMs =
    endedAt == null ? null : Math.max(0, new Date(endedAt).getTime() - state.startTs);
  atomicWriteJson(join(runDir(state), META_JSON), {
    trace_id: state.runId,
    run_name: `opencode:${state.sessionId}`,
    started_at: state.startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    status,
    counts: state.counts,
  });
}

function sanitize(
  value: unknown,
  state: SessionState,
): Record<string, unknown> {
  const safe = redactAndTruncate(value, state.config);
  if (safe && typeof safe === "object" && !Array.isArray(safe)) {
    return safe as Record<string, unknown>;
  }
  return { value: safe ?? null };
}

function jsonAttribute(value: unknown, state: SessionState): string {
  return JSON.stringify(redactAndTruncate(value, state.config));
}

function errorMessage(error: string | Error | null | undefined): string {
  if (error == null) return "";
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Active sessions registry
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, SessionState>();

export function getSession(sessionId: string): SessionState | undefined {
  return activeSessions.get(sessionId);
}

export function removeSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

export function getAllSessions(): Map<string, SessionState> {
  return activeSessions;
}

export function clearAllSessions(): void {
  activeSessions.clear();
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

export function initSession(
  sessionId: string,
  config: MaidaConfig,
  model?: string,
): SessionState {
  const traceId = newTraceId();
  const startedAt = nowIso();
  const startTs = Date.now();
  const startEvent = newEvent(EventType.RUN_START, traceId, `opencode:${sessionId}`, {
    run_name: `opencode:${sessionId}`,
    platform: process.platform,
    cwd: process.cwd(),
  });

  const state: SessionState = {
    sessionId,
    runId: traceId,
    rootSpanId: newSpanId(),
    startedAt,
    startTs,
    config,
    counts: defaultCounts(),
    eventWindow: [startEvent],
    loopEmitted: new Set(),
    rootEvents: [],
    pendingLlm: null,
    pendingTools: new Map(),
    toolCallSeq: 0,
  };

  writeMeta(state, "running");
  activeSessions.set(sessionId, state);
  return state;
}

// ---------------------------------------------------------------------------
// LLM call helpers
// ---------------------------------------------------------------------------

export function accumulateLlmPart(
  state: SessionState,
  messageId: string,
  text: string,
  model: string,
): void {
  if (state.pendingLlm && state.pendingLlm.messageId !== messageId) {
    flushPendingLlm(state);
  }

  if (!state.pendingLlm) {
    state.pendingLlm = {
      messageId,
      model,
      textParts: [],
      firstPartTs: Date.now(),
    };
  }

  state.pendingLlm.textParts.push(text);
}

export function flushPendingLlm(state: SessionState): void {
  const pending = state.pendingLlm;
  if (!pending) return;
  state.pendingLlm = null;

  const durationMs = Math.max(0, Date.now() - pending.firstPartTs);
  const responseText = pending.textParts.join("");

  const startTime = isoFromMs(pending.firstPartTs);
  const endTime = nowIso();
  const safeResponse = redactAndTruncate(responseText, state.config);

  appendSpan(state, {
    trace_id: state.runId,
    span_id: newSpanId(),
    parent_span_id: state.rootSpanId,
    name: pending.model,
    kind: "CLIENT",
    start_time: startTime,
    end_time: endTime,
    duration_ms: durationMs,
    attributes: {
      "gen_ai.system": "unknown",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": pending.model,
      "gen_ai.response.model": pending.model,
      "maida.status": "ok",
    },
    events: [
      {
        name: "gen_ai.assistant.message",
        timestamp: endTime,
        attributes: { content: safeResponse },
      },
    ],
    status_code: OK_STATUS,
    status_description: "",
  });

  const ev = newEvent(EventType.LLM_CALL, state.runId, pending.model, {
    model: pending.model,
    prompt: null,
    response: safeResponse,
    usage: null,
    provider: "unknown",
    temperature: null,
    stop_reason: null,
    status: "ok",
    error: null,
  }, {
    durationMs,
  });

  state.counts.llm_calls += 1;
  writeMeta(state, "running");

  pushToWindow(state, ev);
  maybeEmitLoopWarning(state);
}

// ---------------------------------------------------------------------------
// Tool call helpers
// ---------------------------------------------------------------------------

export function startToolCall(
  state: SessionState,
  toolName: string,
  callId: string | undefined,
  args: Record<string, unknown>,
): string {
  const resolvedId = callId ?? `seq-${state.toolCallSeq++}`;
  const pending: PendingToolCall = {
    callId: resolvedId,
    toolName,
    args,
    startTs: Date.now(),
  };
  state.pendingTools.set(resolvedId, pending);
  return resolvedId;
}

export function finishToolCall(
  state: SessionState,
  callId: string,
  result: unknown,
  error: string | Error | null | undefined,
): void {
  const pending = state.pendingTools.get(callId);
  if (!pending) return;
  state.pendingTools.delete(callId);

  const durationMs = Math.max(0, Date.now() - pending.startTs);
  const status = error ? "error" : "ok";
  const statusCode = error ? ERROR_STATUS : OK_STATUS;
  const startTime = isoFromMs(pending.startTs);
  const endTime = nowIso();

  const errorPayload =
    error != null ? buildErrorPayload(error, state.config, false) : null;

  appendSpan(state, {
    trace_id: state.runId,
    span_id: newSpanId(),
    parent_span_id: state.rootSpanId,
    name: pending.toolName,
    kind: "INTERNAL",
    start_time: startTime,
    end_time: endTime,
    duration_ms: durationMs,
    attributes: sanitize(
      {
        "maida.tool_name": pending.toolName,
        "maida.status": status,
        ...(errorPayload
          ? {
              "maida.error_type": errorPayload.error_type,
              "maida.error_message": errorPayload.message,
              "maida.error_stack": errorPayload.stack,
            }
          : {}),
      },
      state,
    ),
    events: [
      {
        name: "maida.tool.args",
        timestamp: startTime,
        attributes: { args: jsonAttribute(pending.args, state) },
      },
      {
        name: "maida.tool.result",
        timestamp: endTime,
        attributes: { result: jsonAttribute(result ?? null, state) },
      },
    ],
    status_code: statusCode,
    status_description: redactAndTruncate(errorMessage(error), state.config) as string,
  });

  const ev = newEvent(EventType.TOOL_CALL, state.runId, pending.toolName, {
    tool_name: pending.toolName,
    args: redactAndTruncate(pending.args, state.config),
    result: redactAndTruncate(result ?? null, state.config),
    status,
    error: errorPayload,
  }, {
    durationMs,
  });

  state.counts.tool_calls += 1;
  writeMeta(state, "running");

  pushToWindow(state, ev);
  maybeEmitLoopWarning(state);
}

// ---------------------------------------------------------------------------
// Error + finalization helpers
// ---------------------------------------------------------------------------

export function emitError(
  state: SessionState,
  err: unknown,
): void {
  const errPayload = buildErrorPayload(
    err instanceof Error ? err : typeof err === "string" ? err : String(err),
    state.config,
    true,
  );

  state.rootEvents.push({
    name: "exception",
    timestamp: nowIso(),
    attributes: sanitize(
      {
        "maida.error_type": errPayload?.error_type ?? "Error",
        "maida.error_message": errPayload?.message ?? String(err),
        "maida.error_stack": errPayload?.stack ?? null,
      },
      state,
    ),
  });

  const ev = newEvent(
    EventType.ERROR,
    state.runId,
    "session.error",
    errPayload ?? { error_type: "Error", message: String(err) },
  );

  state.counts.errors += 1;
  writeMeta(state, "running");
}

export function endSession(
  state: SessionState,
  status: "ok" | "error",
): void {
  const endPayload = {
    status,
    summary: {
      llm_calls: state.counts.llm_calls,
      tool_calls: state.counts.tool_calls,
      errors: state.counts.errors,
      duration_ms: null,
    },
  };

  const ev = newEvent(EventType.RUN_END, state.runId, `opencode:${state.sessionId}`, endPayload);
  const endTime = nowIso();
  appendSpan(state, {
    trace_id: state.runId,
    span_id: state.rootSpanId,
    parent_span_id: null,
    name: `opencode:${state.sessionId}`,
    kind: "INTERNAL",
    start_time: state.startedAt,
    end_time: endTime,
    duration_ms: Math.max(0, new Date(endTime).getTime() - state.startTs),
    attributes: sanitize(
      {
        "maida.run_name": `opencode:${state.sessionId}`,
        "maida.platform": process.platform,
        "maida.cwd": process.cwd(),
        "maida.status": status,
        "maida.llm_calls": state.counts.llm_calls,
        "maida.tool_calls": state.counts.tool_calls,
        "maida.errors": state.counts.errors,
        "maida.loop_warnings": state.counts.loop_warnings,
      },
      state,
    ),
    events: state.rootEvents,
    status_code: status === "error" ? ERROR_STATUS : OK_STATUS,
    status_description: "",
  });
  writeMeta(state, status, endTime);
  pushToWindow(state, ev);
}

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

function pushToWindow(state: SessionState, ev: MaidaEvent): void {
  state.eventWindow.push(ev);
  if (state.eventWindow.length > state.config.loop_window) {
    state.eventWindow = state.eventWindow.slice(-state.config.loop_window);
  }
}

function maybeEmitLoopWarning(state: SessionState): void {
  const loopPayload = detectLoop(
    state.eventWindow as unknown as Record<string, unknown>[],
    state.config.loop_window,
    state.config.loop_repetitions,
  );
  if (!loopPayload) return;

  const key = patternKey(loopPayload);
  if (state.loopEmitted.has(key)) return;
  state.loopEmitted.add(key);

  const pattern = (loopPayload.pattern as string) || "loop_warning";
  const maxNameLen = 80;
  const name =
    pattern.length <= maxNameLen ? pattern : pattern.slice(0, maxNameLen - 1) + "...";

  const ev = newEvent(EventType.LOOP_WARNING, state.runId, name, loopPayload);
  const timestamp = nowIso();
  appendSpan(state, {
    trace_id: state.runId,
    span_id: newSpanId(),
    parent_span_id: state.rootSpanId,
    name: "loop_warning",
    kind: "INTERNAL",
    start_time: timestamp,
    end_time: timestamp,
    duration_ms: 0,
    attributes: {
      "maida.event_type": "LOOP_WARNING",
    },
    events: [
      {
        name: "maida.loop.warning",
        timestamp,
        attributes: sanitize(loopPayload, state),
      },
    ],
    status_code: OK_STATUS,
    status_description: "",
  });
  state.counts.loop_warnings += 1;
  writeMeta(state, "running");
}
