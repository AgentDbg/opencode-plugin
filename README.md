## What is it

`@maida-ai/opencode` is an OpenCode plugin that records your OpenCode sessions as Maida v0.1 traces. It writes `run.json` and `events.jsonl` under:

`~/.maida/runs/<run_id>/`

This plugin maps OpenCode session, message, and tool lifecycle events into the structural trace format consumed by the main Maida tooling at `github.com/maida-ai/maida.git`.

## How to use it

### Install

Add `@maida-ai/opencode` to your project's `package.json` dependencies:

```bash
npm install @maida-ai/opencode
```

OpenCode automatically installs npm plugins from the project `node_modules/` at startup.

### OpenCode -> Maida mapping (v1)

This plugin records the following OpenCode events into Maida trace events:

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
