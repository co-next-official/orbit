# Orbit Agent API

## Authentication

Use a project-scoped Orbit token. Never expose the Supabase service-role key to an agent or browser.

```http
Authorization: Bearer orbit_live_xxx
```

## Endpoints

```text
GET   /functions/v1/agent-api/:project_id
POST  /functions/v1/agent-api/:project_id/todos
PATCH /functions/v1/agent-api/:project_id/todos/:todo_id
PATCH /functions/v1/agent-api/:project_id
```

Create a TODO:

```bash
curl -X POST "$ORBIT_API/functions/v1/agent-api/$PROJECT_ID/todos" \
  -H "Authorization: Bearer $ORBIT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"認証方式を決める","priority":"high","created_by":"claude"}'
```

The project endpoint returns the project, TODOs, and the latest activity log in one response so Codex and Claude Code can understand the current state before taking the next action.
