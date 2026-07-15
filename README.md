## What is it

`@maida-ai/opencode` is an OpenCode plugin that records your OpenCode sessions as Maida OTel-style traces. It writes `meta.json` and `spans.jsonl` under:

`~/.maida/runs/<trace_id>/`

This plugin maps OpenCode session, message, and tool lifecycle events into the structural trace format consumed by the main Python Maida package and CLI (`maida-ai` / `maida`) at `github.com/maida-ai/maida.git`. The Python package is the public trace-format source of truth; this plugin is the OpenCode adapter that records local traces for that tooling to read.

## How to use it

### Install

Add `@maida-ai/opencode` to your project's `package.json` dependencies:

```bash
npm install @maida-ai/opencode
```

OpenCode automatically installs npm plugins from the project `node_modules/` at startup.

### Add the Maida coding-agent skills

The plugin records OpenCode sessions. The complementary, portable skills in
[`maida-ai/skills`](https://github.com/maida-ai/skills) guide a coding agent
through the rest of the local Maida workflow:

| Skill | Use it to |
|---|---|
| `maida-instrument-agent` | Inspect an agent repository, choose the supported Maida integration, and verify a local trace. |
| `maida-add-regression-gate` | Add policy, baseline, and GitHub gate files with reviewable local changes. |
| `maida-debug-gate` | Reproduce a failing gate, trace the structural change to source, and decide whether it is a regression. |

Install the canonical skills globally for OpenCode from a checkout of the
skills repository:

```bash
./scripts/install-skills --target opencode product
```

Or install them only for the current project:

```bash
./scripts/install-skills --dest /path/to/project/.opencode/skills product
```

Then ask OpenCode to use a skill explicitly, for example:

```text
Use maida-instrument-agent to instrument this agent repository with Maida.
```

OpenCode discovers these standard `SKILL.md` directories; this plugin does not
copy or vendor their instructions. Updating the `maida-ai/skills` checkout and
re-running its installer keeps the single canonical skill definitions in use.
The skills inspect before editing and do not commit, push, upload traces, or use
cloud services without explicit authorization.

### OpenCode -> Maida mapping

This plugin records the following OpenCode events into Maida spans that project back to Maida trace events:

| OpenCode event | Maida event | Notes |
|---|---|---|
| `session.created` | `RUN_START` | Creates a run when a new session is created |
| `message.updated` | `RUN_START` | Fallback for resumed sessions when the plugin attaches late |
| `session.idle` | flush only | Flushes any pending streamed assistant text as an `LLM_CALL` |
| `session.deleted` | `RUN_END(status="ok")` | Flushes pending LLM calls first, then finalizes the run |
| `session.error` | `ERROR` + `RUN_END(status="error")` | Emits an `ERROR` event from the session error, then finalizes |
| `server.instance.disposed` | `RUN_END(ok)` for all sessions | Fires when OpenCode closes and ensures all runs are finalized |
| `message.part.updated` (type: `text`) | `LLM_CALL` | Uses flush-on-next-message so each assistant turn becomes one `LLM_CALL` |
| `message.part.updated` (type: `tool`) | `TOOL_CALL` | Records tool calls from OpenCode's streaming event format |
| Loop detected (algorithmic) | `LOOP_WARNING` | Deduplicates by `pattern + repetitions` via Maida loop detection |

### Storage contract & compatibility

This plugin writes the **current OTel-style trace format (`spec_version` `0.2`)** through the `@maida-ai/core` storage API. `@maida-ai/core` is the TypeScript write-side mirror used by this adapter; the main Python Maida package remains the source of truth for the public on-disk contract. The plugin does not vendor the Python package or implement a second storage writer.

On-disk layout for each run:

```
~/.maida/runs/<trace_id>/
  meta.json     # run metadata
  spans.jsonl   # one JSON span per line
```

- **`meta.json`** — declares the public storage contract with `spec_version`, plus `trace_id` (32 hex chars), `run_name`, `started_at`, `ended_at`, `duration_ms`, `status` (`running` | `ok` | `error`), and `counts`.
- **`spans.jsonl`** — append-only spans. Public span records include `trace_id`, `span_id` (16 hex chars), `parent_span_id`, `name`, `kind`, `start_time`, `end_time`, `duration_ms`, `attributes`, `events`, `status_code` (`OK` | `ERROR` | `UNSET`), and `status_description`. Span-level `spec_version` is not required by the public contract; current `@maida-ai/core` may include it as a tolerated additive field, and readers should ignore unknown span keys. Spans nest under a single run-root span whose `span_id` is the first 16 hex chars of the `trace_id` (`parent_span_id: null`); the run is closed by writing that root span with the run summary.

Attribute conventions follow the core mapping: LLM turns use `gen_ai.*` attributes, tool calls use `maida.tool_name` with `maida.tool.args` / `maida.tool.result` events, errors set `status_code: "ERROR"` with `maida.error_*` attributes, and loop warnings carry a `maida.loop.warning` event. **Redaction and truncation** (`redact_keys`, `max_field_bytes`) are applied to every attribute and event payload before anything is written to disk.

Compatibility notes:

- Requires `@maida-ai/core` `^0.4.0`; the plugin emits the current format only.
- The legacy `run.json` + `events.jsonl` layout (`spec_version` `0.1`) is no longer written. As of the v0.4.x hardening, `0.2` is the earliest fully supported format — re-record older sessions rather than relying on them.
- External tooling should read `spec_version` from `meta.json` to detect the format and validate runs with Python Maida's reader or `@maida-ai/core`'s `loadValidatedRun`, which fails with a clear message on unsupported or malformed runs.
- The repository includes contract-correct fixture traces under `tests/fixtures/traces/`. Those fixtures omit span-level `spec_version` intentionally and can be copied under `<data_dir>/runs/<trace_id>/` for cross-repo conformance tests.

### Enable in OpenCode

OpenCode loads plugins either from plugin directories or from npm packages via config.

Example `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@maida-ai/opencode"]
}
```

Restart OpenCode after updating the config.

### View traces

Run OpenCode normally. After a session completes, use the main Maida CLI to inspect or compare the generated traces.

### Offline coding-agent regression demo

Replay a deterministic coding-agent refactor through the real plugin hooks. It
does not run the displayed tool commands, call a model, require an API key, or
use the network:

```bash
npm run demo:coding-agent -- --mode good
npm run demo:coding-agent -- --mode regression
```

Both modes return the same successful final answer. The good trace inspects,
edits, and tests once. The regression trace runs the identical `npm test` tool
call three times, so its structural summary grows from three to five tool calls
and includes a loop warning. The JSON output includes the isolated temporary
trace directory for local inspection with Maida. Pass
`--data-dir ./some-directory` when you want to control that location.

### Notes

- Maida storage location follows Maida config: `MAIDA_DATA_DIR` if set, or `~/.maida` by default.
- If you want to disable recording without removing the plugin, set `MAIDA_ENABLED=0`.
- This plugin is local-first and optional. By default it only writes redacted run data locally for the main Maida tooling to consume; it does not upload traces or make OpenCode usage mandatory for Maida.
