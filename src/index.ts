/**
 * @maida-ai/opencode — Maida plugin for OpenCode.
 *
 * Records OpenCode sessions as Maida traces (run.json + events.jsonl)
 * under ~/.maida/runs/<run_id>/ so they can be consumed by the main
 * Python Maida tooling.
 */

import { loadConfig } from "@maida-ai/core";
import type { Plugin } from "@opencode-ai/plugin";

import { buildHookMap } from "./hooks.js";

export const MaidaPlugin: Plugin = async (_ctx) => {
  const config = loadConfig();
  if (!config.enabled) return {};
  return buildHookMap(config);
};

export default MaidaPlugin;
