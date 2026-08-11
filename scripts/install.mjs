#!/usr/bin/env node
// Interactive installer: register deepseek-mcp with Claude Code, Codex, and/or opencode.
// Scope: global (per-user) or project (local files in this repo).
// Non-interactive flags for scripting: --clis a,b,c --scope global|project --embed key|skip --yes
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SERVER_NAME = "deepseek";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SERVER_PATH = join(ROOT, "dist", "index.js");
const ENV_PATH = join(ROOT, ".env");
const OPENCODE_GLOBAL = join(homedir(), ".config", "opencode", "opencode.json");

const CLIENTS = [
  { id: "claude", label: "Claude Code", hasGlobal: true, hasProject: true },
  { id: "codex", label: "Codex", hasGlobal: true, hasProject: true },
  { id: "opencode", label: "opencode", hasGlobal: true, hasProject: true },
];

// ---- arg parsing -----------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const cliArg = flag("--clis");
const scopeArg = flag("--scope");
const embedArg = flag("--embed");
const nonInteractive = args.includes("--yes");

// ---- helpers ---------------------------------------------------------------
function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  return Object.fromEntries(
    readFileSync(ENV_PATH, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      })
  );
}

const rl = createInterface({ input, output });
async function ask(question, fallback) {
  const answer = await rl.question(question);
  return answer.trim() || fallback;
}
async function confirm(question) {
  const answer = await ask(question, "y");
  return /^y/i.test(answer);
}

function gitignoreLines() {
  const gi = join(ROOT, ".gitignore");
  return existsSync(gi) ? readFileSync(gi, "utf8").split("\n") : [];
}

function ensureGitignored() {
  const entries = [".mcp.json", ".codex/", "opencode.json"];
  const lines = gitignoreLines();
  const missing = entries.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;
  writeFileSync(join(ROOT, ".gitignore"), [...lines, ...missing].join("\n") + "\n");
  console.log(`gitignored: ${missing.join(", ")}`);
}

// ---- per-client installers -------------------------------------------------
function installClaude(scope, envKey) {
  const s = scope === "global" ? "user" : "local";
  const args = ["mcp", "add", "--scope", s, SERVER_NAME];
  if (envKey) args.push("-e", `DEEPSEEK_API_KEY=${envKey}`);
  args.push("--", "node", SERVER_PATH);
  execFileSync("claude", args, { stdio: "inherit" });
  return `claude mcp add --scope ${s} ${SERVER_NAME} -- node ${SERVER_PATH}`;
}

function installCodex(scope, envKey) {
  if (scope === "global") {
    const args = ["mcp", "add"];
    if (envKey) args.push("--env", `DEEPSEEK_API_KEY=${envKey}`);
    args.push(SERVER_NAME, "--", "node", SERVER_PATH);
    execFileSync("codex", args, { stdio: "inherit" });
    return `codex mcp add ${SERVER_NAME} -- node ${SERVER_PATH}`;
  }
  // project scope: write .codex/config.toml
  const dir = join(ROOT, ".codex");
  const file = join(dir, "config.toml");
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "node"`,
    `args = ["${SERVER_PATH.replace(/"/g, '\\"')}"]`,
    ...(envKey ? [`env = { DEEPSEEK_API_KEY = "${envKey}" }`] : []),
  ].join("\n");
  if (existsSync(file) && readFileSync(file, "utf8").includes(`[mcp_servers.${SERVER_NAME}]`)) {
    return `skip: ${file} already has ${SERVER_NAME}`;
  }
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8").trimEnd() : "";
  writeFileSync(file, existing ? `${existing}\n\n${block}\n` : `${block}\n`);
  return `wrote ${file}`;
}

function opencodeConfigPath(scope) {
  return scope === "global" ? OPENCODE_GLOBAL : join(ROOT, "opencode.json");
}

function installOpencode(scope, envKey) {
  const file = opencodeConfigPath(scope);
  let config = {};
  if (existsSync(file)) {
    config = JSON.parse(readFileSync(file, "utf8"));
  }
  config.mcp = config.mcp || {};
  config.mcp[SERVER_NAME] = {
    type: "local",
    command: ["node", SERVER_PATH],
    enabled: true,
    ...(envKey ? { env: { DEEPSEEK_API_KEY: envKey } } : {}),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return `wrote ${file}`;
}

// ---- main ------------------------------------------------------------------
async function main() {
  console.log(`deepseek-mcp installer — server: ${SERVER_PATH}`);

  if (!existsSync(SERVER_PATH)) {
    console.log("server not built. Running npm run build...");
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  }

  // which CLIs
  let clis;
  if (cliArg) {
    clis = cliArg.split(",").map((s) => s.trim().toLowerCase());
  } else if (nonInteractive) {
    clis = CLIENTS.map((c) => c.id);
  } else {
    console.log("\nWhich CLI(s) to install?");
    CLIENTS.forEach((c, i) => console.log(`  ${i + 1}) ${c.label}`));
    const answer = await ask("Numbers, comma-separated (or 'all'): ", "all");
    clis = answer === "all" ? CLIENTS.map((c) => c.id) : answer.split(",").map((s) => CLIENTS[Number(s.trim()) - 1]?.id).filter(Boolean);
  }
  const chosen = CLIENTS.filter((c) => clis.includes(c.id));
  if (chosen.length === 0) {
    console.log("no CLIs selected. abort.");
    process.exit(1);
  }

  // scope
  let scope;
  if (scopeArg && ["global", "project"].includes(scopeArg)) {
    scope = scopeArg;
  } else if (nonInteractive) {
    scope = "project";
  } else {
    scope = await ask("\nScope? (global = your user config, project = this repo): ", "project");
    if (!["global", "project"].includes(scope)) {
      console.log("invalid scope. abort.");
      process.exit(1);
    }
  }

  // API key
  const env = loadEnv();
  let envKey;
  const hasKey = Boolean(env.DEEPSEEK_API_KEY && !env.DEEPSEEK_API_KEY.startsWith("sk-..."));
  if (hasKey) {
    if (embedArg) {
      envKey = embedArg === "key" ? env.DEEPSEEK_API_KEY : undefined;
    } else if (nonInteractive) {
      envKey = scope === "global" ? env.DEEPSEEK_API_KEY : undefined;
    } else {
      const embed = await confirm(
        `\nEmbed DEEPSEEK_API_KEY into client config? (needed if you use the server outside this repo; recommended for global scope) [y/N]: `,
        "n"
      );
      envKey = embed ? env.DEEPSEEK_API_KEY : undefined;
    }
  } else {
    console.log("\nwarning: DEEPSEEK_API_KEY not found in .env — server will error until you add it.");
  }

  console.log(`\nInstalling '${SERVER_NAME}' for: ${chosen.map((c) => c.label).join(", ")} (scope: ${scope})`);
  for (const c of chosen) {
    try {
      let msg;
      if (c.id === "claude") msg = installClaude(scope, envKey);
      if (c.id === "codex") msg = installCodex(scope, envKey);
      if (c.id === "opencode") msg = installOpencode(scope, envKey);
      console.log(`  ok [${c.label}] ${msg}`);
    } catch (err) {
      console.log(`  FAIL [${c.label}] ${err.message}`);
    }
  }

  if (scope === "project") ensureGitignored();

  console.log("\nDone. Verify:");
  if (chosen.some((c) => c.id === "claude")) console.log("  claude mcp list");
  if (chosen.some((c) => c.id === "codex")) console.log("  codex mcp list");
  if (chosen.some((c) => c.id === "opencode")) console.log(`  opencode mcp list (config: ${opencodeConfigPath(scope)})`);
}

main().finally(() => rl.close());
