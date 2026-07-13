import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadValidatedRun, type ValidatedRun } from "@maida-ai/core";

const fixturesRoot = fileURLToPath(new URL("./fixtures/traces/", import.meta.url));
const tempDataDirs: string[] = [];

type FixtureKind = "current" | "malformed";

interface FixtureMeta {
  spec_version: string;
  trace_id: string;
  status: string;
  counts: {
    llm_calls: number;
    tool_calls: number;
    errors: number;
    loop_warnings: number;
  };
}

function fixtureDir(kind: FixtureKind, name: string): string {
  return join(fixturesRoot, kind, name);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function readFixtureMeta(dir: string): FixtureMeta {
  return readJsonFile<FixtureMeta>(join(dir, "meta.json"));
}

function readRawFixtureSpans(dir: string): Record<string, unknown>[] {
  return readFileSync(join(dir, "spans.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function materializeFixture(kind: FixtureKind, name: string): {
  dataDir: string;
  fixturePath: string;
  traceId: string;
} {
  const sourceDir = fixtureDir(kind, name);
  const meta = readFixtureMeta(sourceDir);
  const dataDir = mkdtempSync(join(tmpdir(), "maida-opencode-fixture-"));
  const runDir = join(dataDir, "runs", meta.trace_id);

  mkdirSync(runDir, { recursive: true });
  cpSync(join(sourceDir, "meta.json"), join(runDir, "meta.json"));
  cpSync(join(sourceDir, "spans.jsonl"), join(runDir, "spans.jsonl"));
  tempDataDirs.push(dataDir);

  return { dataDir, fixturePath: sourceDir, traceId: meta.trace_id };
}

function loadFixture(kind: FixtureKind, name: string): {
  fixturePath: string;
  traceId: string;
  run: ValidatedRun;
} {
  const { dataDir, fixturePath, traceId } = materializeFixture(kind, name);
  return {
    fixturePath,
    traceId,
    run: loadValidatedRun(traceId, { data_dir: dataDir }),
  };
}

function attrs(span: { attributes?: unknown }): Record<string, unknown> {
  return (span.attributes ?? {}) as Record<string, unknown>;
}

function eventAttrs(
  span: { events?: unknown },
  eventName: string,
): Record<string, unknown> {
  const events = (span.events ?? []) as Record<string, unknown>[];
  const event = events.find((candidate) => candidate.name === eventName);
  return (event?.attributes ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tempDataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cross-repo trace fixtures", () => {
  const validFixtures = [
    ["normal", "70000000000000000000000000000001"],
    ["tool-loop", "70000000000000000000000000000002"],
    ["missing-terminal-state", "70000000000000000000000000000003"],
  ] as const;

  it("keeps valid fixture files documented and aligned with the public contract", () => {
    for (const [name, traceId] of validFixtures) {
      const dir = fixtureDir("current", name);
      expect(existsSync(join(dir, "README.md"))).toBe(true);
      expect(existsSync(join(dir, "meta.json"))).toBe(true);
      expect(existsSync(join(dir, "spans.jsonl"))).toBe(true);

      const meta = readFixtureMeta(dir);
      expect(meta.spec_version).toBe("0.2");
      expect(meta.trace_id).toBe(traceId);

      for (const span of readRawFixtureSpans(dir)) {
        expect(span.trace_id).toBe(traceId);
        expect(span).not.toHaveProperty("spec_version");
      }
    }
  });

  it("validates the normal plugin session fixture", () => {
    const { run, traceId } = loadFixture("current", "normal");
    const { meta, spans } = run;

    expect(meta.trace_id).toBe(traceId);
    expect(meta.status).toBe("ok");
    expect(meta.counts).toEqual({
      llm_calls: 1,
      tool_calls: 1,
      errors: 0,
      loop_warnings: 0,
    });

    const root = spans.find((span) => span.parent_span_id === null);
    expect(root?.span_id).toBe(traceId.slice(0, 16));
    expect(attrs(root ?? {})["maida.status"]).toBe("ok");

    const llm = spans.find((span) => "gen_ai.operation.name" in attrs(span));
    expect(llm?.name).toBe("unknown");
    expect(eventAttrs(llm ?? {}, "gen_ai.assistant.message").content).toContain(
      "inspect the project",
    );

    const tool = spans.find((span) => attrs(span)["maida.tool_name"] === "bash");
    expect(tool?.status_code).toBe("OK");
    expect(eventAttrs(tool ?? {}, "maida.tool.args").args).toBe(
      "{\"command\":\"npm test\"}",
    );
  });

  it("validates the tool-loop fixture expectations", () => {
    const { run } = loadFixture("current", "tool-loop");
    const { meta, spans } = run;

    expect(meta.status).toBe("ok");
    expect(meta.counts).toEqual({
      llm_calls: 0,
      tool_calls: 3,
      errors: 0,
      loop_warnings: 1,
    });

    const toolSpans = spans.filter((span) => attrs(span)["maida.tool_name"] === "search");
    expect(toolSpans).toHaveLength(3);
    expect(toolSpans.map((span) => eventAttrs(span, "maida.tool.args").args)).toEqual([
      "{\"query\":\"same query\"}",
      "{\"query\":\"same query\"}",
      "{\"query\":\"same query\"}",
    ]);

    const warning = spans.find((span) => attrs(span)["maida.event_type"] === "LOOP_WARNING");
    expect(warning?.name).toBe("loop_warning");
    expect(eventAttrs(warning ?? {}, "maida.loop.warning")).toMatchObject({
      pattern: "TOOL_CALL:search",
      repetitions: 3,
    });
  });

  it("accepts the missing-terminal-state fixture as a running trace", () => {
    const { run } = loadFixture("current", "missing-terminal-state");
    const { meta, spans } = run;

    expect(meta.status).toBe("running");
    expect(meta.ended_at).toBeNull();
    expect(meta.duration_ms).toBeNull();
    expect(meta.counts).toEqual({
      llm_calls: 1,
      tool_calls: 0,
      errors: 0,
      loop_warnings: 0,
    });
    expect(spans.filter((span) => span.parent_span_id === null)).toHaveLength(0);
  });

  it("rejects the malformed fixture with a clear validation error", () => {
    const dir = fixtureDir("malformed", "invalid-span-id");
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    const { dataDir, traceId } = materializeFixture("malformed", "invalid-span-id");

    expect(() => loadValidatedRun(traceId, { data_dir: dataDir })).toThrow(
      /spans\.jsonl line 1 has invalid span_id/,
    );
  });
});
