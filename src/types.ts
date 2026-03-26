/**
 * OpenCode hook payload shapes (derived from @opencode-ai/plugin v1.3.x SDK)
 * and internal adapter-only types for the AgentDbg OpenCode plugin.
 *
 * AgentDbg schema types (AgentDbgEvent, RunCounts, etc.) are imported
 * from @agentdbg/core — never duplicated here.
 */

import type { AgentDbgConfig, AgentDbgEvent, RunCounts } from "@agentdbg/core";
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
  config: AgentDbgConfig;
  counts: RunCounts;
  eventWindow: AgentDbgEvent[];
  loopEmitted: Set<string>;
  pendingLlm: PendingLlmCall | null;
  pendingTools: Map<string, PendingToolCall>;
  toolCallSeq: number;
}
