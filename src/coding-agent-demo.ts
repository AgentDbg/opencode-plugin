/** Deterministic, offline coding-agent replay for demonstrating structural regressions. */

import {
  loadConfig,
  loadValidatedRun,
  type MaidaConfig,
  type RunCounts,
  type ValidatedRun,
} from "@maida-ai/core";
import type { Event } from "@opencode-ai/sdk";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildHookMap } from "./hooks.js";
import { clearAllSessions } from "./session.js";

export type DemoMode = "good" | "regression";

export const DEMO_FINAL_ANSWER =
  "Refactor complete. The existing behavior is preserved and the test suite passes.";

const DEFAULT_DEMO_SECRET = "sk-demo-local-secret";

export interface CodingAgentDemoOptions {
  mode: DemoMode;
  dataDir: string;
  secret?: string;
}

export interface CodingAgentDemoResult {
  mode: DemoMode;
  dataDir: string;
  runDir: string;
  traceId: string;
  finalAnswer: string;
  counts: RunCounts;
  testCommands: string[];
  run: ValidatedRun;
}

interface ToolStep {
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
}

function demoConfig(dataDir: string): MaidaConfig {
  const base = loadConfig();
  return {
    ...base,
    data_dir: dataDir,
    enabled: true,
    redact: true,
    redact_keys: Array.from(
      new Set([...base.redact_keys, "api_key", "secret", "token"]),
    ),
    loop_window: Math.max(10, base.loop_window),
    loop_repetitions: 3,
  };
}

export function parseDemoMode(value: string | undefined): DemoMode {
  if (value === "good" || value === "regression") return value;
  throw new Error("--mode must be good or regression");
}

function toolSteps(mode: DemoMode, secret: string): ToolStep[] {
  const shared: ToolStep[] = [
    {
      tool: "read",
      input: { filePath: "src/refactor-target.ts" },
      output: "export function normalize(value: string) { return value.trim(); }",
    },
    {
      tool: "edit",
      input: { filePath: "src/refactor-target.ts", change: "extract helper" },
      output: "Done",
    },
  ];
  const test: ToolStep = {
    tool: "bash",
    input: { command: "npm test", env: { api_key: secret } },
    output: { status: "passed", token: secret },
  };
  return [...shared, ...Array.from({ length: mode === "good" ? 1 : 3 }, () => test)];
}

function sessionInfo(id: string) {
  const now = Date.now();
  return {
    id,
    projectID: "maida-coding-agent-demo",
    directory: "/tmp/maida-coding-agent-demo",
    title: "Offline coding-agent refactor",
    version: "1",
    time: { created: now, updated: now },
  };
}

async function replayEvent(
  eventHook: (input: { event: Event }) => Promise<void>,
  type: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await eventHook({ event: { type, properties } as never });
}

function toolCommands(run: ValidatedRun): string[] {
  const commands: string[] = [];
  for (const span of run.spans) {
    if (span.attributes["maida.tool_name"] !== "bash") continue;
    const argsEvent = span.events.find((event) => event.name === "maida.tool.args");
    const rawArgs = argsEvent?.attributes.args;
    if (typeof rawArgs !== "string") continue;
    const args = JSON.parse(rawArgs) as { command?: unknown };
    if (typeof args.command === "string") commands.push(args.command);
  }
  return commands;
}

export async function runCodingAgentDemo(
  options: CodingAgentDemoOptions,
): Promise<CodingAgentDemoResult> {
  mkdirSync(options.dataDir, { recursive: true });
  clearAllSessions();
  const hooks = buildHookMap(demoConfig(options.dataDir));
  if (!hooks.event) throw new Error("OpenCode event hook is unavailable");

  const id = `coding-agent-${options.mode}`;
  const info = sessionInfo(id);
  const secret = options.secret ?? DEFAULT_DEMO_SECRET;

  await replayEvent(hooks.event, "session.created", { info });
  for (const [index, step] of toolSteps(options.mode, secret).entries()) {
    const callID = `call-${index + 1}`;
    const common = {
      id: `part-${index + 1}`,
      sessionID: id,
      messageID: "tools",
      type: "tool",
      callID,
      tool: step.tool,
    };
    await replayEvent(hooks.event, "message.part.updated", {
      part: { ...common, state: { status: "pending", input: step.input } },
    });
    await replayEvent(hooks.event, "message.part.updated", {
      part: {
        ...common,
        state: { status: "completed", input: step.input, output: step.output },
      },
    });
  }

  await replayEvent(hooks.event, "message.part.updated", {
    part: {
      id: "final-answer",
      sessionID: id,
      messageID: "final-answer",
      type: "text",
      text: DEMO_FINAL_ANSWER,
    },
    delta: DEMO_FINAL_ANSWER,
  });
  await replayEvent(hooks.event, "session.deleted", { info });

  const runIds = readdirSync(join(options.dataDir, "runs"));
  if (runIds.length !== 1) {
    throw new Error(`expected one demo trace, found ${runIds.length}`);
  }
  const traceId = runIds[0];
  const runDir = join(options.dataDir, "runs", traceId);
  const run = loadValidatedRun(traceId, { data_dir: options.dataDir });
  clearAllSessions();

  return {
    mode: options.mode,
    dataDir: options.dataDir,
    runDir,
    traceId,
    finalAnswer: DEMO_FINAL_ANSWER,
    counts: run.meta.counts,
    testCommands: toolCommands(run),
    run,
  };
}

function cliValue(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const mode = parseDemoMode(cliValue(process.argv.slice(2), "--mode"));
  const requestedDataDir = cliValue(process.argv.slice(2), "--data-dir");
  const dataDir = requestedDataDir
    ? resolve(process.cwd(), requestedDataDir)
    : mkdtempSync(join(tmpdir(), "maida-opencode-demo-"));
  const result = await runCodingAgentDemo({ mode, dataDir });

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: result.mode,
        final_answer: result.finalAnswer,
        trace_id: result.traceId,
        trace_dir: result.runDir,
        counts: result.counts,
        test_commands: result.testCommands,
      },
      null,
      2,
    )}\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`coding-agent demo failed: ${message}\n`);
    process.exitCode = 2;
  });
}
