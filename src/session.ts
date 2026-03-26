/**
 * Per-session mutable state and helpers for emitting AgentDbg events.
 *
 * Each OpenCode session maps to one AgentDbg run. This module manages
 * the session lifecycle, pending LLM/tool call buffers, and loop detection.
 */

import {
  type AgentDbgConfig,
  type AgentDbgEvent,
  type RunCounts,
  EventType,
  appendEvent,
  createRun,
  defaultCounts,
  detectLoop,
  finalizeRun,
  newEvent,
  patternKey,
  redactAndTruncate,
  buildErrorPayload,
} from "@agentdbg/core";

import type { PendingLlmCall, PendingToolCall, SessionState } from "./types.js";

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
  config: AgentDbgConfig,
  model?: string,
): SessionState {
  const run = createRun(`opencode:${sessionId}`, { data_dir: config.data_dir });

  const startEvent = newEvent(EventType.RUN_START, run.run_id, `opencode:${sessionId}`, {
    run_name: `opencode:${sessionId}`,
    platform: process.platform,
    cwd: process.cwd(),
  });
  appendEvent(run.run_id, startEvent, { data_dir: config.data_dir });

  const state: SessionState = {
    sessionId,
    runId: run.run_id,
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

  const payload = redactAndTruncate(
    {
      model: pending.model,
      prompt: null,
      response: responseText,
      usage: null,
      provider: "unknown",
      temperature: null,
      stop_reason: null,
      status: "ok",
      error: null,
    },
    state.config,
  ) as Record<string, unknown>;

  const ev = newEvent(EventType.LLM_CALL, state.runId, pending.model, payload, {
    durationMs,
  });

  appendEvent(state.runId, ev, { data_dir: state.config.data_dir });
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

  const errorPayload =
    error != null ? buildErrorPayload(error, state.config, false) : null;

  const payload = redactAndTruncate(
    {
      tool_name: pending.toolName,
      args: pending.args,
      result: result ?? null,
      status,
      error: errorPayload,
    },
    state.config,
  ) as Record<string, unknown>;

  const ev = newEvent(EventType.TOOL_CALL, state.runId, pending.toolName, payload, {
    durationMs,
  });

  appendEvent(state.runId, ev, { data_dir: state.config.data_dir });
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

  const ev = newEvent(
    EventType.ERROR,
    state.runId,
    "session.error",
    errPayload ?? { error_type: "Error", message: String(err) },
  );

  appendEvent(state.runId, ev, { data_dir: state.config.data_dir });
  state.counts.errors += 1;
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
  appendEvent(state.runId, ev, { data_dir: state.config.data_dir });

  finalizeRun(state.runId, status, state.counts, { data_dir: state.config.data_dir });
}

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

function pushToWindow(state: SessionState, ev: AgentDbgEvent): void {
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
  appendEvent(state.runId, ev, { data_dir: state.config.data_dir });
  state.counts.loop_warnings += 1;
}
