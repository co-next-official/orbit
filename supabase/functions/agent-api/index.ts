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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = await authenticate(req);
  if (!token) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const parts = pathParts[0] === "agent-api" ? pathParts.slice(1) : pathParts;
  if (req.method === "GET" && parts[0] === "projects") {
    if (!token.scopes.includes("read")) return json({ error: "scope_forbidden" }, 403);
    const { data, error } = await supabase.from("projects").select("*").eq("owner_id", token.owner_id).order("updated_at", { ascending: false });
    if (error) return json({ error: error.message }, 400);
    return json({ projects: data ?? [] });
  }
  if (req.method === "POST" && parts[0] === "projects") {
    if (token.project_id || !token.scopes.includes("write")) return json({ error: "project_scope_forbidden" }, 403);
    const body = await req.json();
    if (!body.name) return json({ error: "name_required" }, 400);
    const { data, error } = await supabase.from("projects").insert({ owner_id: token.owner_id, name: body.name, description: body.description ?? "", status: body.status ?? "planning", progress: body.progress ?? 0 }).select().single();
    if (error) return json({ error: error.message }, 400);
    return json(data, 201);
  }
  const projectId = parts[0];
  if (token.project_id && token.project_id !== projectId) return json({ error: "project_forbidden" }, 403);
  if (!token.scopes.includes(req.method === "GET" ? "read" : "write")) return json({ error: "scope_forbidden" }, 403);

  if (req.method === "GET" && parts.length === 1) {
    const [project, todos, activity] = await Promise.all([
      supabase.from("projects").select("*").eq("id", projectId).eq("owner_id", token.owner_id).single(),
      supabase.from("todos").select("*").eq("project_id", projectId).eq("owner_id", token.owner_id).order("updated_at", { ascending: false }),
      supabase.from("activity_logs").select("*").eq("project_id", projectId).eq("owner_id", token.owner_id).order("created_at", { ascending: false }).limit(30),
    ]);
    if (project.error) return json({ error: "project_not_found" }, 404);
    return json({ project: project.data, todos: todos.data ?? [], activity: activity.data ?? [] });
  }

  if (req.method === "POST" && parts[1] === "todos") {
    const body = await req.json();
    const { data, error } = await supabase.from("todos").insert({ project_id: projectId, owner_id: token.owner_id, title: body.title, description: body.description ?? "", priority: body.priority ?? "normal", created_by: body.created_by ?? "api" }).select().single();
    if (error) return json({ error: error.message }, 400);
    return json(data, 201);
  }

  if (req.method === "PATCH" && parts[1] === "todos" && parts[2]) {
    const body = await req.json();
    const { data, error } = await supabase.from("todos").update(body).eq("id", parts[2]).eq("owner_id", token.owner_id).select().single();
    if (error) return json({ error: error.message }, 400);
    return json(data);
  }

  if (req.method === "PATCH" && parts.length === 1) {
    const body = await req.json();
    const { data, error } = await supabase.from("projects").update(body).eq("id", projectId).eq("owner_id", token.owner_id).select().single();
    if (error) return json({ error: error.message }, 400);
    return json(data);
  }
  return json({ error: "not_found" }, 404);
});
