## What is it

`@maida-ai/opencode` is an OpenCode plugin that records your OpenCode sessions as Maida OTel-style traces. It writes `meta.json` and `spans.jsonl` under:

`~/.maida/runs/<trace_id>/`

This plugin maps OpenCode session, message, and tool lifecycle events into the structural trace format consumed by the main Maida tooling at `github.com/maida-ai/maida.git`.

## How to use it

### Install

Add `@maida-ai/opencode` to your project's `package.json` dependencies:

```bash
npm install @maida-ai/opencode
```

OpenCode automatically installs npm plugins from the project `node_modules/` at startup.

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

This plugin writes the **current OTel-style trace format (`spec_version` `0.2`)** through the `@maida-ai/core` storage API, so the on-disk contract, redaction, and validation stay in sync with the main Maida tooling. It does not implement its own writer.

On-disk layout for each run:

```
~/.maida/runs/<trace_id>/
  meta.json     # run metadata
  spans.jsonl   # one JSON span per line
```

- **`meta.json`** — `spec_version`, `trace_id` (32 hex chars), `run_name`, `started_at`, `ended_at`, `duration_ms`, `status` (`running` | `ok` | `error`), and `counts`.
- **`spans.jsonl`** — append-only spans. Each span carries `spec_version`, `trace_id`, `span_id` (16 hex chars), `parent_span_id`, `name`, `kind`, `start_time`, `end_time`, `duration_ms`, `attributes`, `events`, `status_code` (`OK` | `ERROR` | `UNSET`), and `status_description`. Spans nest under a single run-root span whose `span_id` is the first 16 hex chars of the `trace_id` (`parent_span_id: null`); the run is closed by writing that root span with the run summary.

Attribute conventions follow the core mapping: LLM turns use `gen_ai.*` attributes, tool calls use `maida.tool_name` with `maida.tool.args` / `maida.tool.result` events, errors set `status_code: "ERROR"` with `maida.error_*` attributes, and loop warnings carry a `maida.loop.warning` event. **Redaction and truncation** (`redact_keys`, `max_field_bytes`) are applied to every attribute and event payload before anything is written to disk.

Compatibility notes:

- Requires `@maida-ai/core` `^0.4.0`; the plugin emits the current format only.
- The legacy `run.json` + `events.jsonl` layout (`spec_version` `0.1`) is no longer written. As of the v0.4.x hardening, `0.2` is the earliest fully supported format — re-record older sessions rather than relying on them.
- External tooling should read `spec_version` from `meta.json` to detect the format and validate runs with core's `loadValidatedRun`, which fails with a clear message on unsupported or malformed runs.

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

### Notes

- Maida storage location follows Maida config: `MAIDA_DATA_DIR` if set, or `~/.maida` by default.
- If you want to disable recording without removing the plugin, set `MAIDA_ENABLED=0`.
- This plugin is local-first. By default it only writes run data locally for the main Maida tooling to consume.
