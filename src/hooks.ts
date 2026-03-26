/**
 * Hook handlers that map OpenCode lifecycle events into AgentDbg events.
 *
 * Every handler is wrapped in try/catch so the plugin never crashes OpenCode.
 * Types are derived from @opencode-ai/plugin SDK (v1.3.x).
 */

import type { AgentDbgConfig } from "@agentdbg/core";
import type { Event } from "@opencode-ai/sdk";

import {
  accumulateLlmPart,
  emitError,
  endSession,
  finishToolCall,
  flushPendingLlm,
  getSession,
  initSession,
  removeSession,
  startToolCall,
} from "./session.js";
import type { OcHooks } from "./types.js";

// ---------------------------------------------------------------------------
// Safe wrapper — catch all errors so the plugin never crashes OpenCode
// ---------------------------------------------------------------------------

function safeAsync<A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch {
      // never crash OpenCode
    }
  };
}

// ---------------------------------------------------------------------------
// Event dispatcher (session.*, message.*)
// ---------------------------------------------------------------------------

function handleEvent(config: AgentDbgConfig, event: Event): void {
  switch (event.type) {
    case "session.created": {
      const info = event.properties.info;
      if (!info?.id) return;
      initSession(info.id, config);
      break;
    }
    case "session.deleted": {
      const info = event.properties.info;
      if (!info?.id) return;
      const state = getSession(info.id);
      if (!state) return;
      flushPendingLlm(state);
      endSession(state, "ok");
      removeSession(info.id);
      break;
    }
    case "session.error": {
      const sessionID = event.properties.sessionID;
      if (!sessionID) return;
      const state = getSession(sessionID);
      if (!state) return;
      flushPendingLlm(state);
      const err = event.properties.error;
      const errMsg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message?: unknown }).message)
          : "unknown error";
      emitError(state, errMsg);
      endSession(state, "error");
      removeSession(sessionID);
      break;
    }
    case "session.idle": {
      const sessionID = event.properties.sessionID;
      if (!sessionID) return;
      const state = getSession(sessionID);
      if (!state) return;
      flushPendingLlm(state);
      break;
    }
    case "message.part.updated": {
      const part = event.properties.part;
      if (!part) return;
      const sessionID = part.sessionID;
      if (!sessionID) return;
      const state = getSession(sessionID);
      if (!state) return;

      if (part.type !== "text") return;

      const delta = event.properties.delta;
      const text = typeof delta === "string" ? delta : ("text" in part ? (part as { text?: string }).text ?? "" : "");
      if (!text) return;

      const messageId = part.messageID ?? "unknown";
      accumulateLlmPart(state, messageId, text, "unknown");
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Build hook map (matches @opencode-ai/plugin Hooks interface)
// ---------------------------------------------------------------------------

export function buildHookMap(config: AgentDbgConfig): OcHooks {
  return {
    event: safeAsync(({ event }: { event: Event }) => {
      handleEvent(config, event);
    }),

    "tool.execute.before": safeAsync(
      (
        input: { tool: string; sessionID: string; callID: string },
        output: { args: unknown },
      ) => {
        const state = getSession(input.sessionID);
        if (!state) return;
        const args =
          output.args != null && typeof output.args === "object" && !Array.isArray(output.args)
            ? (output.args as Record<string, unknown>)
            : {};
        startToolCall(state, input.tool, input.callID, args);
      },
    ),

    "tool.execute.after": safeAsync(
      (
        input: { tool: string; sessionID: string; callID: string; args: unknown },
        output: { title: string; output: string; metadata: unknown },
      ) => {
        const state = getSession(input.sessionID);
        if (!state) return;
        finishToolCall(state, input.callID, output.output, null);
      },
    ),
  };
}
