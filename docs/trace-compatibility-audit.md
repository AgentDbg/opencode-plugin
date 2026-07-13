# OpenCode Plugin Trace Compatibility Audit

Audit date: 2026-07-09

Status updated: 2026-07-12

Scope: maida-ai/opencode-plugin#5. This is an audit of the current plugin
trace output and documentation; it does not change trace writing behavior.

## Current Output Files

The plugin writes local Maida trace data under the configured Maida data
directory:

```text
<data_dir>/runs/<trace_id>/
  meta.json
  spans.jsonl
```

`<data_dir>` comes from `MAIDA_DATA_DIR` when set, otherwise the Maida default
local storage directory. The plugin does not upload traces.

Current source and tests show:

- `src/session.ts` delegates storage to `@maida-ai/core` via `createRun`,
  `appendSpan`, `appendEvent`, and `finalizeRun`.
- `package-lock.json` resolves `@maida-ai/core` to `0.4.0`.
- `meta.json` is written with `spec_version: "0.2"`, a 32-hex `trace_id`,
  status, timing, and counts.
- `spans.jsonl` contains one JSON span per line for LLM calls, tool calls,
  errors, loop warnings, and the run-root summary span.
- Legacy `run.json` and `events.jsonl` are not expected for newly recorded
  plugin traces; tests assert they are absent.

## Current Maida Compatibility

Compatibility is verified for the current checked-out plugin output against
the adjacent Python Maida checkout:

- A synthetic plugin run was recorded to a temporary `MAIDA_DATA_DIR`.
- Python Maida loaded it with `load_validated_run()`.
- Python Maida projected it with `load_run_for_analysis()`.
- The loaded run reported `spec_version: "0.2"`, status `ok`, three spans, and
  projected events `RUN_START`, `LLM_CALL`, `TOOL_CALL`, and `RUN_END`.

This verifies that the current output is accepted by the current Python Maida
reader.

## Cross-Repo Conformance Fixtures

The repository now includes conformance traces under `tests/fixtures/traces/`
for a normal run, a repeated-tool loop, a run with no terminal state, and a
malformed trace. `tests/fixtures.test.ts` checks the expected structure with
the TypeScript reader, including rejection of the malformed trace. The three
valid fixtures also load with Python Maida's `load_validated_run()` and project
through `load_run_for_analysis()`.

The fixtures declare `spec_version` in `meta.json` and intentionally omit it
from individual spans. This matches the public Python storage contract and
exercises compatibility independently of tolerated additive fields emitted by
the current TypeScript core.

## Documentation Findings Resolved

- The README identifies the Python package as the public trace-format source
  of truth and the plugin as its OpenCode adapter.
- The README documents that `spec_version` belongs in `meta.json`; span-level
  copies from the TypeScript core are tolerated additive fields rather than
  part of the public contract.
- The README links the conformance fixtures and documents their placement.
- The local-first and redaction guarantees are documented, and raw-storage
  tests verify that sensitive tool payloads are redacted.

The implementation followups from the original audit are complete:

- https://github.com/maida-ai/opencode-plugin/issues/6 updated the writer and
  compatibility documentation.
- https://github.com/maida-ai/opencode-plugin/issues/7 added the conformance
  fixtures and their tests.
