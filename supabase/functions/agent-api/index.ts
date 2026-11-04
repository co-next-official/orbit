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
  const parts = url.pathname.split("/").filter(Boolean);
  const projectId = parts[1];
  if (token.project_id && token.project_id !== projectId) return json({ error: "project_forbidden" }, 403);
  if (!token.scopes.includes(req.method === "GET" ? "read" : "write")) return json({ error: "scope_forbidden" }, 403);

  if (req.method === "GET" && parts.length === 2) {
    const [project, todos, activity] = await Promise.all([
      supabase.from("projects").select("*").eq("id", projectId).eq("owner_id", token.owner_id).single(),
      supabase.from("todos").select("*").eq("project_id", projectId).eq("owner_id", token.owner_id).order("updated_at", { ascending: false }),
      supabase.from("activity_logs").select("*").eq("project_id", projectId).eq("owner_id", token.owner_id).order("created_at", { ascending: false }).limit(30),
    ]);
    if (project.error) return json({ error: "project_not_found" }, 404);
    return json({ project: project.data, todos: todos.data ?? [], activity: activity.data ?? [] });
  }

  if (req.method === "POST" && parts[2] === "todos") {
    const body = await req.json();
    const { data, error } = await supabase.from("todos").insert({ project_id: projectId, owner_id: token.owner_id, title: body.title, description: body.description ?? "", priority: body.priority ?? "normal", created_by: body.created_by ?? "api" }).select().single();
    if (error) return json({ error: error.message }, 400);
    return json(data, 201);
  }

  if (req.method === "PATCH" && parts[2] === "todos" && parts[3]) {
    const body = await req.json();
    const { data, error } = await supabase.from("todos").update(body).eq("id", parts[3]).eq("owner_id", token.owner_id).select().single();
    if (error) return json({ error: error.message }, 400);
    return json(data);
  }

  if (req.method === "PATCH" && parts.length === 2) {
    const body = await req.json();
    const { data, error } = await supabase.from("projects").update(body).eq("id", projectId).eq("owner_id", token.owner_id).select().single();
    if (error) return json({ error: error.message }, 400);
    return json(data);
  }
  return json({ error: "not_found" }, 404);
});
