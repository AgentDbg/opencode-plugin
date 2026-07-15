import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEMO_FINAL_ANSWER,
  parseDemoMode,
  runCodingAgentDemo,
} from "../src/coding-agent-demo.js";

const tempDirs: string[] = [];

function demoDir(): string {
  const dir = join(tmpdir(), `maida-opencode-demo-test-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("coding-agent regression demo", () => {
  it("keeps the final answer fixed while exposing the structural regression", async () => {
    const good = await runCodingAgentDemo({ mode: "good", dataDir: demoDir() });
    const regression = await runCodingAgentDemo({
      mode: "regression",
      dataDir: demoDir(),
    });

    expect(good.finalAnswer).toBe(DEMO_FINAL_ANSWER);
    expect(regression.finalAnswer).toBe(DEMO_FINAL_ANSWER);
    expect(good.counts).toMatchObject({ tool_calls: 3, loop_warnings: 0 });
    expect(regression.counts).toMatchObject({ tool_calls: 5, loop_warnings: 1 });
    expect(regression.testCommands).toEqual([
      "npm test",
      "npm test",
      "npm test",
    ]);
  });

  it("uses the real plugin trace path and redacts secrets before persistence", async () => {
    const secret = "sk-demo-must-not-leak";
    const result = await runCodingAgentDemo({
      mode: "regression",
      dataDir: demoDir(),
      secret,
    });

    expect(result.run.meta.status).toBe("ok");
    expect(result.run.meta.trace_id).toBe(result.traceId);
    expect(result.run.spans.some((span) => span.parent_span_id === null)).toBe(true);

    const rawTrace = readFileSync(join(result.runDir, "spans.jsonl"), "utf-8");
    expect(rawTrace).not.toContain(secret);
    expect(rawTrace).toContain("__REDACTED__");
    expect(rawTrace).toContain("maida.loop.warning");
  });

  it("rejects unsupported modes with an actionable error", () => {
    expect(() => parseDemoMode("broken")).toThrow(
      "--mode must be good or regression",
    );
  });
});
