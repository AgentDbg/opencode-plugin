/**
 * @agentdbg/opencode — AgentDbg plugin for OpenCode.
 *
 * Records OpenCode sessions as AgentDbg traces (run.json + events.jsonl)
 * under ~/.agentdbg/runs/<run_id>/ so they appear alongside Python agent
 * runs in `agentdbg view`.
 */

import { loadConfig } from "@agentdbg/core";
import type { Plugin } from "@opencode-ai/plugin";

import { buildHookMap } from "./hooks.js";

export const AgentDbgPlugin: Plugin = async (_ctx) => {
  const config = loadConfig();
  if (!config.enabled) return {};
  return buildHookMap(config);
};

export default AgentDbgPlugin;
