/**
 * Per-session mutable state and helpers for emitting Maida events.
 *
 * Each OpenCode session maps to one Maida run. This module manages
 * the session lifecycle, pending LLM/tool call buffers, and loop detection.
 *
 * All trace persistence is delegated to @maida-ai/core's storage API
 * (createRun / appendSpan / appendEvent / finalizeRun) so that the spec
 * version, schema, redaction, and validation stay in a single source of
 * truth instead of being reimplemented here.
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
  createRun,
  appendSpan,
  appendEvent,
  finalizeRun,
} from "@maida-ai/core";
import { randomBytes } from "node:crypto";

import type { PendingLlmCall, PendingToolCall, SessionState } from "./types.js";

/** Span ids are 8 random bytes (16 hex chars), matching the OTel format. */
function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoFromMs(ts: number): string {
  return new Date(ts).toISOString();
}

/**
 * core derives the run-root span id deterministically as the first 16 hex
 * chars of the trace id (see @maida-ai/core's `runRootSpanId`). finalizeRun
 * writes the root span with this id, and core's appendEvent nests unparented
 * events under it, so the spans we build by hand reference the same root.
 */
function rootSpanId(state: SessionState): string {
  return state.runId.slice(0, 16);
}

/** Redact + truncate a value and JSON-encode it for use as a span attribute. */
function jsonAttribute(value: unknown, state: SessionState): string {
  return JSON.stringify(redactAndTruncate(value, state.config));
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
  const run = createRun(`opencode:${sessionId}`, { data_dir: config.data_dir });

  const startEvent = newEvent(EventType.RUN_START, run.trace_id, `opencode:${sessionId}`, {
    run_name: `opencode:${sessionId}`,
    platform: process.platform,
    cwd: process.cwd(),
  });

  const state: SessionState = {
    sessionId,
    runId: run.trace_id,
    config,
    counts: defaultCounts(),
    eventWindow: [startEvent],
    loopEmitted: new Set(),
    pendingLlm: null,
    pendingTools: new Map(),
    toolCallSeq: 0,
  };

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

  // Built as a span (rather than via appendEvent) so the real start/end times
  // from the streamed deltas are preserved; core normalizes, redacts, and
  // validates on write. Nested under the run root, matching core's appendEvent;
  // finalizeRun writes that root span.
  appendSpan(
    state.runId,
    {
      trace_id: state.runId,
      span_id: newSpanId(),
      parent_span_id: rootSpanId(state),
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
      status_code: "OK",
      status_description: "",
    },
    state.config,
  );

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
  const startTime = isoFromMs(pending.startTs);
  const endTime = nowIso();

  const errorPayload =
    error != null ? buildErrorPayload(error, state.config, false) : null;

  // Built as a span to preserve the real start/end times; args and result are
  // redacted before being JSON-encoded into span events. core re-sanitizes and
  // validates on write.
  appendSpan(
    state.runId,
    {
      trace_id: state.runId,
      span_id: newSpanId(),
      parent_span_id: rootSpanId(state),
      name: pending.toolName,
      kind: "INTERNAL",
      start_time: startTime,
      end_time: endTime,
      duration_ms: durationMs,
      attributes: {
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
      status_code: error ? "ERROR" : "OK",
      status_description: typeof errorPayload?.message === "string" ? errorPayload.message : "",
    },
    state.config,
  );

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

  // Point-in-time event: core maps it to the canonical ERROR span (status
  // ERROR, maida.error_* attributes).
  const ev = newEvent(
    EventType.ERROR,
    state.runId,
    "session.error",
    errPayload ?? { error_type: "Error", message: String(err) },
  );
  appendEvent(state.runId, ev, state.config);

  state.counts.errors += 1;
}

export function endSession(
  state: SessionState,
  status: "ok" | "error",
): void {
  // finalizeRun updates meta.json (ended_at, duration, status, counts) and
  // appends the synthetic root span that closes the trace.
  finalizeRun(state.runId, status, state.counts, { data_dir: state.config.data_dir });
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

  // Point-in-time event: core maps it to the canonical loop_warning span.
  const ev = newEvent(EventType.LOOP_WARNING, state.runId, name, loopPayload);
  appendEvent(state.runId, ev, state.config);
  state.counts.loop_warnings += 1;
}
