# deepseek-mcp

An [MCP](https://modelcontextprotocol.io) server that bridges CLI harnesses to the [DeepSeek API](https://platform.deepseek.com). Callers (Claude Code, Codex, opencode, or any MCP client) connect over stdio and get DeepSeek chat completions — plus the option to hand work back to a local harness session.

## Features

- **Chat completions** — OpenAI-style `messages` → DeepSeek. Supports `deepseek-v4-flash` / `deepseek-v4-pro` reasoning models, including `reasoning_content`.
- **Model discovery** — `list_models` fetches available model ids from the API.
- **Harness bridge** — `use_harness` runs a prompt in a headless host CLI (`claude -p`, `codex exec`, `opencode run`, or any command you configure), letting the DeepSeek model drive local agents, skills, plugins, and MCP tools configured on that host.
- **Locked by default** — the bridge is off until you explicitly allowlist hosts.
- **Zero shell** — harness commands run as `spawn` argument arrays, never through a shell. Prompts are positional args, so no injection surface.
- **`dotenv` config** — keys and harness commands live in `.env`.

## Tools

| Tool | Description |
| --- | --- |
| `chat` | Send a chat completion request; returns assistant text (reasoning + answer for reasoning models). |
| `list_models` | List models available on the DeepSeek API. |
| `use_harness` | Run a prompt in a configured host CLI. Host must be allowlisted. |
| `list_harnesses` | Show configured harness hosts and their commands. |

## Setup

```bash
npm install
cp .env.example .env   # add your DEEPSEEK_API_KEY
npm run build
npm test               # protocol smoke test + live API + harness bridge
```

Run the server:

```bash
npm start
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | Required. DeepSeek API key. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL. |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Default model for `chat`. |
| `HARNESS_ALLOW_HOSTS` | *(empty = locked)* | Comma-separated hosts the bridge may drive. |
| `HARNESS_CMD_<HOST>` | — | Headless command for a host, e.g. `HARNESS_CMD_CLAUDE=claude -p`. |

Example bridge config (opencode is a TUI and needs a PTY wrapper on macOS):

```env
HARNESS_ALLOW_HOSTS=claude,codex,opencode
HARNESS_CMD_CLAUDE=claude -p
HARNESS_CMD_CODEX=codex exec --skip-git-repo-check
HARNESS_CMD_OPENCODE=script -q /dev/null opencode run
```

## MCP client config

```json
{
  "mcpServers": {
    "deepseek": {
      "command": "node",
      "args": ["/absolute/path/to/deepseek-mcp/dist/index.js"]
    }
  }
}
```

## Interactive installer

Register the server with Claude Code, Codex, and/or opencode — no manual config editing:

```bash
npm run install:cli
```

Prompts ask which CLI(s) to install and the scope:

- **global** — your user config (`~/.claude.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`)
- **project** — local to this repo (Claude `--scope local`, `.codex/config.toml`, `./opencode.json`; gitignored)

Optionally embeds `DEEPSEEK_API_KEY` into the client config (recommended for global scope, so the server works outside this repo). Scriptable:

```bash
npm run install:cli -- --clis claude,codex,opencode --scope global --embed key --yes
```

Flags: `--clis a,b,c`, `--scope global|project`, `--embed key|skip`, `--yes`.

## Security

- **The bridge is disabled until you allowlist hosts.** With `HARNESS_ALLOW_HOSTS` empty, `use_harness` errors.
- Harness commands run without a shell; the prompt is a single positional argument.
- The API key lives only in `.env` (gitignored) and is sent only to the DeepSeek API.
- Each harness call spawns a **fresh headless session** — no access to the calling client's session state. Note that a harness CLI runs with *its own* configured tools and credentials; only allowlist hosts you trust.

## Development

- `npm run build` — compile `src/` → `dist/`
- `npm run dev` — run from source with `tsx`
- `npm test` — MCP protocol smoke test (handshake, tools/list, live chat, model list, harness bridge)

Requires Node.js >= 20.

## License

[MIT](LICENSE)
