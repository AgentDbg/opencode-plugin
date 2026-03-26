## What is it

`@agentdbg/opencode` is an OpenCode plugin that records your OpenCode sessions as **AgentDbg v0.1 traces**. It writes `run.json` and `events.jsonl` under:

`~/.agentdbg/runs/<run_id>/`

So you can open the timeline with:

`agentdbg view`

This plugin focuses on mapping OpenCode session/message/tool lifecycle events into AgentDbg’s event schema (LLM calls, tool calls, errors, and loop warnings).

## How to use it

### Install

```bash
npm install -g @agentdbg/opencode
```

### OpenCode → AgentDbg mapping (v1)

This plugin records the following OpenCode events into AgentDbg trace events:

| OpenCode hook/event | AgentDbg event | Notes |
|---|---|---|
| `session.created` | `RUN_START` | Creates `run.json` and the `events.jsonl` for the run |
| `session.idle` | (flush only) | Flushes any pending streamed assistant text as an `LLM_CALL` |
| `session.deleted` | `RUN_END(status="ok")` | Flushes pending LLM calls first, then finalizes the run |
| `session.error` | `ERROR` + `RUN_END(status="error")` | Emits an `ERROR` event from the session error, then finalizes |
| `message.part.updated` (text parts) | `LLM_CALL` | Uses “flush-on-next-message” so each assistant turn becomes one `LLM_CALL` |
| `tool.execute.before` + `tool.execute.after` | `TOOL_CALL` | Emits timing-based tool calls (duration in `duration_ms`) |
| Loop detected (algorithmic) | `LOOP_WARNING` | Dedupe by `pattern + repetitions` via AgentDbg loop detection |

### Enable in OpenCode

OpenCode loads plugins either from the plugin directories or from npm packages via config.

Example `opencode.json` (project or user config):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@agentdbg/opencode"]
}
```

Restart OpenCode after updating the config.

### View traces

Run OpenCode normally. After a session completes, start the viewer:

```bash
agentdbg view
```

Your OpenCode runs should appear alongside any Python AgentDbg runs.

### Notes

- AgentDbg storage location follows AgentDbg config: `AGENTDBG_DATA_DIR` (if set) or `~/.agentdbg` by default.
- If you want to disable recording without removing the plugin, set `AGENTDBG_ENABLED=0`.

