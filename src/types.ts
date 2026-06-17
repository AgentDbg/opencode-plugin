/**
 * OpenCode hook payload shapes (derived from @opencode-ai/plugin v1.3.x SDK)
 * and internal adapter-only types for the Maida OpenCode plugin.
 *
 * Maida schema types (MaidaEvent, RunCounts, etc.) are imported
 * from @maida-ai/core — never duplicated here.
 */

import type { MaidaConfig, MaidaEvent, RunCounts } from "@maida-ai/core";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";

// ---------------------------------------------------------------------------
// Re-export the SDK plugin types so the rest of the adapter can reference them
// without importing @opencode-ai/plugin everywhere.
// ---------------------------------------------------------------------------

export type OcPluginInput = PluginInput;
export type OcHooks = Hooks;

// ---------------------------------------------------------------------------
// Internal adapter types (not exposed to OpenCode)
// ---------------------------------------------------------------------------

export interface PendingLlmCall {
  messageId: string;
  model: string;
  textParts: string[];
  firstPartTs: number;
}

export interface PendingToolCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  startTs: number;
}

export interface SessionState {
  sessionId: string;
  runId: string;
  rootSpanId: string;
  startedAt: string;
  startTs: number;
  config: MaidaConfig;
  counts: RunCounts;
  eventWindow: MaidaEvent[];
  loopEmitted: Set<string>;
  rootEvents: StoredSpanEvent[];
  pendingLlm: PendingLlmCall | null;
  pendingTools: Map<string, PendingToolCall>;
  toolCallSeq: number;
}

export interface StoredSpanEvent {
  name: string;
  timestamp: string;
  attributes: Record<string, unknown>;
}

export interface StoredSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  attributes: Record<string, unknown>;
  events: StoredSpanEvent[];
  status_code: "OK" | "ERROR" | "UNSET";
  status_description: string;
}
