# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Context window usage
  - Reports pi's real context occupancy (`get_session_stats` → `contextUsage`) to the client as ACP `usage_update` after each turn, on `session/new` and `session/load`, and after a model switch
  - Requires a pi version whose `get_session_stats` response includes `contextUsage`; otherwise no usage is reported
  - Right after compaction pi may not have a trustworthy token count yet, so the client keeps the previous value until the next model response
- Skills are loaded by pi directly and are available in ACP sessions
- (Zed) `pi-acp` emits “startup info” block into the session (pi version, context, skills, prompts, extensions - similar to `pi` in the terminal). You can disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). When `quietStartup` is enabled, `pi-acp` will still emit a 'New version available' message if the installed pi version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 22+
- `pi` v0.81.0+ installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it:

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version):

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Environment variables

- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client.
- Default: unset/any other value means `false`.
- When disabled, compliant ACP clients should avoid sending embedded `resource` blocks. If they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.

You can add the environment variable in the Zed settings with:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {
          "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - pats to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - not implemented (use the model selector UI in Zed)
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

**Note**: Slash commands provided by pi extensions are not currently supported.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Experimental ACP v2

Set `PI_ACP_PROTOCOL_V2=1` and point `PI_ACP_PI_COMMAND` to a Pi build
with [native keyed prompt receipts](https://github.com/nymph-ai/pi/commit/80f9079a6251da66adae5d8c4d7b0df9372327fb).
The experimental router accepts ACP v1 and v2. Ordinary installations default
to v1.

The v2 session methods cover create, list, resume, close, prompt, cancel, and
updates. Prompts acknowledge native insertion and support
`session/prompt.idempotencyKey`. The v2 initialize response advertises
`_meta["nymph.ai/fabric"].keyedTextPrompts`. Resuming with `replayFrom: { "type": "start" }`
replays retained messages from the native session branch using the original
keyed IDs. Assistant text is delivered as a whole message when Pi records it.
Live updates and replay project retained assistant tool calls and their native
results. The ACP tool ID names the native assistant entry and block position.
The provider ID is available in `_meta["nymph.ai/fabric"].nativeToolCallId`.
A call is pending until its retained result supplies success or failure. Pi
does not record a separate per-tool cancellation outcome in these entries.

Set `PI_ACP_TYPED_PROMPT_RECEIPTS=1` with a Pi build that supports native
`prompt_with_id.clientContent`. The v2 preview then advertises
`_meta["nymph.ai/fabric"].keyedResourceLinkPrompts`. It stores the original
ordered ACP blocks on the native user entry when a prompt contains a resource
link. Retries check those retained blocks and replay restores them. Older
rendered-only entries can certify plain-text retries.

Set `PI_ACP_ACTIVE_STEERING=1` with a Pi build that provides the
[`steer_with_id` native RPC](https://github.com/nymph-ai/pi/commit/74b30313699c6d628f945b0558e1b294c4fd3118). This adds `_session/steering` and advertises
`_meta.steering.supported` and `_meta["nymph.ai/fabric"].keyedTextSteering`.
The method accepts text and resource links. Pass `_meta.steering.idempotencyKey`
and `idleBehavior: "promptRequired"` to retry safely. An idle session leaves
new input unconsumed, and a retained receipt is reusable after restart.

Set `PI_ACP_NATIVE_CURSORS=1` with a Pi build that provides
[`fork_snapshot`](https://github.com/nymph-ai/pi/commit/1bb09de31b75fc1d0148512c3c68ec1014f42dfa).
This adds `session/fork` and emits stable fork cursors before user messages
and after tool-free assistant messages. The native snapshot creates a
separate session with the exact history before the cursor. Omitting the
cursor copies the whole current branch after it settles. Keep the Pi ACP
home and native session store across restarts to retain cursor validity.

For a retained cursor, send `session/resume` with
`replayFrom: { "type": "_fabric_cursor", "cursorId": "…" }`. This Pi
extension is advertised in `_meta["nymph.ai/fabric"].replayFromCursor`.
The replay starts at the cursor position. A before-user cursor includes
that user message, and an after-assistant cursor starts with its successor.
Pi emits `replay_complete` even at the end of the branch. Unknown, stale,
and cross-session cursors fail with `-32602`.

Tool, thought, session-message and compaction anchors, client MCP setup,
additional roots, and terminal replay are outside this preview. This mode is intended for single-owner native Pi
sessions, including `fabd` session mode.

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to pi in this adapter. If you use [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) it will be available in the ACP client.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Queue is implemented client-side and should work like pi's `one-at-a-time`
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)).
