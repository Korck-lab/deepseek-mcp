# deepseek-mcp

An [MCP](https://modelcontextprotocol.io) server that bridges CLI harnesses to the [DeepSeek API](https://platform.deepseek.com). Callers (Claude Code, Codex, opencode, or any MCP client) connect over stdio and get DeepSeek chat completions — plus the option to hand work back to a local harness session.

## Quickstart

One-shot install straight from the repo (clone lives in `~/.deepseek-mcp`, override with `DEEPSEEK_MCP_HOME`). Fresh installs prompt for your API key — it opens the [key page](https://platform.deepseek.com/api_keys) and reads a hidden paste. Updates keep your existing `.env` untouched:

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-mcp/main/scripts/install.sh | bash
```

Prefer reviewing the script first, or hit terminal weirdness (no controlling tty: SSH without `-t`, CI)? Download then run — stdin stays yours, no pipe tricks:

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-mcp/main/scripts/install.sh -o /tmp/deepseek-mcp-install.sh
bash /tmp/deepseek-mcp-install.sh
```

Manual clone:

```bash
git clone https://github.com/Korck-lab/deepseek-mcp
cd deepseek-mcp
npm install
npm run build
cp .env.example .env        # paste your DEEPSEEK_API_KEY
npm run install:cli         # interactive: pick claude/codex/opencode + scope
```

Then run `claude mcp list`, `codex mcp list`, or `opencode mcp list` to confirm the `deepseek` server shows **Connected**, and use it from that client. See [Interactive installer](#interactive-installer) for flags and scope details.

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

## Auto-versioning

Local git hooks bump the version and tag releases automatically from [conventional commit](https://www.conventionalcommits.org) messages — no manual version edits, no CI needed.

```bash
npm run hooks:install        # git config core.hooksPath .githooks (per-repo)
```

On every commit it reads the commit message and:

| Commit type | Example | Bump |
| --- | --- | --- |
| breaking | `feat!: drop node 18`, or `BREAKING CHANGE` in body | major |
| `feat:` | `feat: add installer` | minor |
| `fix:` / `perf:` | `fix: opencode pty wrapper` | patch |
| anything else | `docs:`, `chore:`, `test:`, `refactor:` | none |

After the commit is created, a `post-commit` hook reads the real message from `COMMIT_EDITMSG` (the message is not available earlier — `pre-commit` runs before it exists), bumps `package.json` (+`package-lock.json`), amends the commit so the bump is included, then creates an annotated tag `vX.Y.Z`. Merge commits never re-bump; amends do re-bump (tag already exists, so it just skips). Run `npm version` manually at any time to override.

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
