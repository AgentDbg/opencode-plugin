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
  getAllSessions,
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
      if (!getSession(info.id)) {
        initSession(info.id, config);
      }
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
    case "server.instance.disposed": {
      for (const [sessionId, state] of getAllSessions()) {
        flushPendingLlm(state);
        endSession(state, "ok");
        removeSession(sessionId);
      }
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
    case "message.updated": {
      const info = event.properties.info;
      if (!info?.sessionID) return;
      const state = getSession(info.sessionID);
      if (state) return;
      initSession(info.sessionID, config);
      break;
    }
    case "message.part.updated": {
      const part = event.properties.part;
      if (!part) return;
      const sessionID = part.sessionID;
      if (!sessionID) return;
      let state = getSession(sessionID);
      if (!state) {
        initSession(sessionID, config);
        state = getSession(sessionID);
      }
      if (!state) return;

      if (part.type === "tool") {
        const callID = (part as { callID?: string }).callID;
        const tool = (part as { tool?: string }).tool;
        const toolState = (part as { state?: { status?: string; input?: unknown; output?: string; title?: string } }).state;

        if (toolState?.status === "pending" && callID && tool) {
          startToolCall(state, tool, callID, (toolState.input as Record<string, unknown>) ?? {});
        } else if (toolState?.status === "completed" && callID) {
          finishToolCall(state, callID, toolState.output ?? "", null);
        }
        return;
      }

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
  };
}
