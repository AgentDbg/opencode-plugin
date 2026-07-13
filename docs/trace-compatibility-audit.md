# OpenCode Plugin Trace Compatibility Audit

Audit date: 2026-07-09

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
reader. It does not yet prove long-term cross-repo fixture conformance.

## Stale Or Risky Docs And Examples

- There are no standalone examples or fixture files in this repository. The
  README `opencode.json` snippet is the only public usage example found.
- The README says each span carries `spec_version`. Current Python Maida public
  trace-format docs say `spec_version` is declared in `meta.json` and does not
  repeat on individual `spans.jsonl` records. The Python validator currently
  tolerates the extra span key, so this is a contract/documentation drift, not
  an observed load failure.
- `tests/hooks.test.ts` also asserts `span.spec_version === "0.2"`, so any
  decision to align with the Python public contract should update tests
  alongside docs and output behavior.

## Followups

- https://github.com/maida-ai/opencode-plugin/issues/6 - decide whether the
  plugin should remove tolerated span-level `spec_version`, update README
  wording, or document the current TS-core behavior as an allowed extension.
- https://github.com/maida-ai/opencode-plugin/issues/7 - add cross-repo
  conformance fixtures so plugin output is validated against Python Maida in
  CI rather than only by ad hoc audit smokes.
