#!/usr/bin/env node
// Orbit <-> Claude Code integration.
//
//   node orbit.mjs hook session-start   (SessionStart hook: inject project state into context)
//   node orbit.mjs hook session-end     (SessionEnd hook: post a work summary to the activity log)
//   node orbit.mjs show | projects | link <project_id> | unlink
//   node orbit.mjs todo add "<title>" [--priority high] [--desc "..."]
//   node orbit.mjs todo start|done|cancel <todo_id>
//   node orbit.mjs progress <0-100> [--status active]
//   node orbit.mjs note "<message>"
//
// Env: ORBIT_API, ORBIT_TOKEN. Folder -> project mapping: ~/.claude/orbit/projects.json

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".claude", "orbit");
const MAP_FILE = path.join(CONFIG_DIR, "projects.json");
const STATE_FILE = path.join(CONFIG_DIR, "state.json");
const SELF = path.resolve(process.argv[1]).replace(/\\/g, "/");
const API = (process.env.ORBIT_API || "").replace(/\/$/, "");
const TOKEN = process.env.ORBIT_TOKEN || "";

const norm = (p) => path.resolve(p).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function loadMappings() {
  return readJsonFile(MAP_FILE, { mappings: [] }).mappings || [];
}

function resolveProject(cwd, override) {
  if (override) return { project_id: override, path: cwd };
  const here = norm(cwd);
  let best = null;
  for (const m of loadMappings()) {
    const base = norm(m.path);
    if ((here === base || here.startsWith(base + "/")) && (!best || base.length > norm(best.path).length)) best = m;
  }
  return best;
}

async function api(method, route, body) {
  if (!API || !TOKEN) throw new Error("ORBIT_API / ORBIT_TOKEN が未設定です");
  const res = await fetch(API + route, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status} ${data.error || text}`);
  return data;
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try { return JSON.parse(raw); } catch { return {}; }
}

function parseFlags(args) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[++i];
    else rest.push(args[i]);
  }
  return { flags, rest };
}

// ---------- hooks ----------

async function sessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const mapping = resolveProject(cwd);
  if (!mapping) return;
  const { project, todos, activity } = await api("GET", `/${mapping.project_id}`);
  const open = todos.filter((t) => t.status === "todo" || t.status === "in_progress");
  const order = { urgent: 0, high: 1, normal: 2, low: 3 };
  open.sort((a, b) => (a.status === "in_progress" ? -1 : 0) - (b.status === "in_progress" ? -1 : 0) || order[a.priority] - order[b.priority]);
  const cli = `node "${SELF}"`;
  const lines = [
    `# Orbit 連携: このフォルダはプロジェクト「${project.name}」(${project.status}, 進捗 ${project.progress}%) に紐づいています`,
    project.description ? `概要: ${project.description}` : "",
    "",
    `## 未完了 TODO (${open.length}件)`,
    ...open.slice(0, 25).map((t) => `- [${t.status === "in_progress" ? "進行中" : "未着手"}${t.priority !== "normal" ? "/" + t.priority : ""}] ${t.title}  (id: ${t.id})`),
    open.length > 25 ? `- ...ほか ${open.length - 25} 件` : "",
    "",
    "## 最近の活動",
    ...activity.slice(0, 5).map((a) => `- ${a.created_at.slice(0, 10)} ${a.message}`),
    "",
    "## Orbit の更新ルール",
    "作業内容が上の TODO に関係するときは、ユーザーに聞かずに Orbit を更新すること（Bash で実行）:",
    `- 着手: ${cli} todo start <id>`,
    `- 完了: ${cli} todo done <id>`,
    `- 作業中に見つかった、後でやるべき新しい課題: ${cli} todo add "<タイトル>" [--priority high]`,
    `- 節目（機能完成・リリース・方針決定など）で進捗%を見直す: ${cli} progress <0-100>`,
    `- 重要な決定や結果を残す: ${cli} note "<内容>"`,
    "セッション終了時の作業サマリーは hook が自動で記録するので、毎回 note を書く必要はない。雑談や質問だけのときは更新しない。",
  ].filter((l, i, arr) => l !== "" || arr[i - 1] !== "");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }));
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return "";
}

async function sessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const mapping = resolveProject(cwd);
  if (!mapping || !input.transcript_path || !fs.existsSync(input.transcript_path)) return;

  const lines = fs.readFileSync(input.transcript_path, "utf8").split("\n").filter(Boolean);
  const state = readJsonFile(STATE_FILE, {});
  const key = input.session_id || input.transcript_path;
  const from = state[key]?.line || 0;
  if (from >= lines.length) return;

  const prompts = [], files = new Set(), commits = [];
  for (const line of lines.slice(from)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isMeta || e.isSidechain) continue;
    const content = e.message?.content;
    if (e.type === "user") {
      if (Array.isArray(content) && content.some((c) => c.type === "tool_result")) continue;
      const t = textOf(content).trim();
      if (t && !t.startsWith("<") && !t.startsWith("[Request interrupted")) prompts.push(t);
    } else if (e.type === "assistant" && Array.isArray(content)) {
      for (const c of content) {
        if (c.type !== "tool_use") continue;
        const fp = c.input?.file_path || c.input?.notebook_path;
        if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(c.name) && fp) files.add(fp);
        const cmd = c.input?.command || "";
        if ((c.name === "Bash" || c.name === "PowerShell") && /git\s+commit/.test(cmd)) {
          const m = cmd.match(/-m\s+["']([^"'\n]+)/);
          commits.push(m ? m[1] : "commit");
        }
      }
    }
  }
  const dryRun = process.env.ORBIT_DRY_RUN === "1";
  if (!dryRun) {
    state[key] = { line: lines.length, at: new Date().toISOString() };
    writeJsonFile(STATE_FILE, state);
  }
  if (!files.size && !commits.length) return; // 質問・雑談だけのセッションは記録しない

  const base = norm(mapping.path);
  const rel = [...files].map((f) => {
    const n = norm(f);
    return n.startsWith(base + "/") ? f.replace(/\\/g, "/").slice(base.length + 1) : path.basename(f);
  });
  const first = (prompts[0] || "作業").replace(/\s+/g, " ").slice(0, 60);
  const parts = [`Claude Codeで作業: 「${first}${(prompts[0] || "").length > 60 ? "…" : ""}」`];
  if (prompts.length > 1) parts.push(`ほか${prompts.length - 1}件の依頼`);
  parts.push(`${rel.length}ファイル変更` + (rel.length ? `（${rel.slice(0, 4).join(", ")}${rel.length > 4 ? " ほか" : ""}）` : ""));
  if (commits.length) parts.push(`コミット${commits.length}件`);

  const payload = {
    actor: "claude",
    action: "session.summary",
    message: parts.join(" / "),
    metadata: { session_id: input.session_id, files: rel.slice(0, 30), commits: commits.slice(0, 10), prompts: prompts.slice(0, 5).map((p) => p.slice(0, 200)) },
  };
  if (dryRun) return void process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  await api("POST", `/${mapping.project_id}/activity`, payload);
}

// ---------- CLI ----------

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { flags, rest } = parseFlags(args);

  if (cmd === "hook") {
    const input = await readStdin();
    try {
      if (rest[0] === "session-start") await sessionStart(input);
      if (rest[0] === "session-end") await sessionEnd(input);
    } catch (err) {
      // hook は失敗しても作業を止めない
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.appendFileSync(path.join(CONFIG_DIR, "error.log"), `${new Date().toISOString()} ${rest[0]} ${err.message}\n`);
    }
    return;
  }

  const cwd = process.cwd();
  if (cmd === "projects") {
    const { projects } = await api("GET", "/projects");
    for (const p of projects) console.log(`${p.id}  ${p.status.padEnd(9)} ${String(p.progress).padStart(3)}%  ${p.name}`);
    return;
  }
  if (cmd === "goals") {
    const { goals } = await api("GET", "/goals");
    for (const g of goals) console.log(`${g.status.padEnd(9)} ${g.title}`);
    return;
  }
  if (cmd === "goal" && rest[0] === "add" && rest[1]) {
    const g = await api("POST", "/goals", { title: rest[1], description: flags.desc });
    console.log(`goal added: ${g.title} (${g.id})`);
    return;
  }
  if (cmd === "link") {
    if (!rest[0]) throw new Error("usage: link <project_id> [--path <dir>]");
    const dir = flags.path || cwd;
    const { project } = await api("GET", `/${rest[0]}`);
    const map = readJsonFile(MAP_FILE, { mappings: [] });
    map.mappings = (map.mappings || []).filter((m) => norm(m.path) !== norm(dir));
    map.mappings.push({ path: path.resolve(dir).replace(/\\/g, "/"), project_id: project.id, name: project.name });
    writeJsonFile(MAP_FILE, map);
    console.log(`linked ${dir} -> ${project.name}`);
    return;
  }
  if (cmd === "unlink") {
    const dir = flags.path || cwd;
    const map = readJsonFile(MAP_FILE, { mappings: [] });
    map.mappings = (map.mappings || []).filter((m) => norm(m.path) !== norm(dir));
    writeJsonFile(MAP_FILE, map);
    console.log(`unlinked ${dir}`);
    return;
  }

  const mapping = resolveProject(cwd, flags.project);
  if (!mapping) throw new Error(`このフォルダは Orbit のプロジェクトに紐づいていません（${MAP_FILE}）。 link <project_id> で紐づけてください`);
  const pid = mapping.project_id;

  if (cmd === "show") {
    const { project, todos } = await api("GET", `/${pid}`);
    console.log(`${project.name}  ${project.status}  ${project.progress}%`);
    for (const t of todos) console.log(`  ${t.status.padEnd(11)} ${t.priority.padEnd(6)} ${t.title}  (${t.id})`);
    return;
  }
  if (cmd === "todo") {
    const [sub, arg] = rest;
    if (sub === "add") {
      const t = await api("POST", `/${pid}/todos`, { title: arg, priority: flags.priority, description: flags.desc, created_by: "claude" });
      console.log(`added: ${t.title} (${t.id})`);
      return;
    }
    const status = { start: "in_progress", done: "done", cancel: "cancelled", reopen: "todo" }[sub];
    if (!status || !arg) throw new Error("usage: todo add <title> | todo start|done|cancel|reopen <todo_id>");
    const t = await api("PATCH", `/${pid}/todos/${arg}`, { status });
    console.log(`${t.status}: ${t.title}`);
    return;
  }
  if (cmd === "progress") {
    const body = { progress: Number(rest[0]) };
    if (flags.status) body.status = flags.status;
    const p = await api("PATCH", `/${pid}`, body);
    console.log(`${p.name}: ${p.progress}% (${p.status})`);
    return;
  }
  if (cmd === "note") {
    await api("POST", `/${pid}/activity`, { actor: "claude", action: "agent.note", message: rest.join(" ") });
    console.log("noted");
    return;
  }
  console.log("commands: show | projects | link <id> | unlink | todo add|start|done|cancel|reopen | progress <n> | note <msg>");
}

main().catch((err) => {
  console.error(`orbit: ${err.message}`);
  process.exit(1);
});
