// Protocol smoke test: spawns the MCP server over stdio, runs handshake,
// lists tools, calls `chat` with a trivial prompt. Uses DEEPSEEK_API_KEY
// from .env if present; without a key it verifies the server surfaces the
// missing-key error correctly.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const serverPath = process.argv[2] || "dist/index.js";
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 0;

function send(method, params) {
  const id = ++nextId;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return promise;
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

child.on("exit", (code) => {
  console.error(`server exited ${code}`);
  process.exit(code ?? 1);
});

function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
    throw new Error(label);
  }
  console.log(`ok: ${label}`);
}

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-harness", version: "0.0.1" },
  });
  assert(init.serverInfo?.name === "deepseek-mcp", "initialize handshake");
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
  );

  const tools = await send("tools/list", {});
  const names = tools.tools.map((t) => t.name);
  assert(names.includes("chat") && names.includes("list_models"), `tools/list -> ${names.join(",")}`);

  const chat = await send("tools/call", {
    name: "chat",
    arguments: { messages: [{ role: "user", content: "Reply with exactly: pong" }], max_tokens: 16 },
  });
  if (chat.isError) {
    const text = chat.content?.[0]?.text ?? "";
    assert(text.includes("DEEPSEEK_API_KEY"), `missing-key error surfaced -> ${text.slice(0, 60)}`);
    console.log("note: no DEEPSEEK_API_KEY in env; live call skipped. Set .env and re-run.");
  } else {
    const text = chat.content?.[0]?.text ?? "";
    assert(text.trim().length > 0, `chat returned content -> ${text.trim().slice(0, 80)}`);
  }

  const models = await send("tools/call", { name: "list_models", arguments: {} });
  if (models.isError) {
    console.log(`note: list_models skipped (${models.content?.[0]?.text?.slice(0, 60)})`);
  } else {
    const text = models.content?.[0]?.text ?? "";
    assert(text.trim().length > 0, `list_models -> ${text.trim().slice(0, 80)}`);
  }

  const harnesses = await send("tools/call", { name: "list_harnesses", arguments: {} });
  const harnessText = harnesses.content?.[0]?.text ?? "";
  assert(!harnesses.isError && harnessText.includes("->"), `list_harnesses -> ${harnessText.replaceAll("\n", " | ")}`);

  const locked = await send("tools/call", {
    name: "use_harness",
    arguments: { host: "not-a-host", prompt: "hi" },
  });
  assert(locked.isError, "locked host errors");

  const harnessHosts = ["opencode", "claude", "codex"];
  for (const host of harnessHosts) {
    const res = await send("tools/call", {
      name: "use_harness",
      arguments: { host, prompt: "Reply with exactly: harness-ok", timeout_ms: 120_000 },
    });
    assert(!res.isError, `${host} harness call ok`);
    const text = res.content?.[0]?.text ?? "";
    assert(/harness-ok/.test(text), `${host} returned expected -> ${text.slice(0, 80).replaceAll("\n", " ")}`);
  }

  console.log("smoke: all done");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
