import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-orbit-token",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authenticate(req: Request) {
  const raw = req.headers.get("x-orbit-token") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) return null;
  const tokenHash = await hashToken(raw);
  const { data } = await supabase.from("agent_tokens").select("*").eq("token_hash", tokenHash).is("revoked_at", null).maybeSingle();
  if (!data || (data.expires_at && new Date(data.expires_at) < new Date())) return null;
  await supabase.from("agent_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return data;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

async function readJson(req: Request) {
  try {
    const value = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return { body: null, error: json({ error: "invalid_json_object" }, 400) };
    return { body: value as Record<string, unknown>, error: null };
  } catch {
    return { body: null, error: json({ error: "invalid_json" }, 400) };
  }
}

function pick<T extends Record<string, unknown>>(body: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]])) as Partial<T>;
}

async function getOwnedProject(projectId: string, ownerId: string) {
  return supabase.from("projects").select("id,name").eq("id", projectId).eq("owner_id", ownerId).maybeSingle();
}

function isDateTime(value: unknown) {
  return value === null || (typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && !Number.isNaN(Date.parse(value)));
}

async function writeActivity(projectId: string, ownerId: string, action: string, message: string, metadata: Record<string, unknown> = {}) {
  const { error } = await supabase.from("activity_logs").insert({ project_id: projectId, owner_id: ownerId, actor: "agent", action, message, metadata });
  return error?.message ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = await authenticate(req);
  if (!token) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const parts = pathParts[0] === "agent-api" ? pathParts.slice(1) : pathParts;
  if (req.method === "GET" && parts.length === 1 && parts[0] === "projects") {
    if (!token.scopes.includes("read")) return json({ error: "scope_forbidden" }, 403);
    let query = supabase.from("projects").select("*").eq("owner_id", token.owner_id).order("updated_at", { ascending: false });
    if (token.project_id) query = query.eq("id", token.project_id);
    const { data, error } = await query;
    if (error) return json({ error: error.message }, 400);
    return json({ projects: data ?? [] });
  }
  if (req.method === "POST" && parts.length === 1 && parts[0] === "projects") {
    if (token.project_id || !token.scopes.includes("write")) return json({ error: "project_scope_forbidden" }, 403);
    const parsed = await readJson(req);
    if (parsed.error) return parsed.error;
    const body = parsed.body!;
    if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "name_required" }, 400);
    if (body.description !== undefined && typeof body.description !== "string") return json({ error: "invalid_description" }, 400);
    const status = body.status ?? "planning";
    const progress = body.progress ?? 0;
    if (!["planning", "active", "paused", "completed", "archived"].includes(String(status))) return json({ error: "invalid_status" }, 400);
    if (!Number.isInteger(progress as number) || Number(progress) < 0 || Number(progress) > 100) return json({ error: "invalid_progress" }, 400);
    const { data, error } = await supabase.from("projects").insert({ owner_id: token.owner_id, name: body.name.trim(), description: typeof body.description === "string" ? body.description : "", status, progress }).select().single();
    if (error) return json({ error: error.message }, 400);
    const activityError = await writeActivity(data.id, token.owner_id, "project.created", `プロジェクト「${data.name}」を作成`, { source: "agent-api" });
    return json(activityError ? { ...data, activity_log_warning: activityError } : data, 201);
  }
  if (parts[0] === "goals" && parts.length === 1 && (req.method === "GET" || req.method === "POST")) {
    if (token.project_id) return json({ error: "project_scope_forbidden" }, 403);
    if (req.method === "GET") {
      if (!token.scopes.includes("read")) return json({ error: "scope_forbidden" }, 403);
      const { data, error } = await supabase.from("goals").select("*").eq("owner_id", token.owner_id).order("updated_at", { ascending: false });
      if (error) return json({ error: error.message }, 400);
      return json({ goals: data ?? [] });
    }
    if (!token.scopes.includes("write")) return json({ error: "scope_forbidden" }, 403);
    const parsed = await readJson(req);
    if (parsed.error) return parsed.error;
    const body = parsed.body!;
    if (typeof body.title !== "string" || !body.title.trim()) return json({ error: "title_required" }, 400);
    const { data, error } = await supabase.from("goals").insert({ owner_id: token.owner_id, title: body.title.trim(), description: typeof body.description === "string" ? body.description : "" }).select().single();
    if (error) return json({ error: error.message }, 400);
    return json(data, 201);
  }

  const projectId = parts[0];
  if (token.project_id && token.project_id !== projectId) return json({ error: "project_forbidden" }, 403);
  if (!token.scopes.includes(req.method === "GET" ? "read" : "write")) return json({ error: "scope_forbidden" }, 403);

  if (req.method === "GET" && parts.length === 1) {
    const [project, todos, activity, resources] = await Promise.all([
      supabase.from("projects").select("*").eq("id", projectId).eq("owner_id", token.owner_id).single(),
      supabase.from("todos").select("*").eq("project_id", projectId).eq("owner_id", token.owner_id).order("updated_at", { ascending: false }),
      supabase.from("activity_logs").select("*").eq("project_id", projectId).eq("owner_id", token.owner_id).order("created_at", { ascending: false }).limit(30),
      supabase.from("project_resources").select("*").eq("project_id", projectId).eq("owner_id", token.owner_id).order("updated_at", { ascending: false }),
    ]);
    if (project.error) return json({ error: "project_not_found" }, 404);
    return json({ project: project.data, todos: todos.data ?? [], activity: activity.data ?? [], resources: resources.data ?? [] });
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "resources") {
    const project = await getOwnedProject(projectId, token.owner_id);
    if (project.error || !project.data) return json({ error: "project_not_found" }, 404);
    const { data, error } = await supabase.from("project_resources").select("*").eq("project_id", projectId).eq("owner_id", token.owner_id).order("updated_at", { ascending: false });
    if (error) return json({ error: error.message }, 400);
    return json({ resources: data ?? [] });
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "resources") {
    const project = await getOwnedProject(projectId, token.owner_id);
    if (project.error || !project.data) return json({ error: "project_not_found" }, 404);
    const parsed = await readJson(req);
    if (parsed.error) return parsed.error;
    const body = parsed.body!;
    if (body.provider !== "github" || body.resource_type !== "repository") return json({ error: "unsupported_resource" }, 400);
    if (typeof body.url !== "string") return json({ error: "url_required" }, 400);
    let parsedUrl: URL;
    try { parsedUrl = new URL(body.url); } catch { return json({ error: "invalid_url" }, 400); }
    const path = parsedUrl.pathname.split("/").filter(Boolean);
    if (parsedUrl.hostname !== "github.com" || path.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(path[0]) || !/^[A-Za-z0-9_.-]+$/.test(path[1].replace(/\.git$/, ""))) return json({ error: "invalid_github_repository_url" }, 400);
    const externalId = `${path[0]}/${path[1].replace(/\.git$/, "")}`;
    const canonicalUrl = `https://github.com/${externalId}`;
    const { data, error } = await supabase.from("project_resources").upsert({ project_id: projectId, owner_id: token.owner_id, provider: "github", resource_type: "repository", external_id: externalId, url: canonicalUrl, name: typeof body.name === "string" ? body.name.trim() : externalId, metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {} }, { onConflict: "project_id,provider,resource_type,external_id" }).select().single();
    if (error) return json({ error: error.message }, 400);
    const activityError = await writeActivity(projectId, token.owner_id, "resource.connected", `GitHubリポジトリ「${externalId}」を連携`, { provider: "github", resource_type: "repository", external_id: externalId, source: "agent-api" });
    return json(activityError ? { ...data, activity_log_warning: activityError } : data, 201);
  }

  if (req.method === "GET" && parts.length === 4 && parts[1] === "todos" && parts[3] === "links") {
    const { data: todo } = await supabase.from("todos").select("id").eq("id", parts[2]).eq("project_id", projectId).eq("owner_id", token.owner_id).maybeSingle();
    if (!todo) return json({ error: "todo_not_found" }, 404);
    const { data, error } = await supabase.from("todo_external_links").select("*").eq("todo_id", parts[2]).eq("project_id", projectId).eq("owner_id", token.owner_id).order("updated_at", { ascending: false });
    if (error) return json({ error: error.message }, 400);
    return json({ links: data ?? [] });
  }

  if (req.method === "POST" && parts.length === 4 && parts[1] === "todos" && parts[3] === "links") {
    const { data: todo } = await supabase.from("todos").select("id,title").eq("id", parts[2]).eq("project_id", projectId).eq("owner_id", token.owner_id).maybeSingle();
    if (!todo) return json({ error: "todo_not_found" }, 404);
    const parsed = await readJson(req);
    if (parsed.error) return parsed.error;
    const body = parsed.body!;
    if (body.provider !== "github" || typeof body.url !== "string") return json({ error: "invalid_github_link" }, 400);
    let parsedUrl: URL;
    try { parsedUrl = new URL(body.url); } catch { return json({ error: "invalid_url" }, 400); }
    const match = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (parsedUrl.hostname !== "github.com" || !match) return json({ error: "invalid_github_issue_url" }, 400);
    const externalId = `${match[1]}/${match[2]}#${match[3]}`;
    const canonicalUrl = `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`;
    const { data, error } = await supabase.from("todo_external_links").upsert({ todo_id: parts[2], project_id: projectId, owner_id: token.owner_id, provider: "github", external_id: externalId, url: canonicalUrl, metadata: {} }, { onConflict: "todo_id,provider,external_id" }).select().single();
    if (error) return json({ error: error.message }, 400);
    const activityError = await writeActivity(projectId, token.owner_id, "todo.issue_linked", `TODO「${todo.title}」にGitHub Issueを連携`, { todo_id: todo.id, provider: "github", external_id: externalId, source: "agent-api" });
    return json(activityError ? { ...data, activity_log_warning: activityError } : data, 201);
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "todos") {
    const project = await getOwnedProject(projectId, token.owner_id);
    if (project.error || !project.data) return json({ error: "project_not_found" }, 404);
    const parsed = await readJson(req);
    if (parsed.error) return parsed.error;
    const body = parsed.body!;
    const createdBy = body.created_by ?? "api";
    if (typeof body.title !== "string" || !body.title.trim()) return json({ error: "title_required" }, 400);
    if (!["human", "codex", "claude", "api"].includes(String(createdBy))) return json({ error: "invalid_created_by" }, 400);
    if (body.description !== undefined && typeof body.description !== "string") return json({ error: "invalid_description" }, 400);
    if (!isDateTime(body.due_at ?? null)) return json({ error: "invalid_due_at" }, 400);
    if (body.priority !== undefined && !["low", "normal", "high", "urgent"].includes(String(body.priority))) return json({ error: "invalid_priority" }, 400);
    if (body.status !== undefined && !["todo", "in_progress", "done", "cancelled"].includes(String(body.status))) return json({ error: "invalid_status" }, 400);
    const { data, error } = await supabase.from("todos").insert({ project_id: projectId, owner_id: token.owner_id, title: body.title.trim(), description: typeof body.description === "string" ? body.description : "", priority: body.priority ?? "normal", status: body.status ?? "todo", due_at: body.due_at ?? null, created_by: createdBy }).select().single();
    if (error) return json({ error: error.message }, 400);
    const activityError = await writeActivity(projectId, token.owner_id, "todo.created", `TODO「${data.title}」を追加`, { todo_id: data.id, source: "agent-api" });
    return json(activityError ? { ...data, activity_log_warning: activityError } : data, 201);
  }

  if (req.method === "PATCH" && parts.length === 3 && parts[1] === "todos" && parts[2]) {
    const project = await getOwnedProject(projectId, token.owner_id);
    if (project.error || !project.data) return json({ error: "project_not_found" }, 404);
    const parsed = await readJson(req);
    if (parsed.error) return parsed.error;
    const body = parsed.body!;
    const updates = pick(body, ["title", "description", "status", "priority", "due_at"]);
    if (!Object.keys(updates).length) return json({ error: "no_updatable_fields" }, 400);
    if (updates.title !== undefined && (typeof updates.title !== "string" || !updates.title.trim())) return json({ error: "invalid_title" }, 400);
    if (updates.description !== undefined && typeof updates.description !== "string") return json({ error: "invalid_description" }, 400);
    if (updates.due_at !== undefined && !isDateTime(updates.due_at)) return json({ error: "invalid_due_at" }, 400);
    if (updates.status !== undefined && !["todo", "in_progress", "done", "cancelled"].includes(String(updates.status))) return json({ error: "invalid_status" }, 400);
    if (updates.priority !== undefined && !["low", "normal", "high", "urgent"].includes(String(updates.priority))) return json({ error: "invalid_priority" }, 400);
    const { data, error } = await supabase.from("todos").update(updates).eq("id", parts[2]).eq("project_id", projectId).eq("owner_id", token.owner_id).select().single();
    if (error && error.code === "PGRST116") return json({ error: "todo_not_found" }, 404);
    if (error) return json({ error: error.message }, 400);
    const activityError = await writeActivity(data.project_id, token.owner_id, "todo.updated", `TODO「${data.title}」を更新`, { todo_id: data.id, status: data.status, source: "agent-api" });
    return json(activityError ? { ...data, activity_log_warning: activityError } : data);
  }

  if (req.method === "PATCH" && parts.length === 1) {
    const parsed = await readJson(req);
    if (parsed.error) return parsed.error;
    const body = parsed.body!;
    const updates = pick(body, ["name", "description", "status", "progress"]);
    if (!Object.keys(updates).length) return json({ error: "no_updatable_fields" }, 400);
    if (updates.name !== undefined && (typeof updates.name !== "string" || !updates.name.trim())) return json({ error: "invalid_name" }, 400);
    if (updates.description !== undefined && typeof updates.description !== "string") return json({ error: "invalid_description" }, 400);
    if (updates.status !== undefined && !["planning", "active", "paused", "completed", "archived"].includes(String(updates.status))) return json({ error: "invalid_status" }, 400);
    if (updates.progress !== undefined && (!Number.isInteger(updates.progress as number) || Number(updates.progress) < 0 || Number(updates.progress) > 100)) return json({ error: "invalid_progress" }, 400);
    const { data, error } = await supabase.from("projects").update(updates).eq("id", projectId).eq("owner_id", token.owner_id).select().single();
    if (error && error.code === "PGRST116") return json({ error: "project_not_found" }, 404);
    if (error) return json({ error: error.message }, 400);
    const activityError = await writeActivity(projectId, token.owner_id, "project.updated", `プロジェクト「${data.name}」を更新`, { progress: data.progress, status: data.status, source: "agent-api" });
    return json(activityError ? { ...data, activity_log_warning: activityError } : data);
  }
  return json({ error: "not_found" }, 404);
});
