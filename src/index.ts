import "dotenv/config";
import { spawn, type StdioOptions } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const DEFAULT_MAX_TOKENS = 2048;

// Harness bridge: hosts the DeepSeek model may drive, and their headless commands.
const HARNESS_ALLOW = (process.env.HARNESS_ALLOW_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function harnessCmd(host: string): string | undefined {
  return process.env[`HARNESS_CMD_${host.toUpperCase().replace(/-/g, "_")}`];
}

function configuredHarnesses(): string[] {
  const hosts = new Set<string>(HARNESS_ALLOW);
  for (const key of Object.keys(process.env)) {
    const m = /^HARNESS_CMD_([A-Z0-9_]+)$/.exec(key);
    if (m) hosts.add(m[1].toLowerCase().replace(/_/g, "-"));
  }
  return [...hosts].sort();
}

if (!API_KEY) {
  console.error("deepseek-mcp: DEEPSEEK_API_KEY missing. Set it in .env or environment.");
}

const SYSTEM_NAME = "deepseek-mcp";
const SYSTEM_VERSION = "0.1.0";

const server = new Server(
  {
    name: SYSTEM_NAME,
    version: SYSTEM_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function chatCompletion(args: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
}): Promise<string> {
  if (!API_KEY) {
    throw new McpError(ErrorCode.InvalidRequest, "DEEPSEEK_API_KEY not set. Add it to .env and restart.");
  }
  if (!args.messages || args.messages.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, "messages: array of {role, content} required");
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: args.model || DEFAULT_MODEL,
      messages: args.messages,
      temperature: args.temperature,
      max_tokens: args.max_tokens ?? DEFAULT_MAX_TOKENS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new McpError(ErrorCode.InternalError, `DeepSeek API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };
  const choice = data.choices?.[0]?.message;
  if (!choice?.content && !choice?.reasoning_content) {
    throw new McpError(ErrorCode.InternalError, "DeepSeek API returned no content");
  }

  if (choice.reasoning_content && choice.content) {
    return `[reasoning]\n${choice.reasoning_content}\n\n[answer]\n${choice.content}`;
  }
  // Reasoning model exhausted its token budget on thinking; surface what it produced.
  return choice.content || `[reasoning only — max_tokens too low for full answer]\n${choice.reasoning_content}`;
}

const MAX_HARNESS_OUTPUT = 200_000;
// stdin=/dev/null: TUI-wrapped harnesses (script) ioctl-fail on socketpairs
const harnessStdio: StdioOptions = ["ignore", "pipe", "pipe"];

async function runHarness(args: {
  host: string;
  prompt: string;
  cwd?: string;
  timeout_ms?: number;
}): Promise<{ code: number | null; out: string }> {
  const host = (args.host || "").trim().toLowerCase();
  if (!host) {
    throw new McpError(ErrorCode.InvalidParams, "host: required (e.g. claude, codex, opencode)");
  }
  if (HARNESS_ALLOW.length && !HARNESS_ALLOW.includes(host)) {
    return {
      code: 1,
      out: `harness locked: host '${host}' not in HARNESS_ALLOW_HOSTS [${HARNESS_ALLOW.join(", ")}]`,
    };
  }
  const cmd = harnessCmd(host);
  if (!cmd) {
    return {
      code: 1,
      out: `no HARNESS_CMD_${host.toUpperCase()} configured. Known: ${configuredHarnesses().join(", ") || "(none)"}`,
    };
  }
  if (!args.prompt || !args.prompt.trim()) {
    throw new McpError(ErrorCode.InvalidParams, "prompt: required");
  }
  const parts = cmd.split(/\s+/).filter(Boolean);
  const [bin, ...fixed] = parts;
  const timeoutMs = args.timeout_ms ?? 120_000;

  const child = spawn(bin, [...fixed, args.prompt], {
    cwd: args.cwd || process.cwd(),
    env: { ...process.env },
    stdio: harnessStdio,
    timeout: timeoutMs,
    windowsHide: true,
  });

  return await new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d;
      if (out.length > MAX_HARNESS_OUTPUT) child.kill();
    });
    child.stderr?.on("data", (d) => {
      out += d;
      if (out.length > MAX_HARNESS_OUTPUT) child.kill();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: sanitizeOutput(out) }));
  });
}

function sanitizeOutput(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // ANSI escapes
    .replace(/\x08/g, "") // backspaces (^D\b\b from `script`)
    .replace(/\r/g, "")
    .replace(/^\^D/, "")
    .trim();
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "chat",
      description:
        "Send a chat completion request to DeepSeek. Accepts an OpenAI-style message list and returns the assistant's reply text.",
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            description: "Chat messages, newest last. Each: {role: system|user|assistant, content: string}",
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["system", "user", "assistant"] },
                content: { type: "string" },
              },
              required: ["role", "content"],
            },
          },
          model: {
            type: "string",
            description: "DeepSeek model id (default: deepseek-chat; alternative: deepseek-reasoner)",
          },
          temperature: { type: "number", description: "Sampling temperature (0-2)" },
          max_tokens: { type: "number", description: `Max output tokens (default: ${DEFAULT_MAX_TOKENS})` },
        },
        required: ["messages"],
      },
    },
    {
      name: "list_models",
      description: "List models available on the DeepSeek API.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_harnesses",
      description:
        "List harness hosts the bridge can drive (from HARNESS_ALLOW_HOSTS / HARNESS_CMD_* config) with their commands.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "use_harness",
      description:
        "Run a prompt in a headless host CLI (claude -p, codex exec, opencode run, ...). Lets the DeepSeek model drive local agents, skills, plugins, and MCP tools configured on that host. Host must be in HARNESS_ALLOW_HOSTS.",
      inputSchema: {
        type: "object",
        properties: {
          host: {
            type: "string",
            description: "Harness to drive (claude | codex | opencode, or other configured)",
          },
          prompt: {
            type: "string",
            description: "Task for the harness session",
          },
          cwd: {
            type: "string",
            description: "Working directory for the harness (default: server cwd)",
          },
          timeout_ms: {
            type: "number",
            description: "Kill the harness after this many ms (default: 120000)",
          },
        },
        required: ["host", "prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "chat": {
      const text = await chatCompletion(args as Parameters<typeof chatCompletion>[0]);
      return {
        content: [{ type: "text", text }],
      };
    }
    case "list_models": {
      if (!API_KEY) {
        throw new McpError(ErrorCode.InvalidRequest, "DEEPSEEK_API_KEY not set. Add it to .env and restart.");
      }
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new McpError(ErrorCode.InternalError, `DeepSeek API ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (data.data || []).map((m) => m.id);
      return {
        content: [{ type: "text", text: ids.join("\n") || "(no models returned)" }],
      };
    }
    case "list_harnesses": {
      return {
        content: [
          {
            type: "text",
            text:
              configuredHarnesses().length === 0
                ? "(no harnesses configured)"
                : configuredHarnesses()
                    .map((h) => `${h} -> ${harnessCmd(h) || "(no HARNESS_CMD_* — blocked)"}`)
                    .join("\n"),
          },
        ],
      };
    }
    case "use_harness": {
      const { code, out } = await runHarness(args as Parameters<typeof runHarness>[0]);
      return {
        isError: code !== 0,
        content: [{ type: "text", text: out || `(empty output, exit ${code})` }],
      };
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
