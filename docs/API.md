# Orbit Agent API

## Authentication

Use an Orbit token. Never expose the Supabase service-role key to an agent or browser.

```http
Authorization: Bearer orbit_live_xxx
```

## Endpoints

```text
GET   /functions/v1/agent-api/projects
POST  /functions/v1/agent-api/projects
GET   /functions/v1/agent-api/goals
POST  /functions/v1/agent-api/goals          { title, description? }
GET   /functions/v1/agent-api/:project_id
POST  /functions/v1/agent-api/:project_id/todos
POST  /functions/v1/agent-api/:project_id/activity
PATCH /functions/v1/agent-api/:project_id/todos/:todo_id
PATCH /functions/v1/agent-api/:project_id
```

Create a project from PowerShell:

```powershell
$body = @{ name = "Orbit API test"; description = "Created by Claude Code" } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "$env:ORBIT_API/projects" `
  -Headers @{ Authorization = "Bearer $env:ORBIT_TOKEN" } `
  -ContentType "application/json" `
  -Body $body
```

Create a TODO:

```powershell
$body = @{ title = "認証方式を決める"; priority = "high"; created_by = "claude" } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "$env:ORBIT_API/$PROJECT_ID/todos" `
  -Headers @{ Authorization = "Bearer $env:ORBIT_TOKEN" } `
  -ContentType "application/json" `
  -Body $body
```

The project endpoint returns the project, TODOs, and latest activity so Codex and Claude Code can understand the current state before taking the next action.

Record an activity log entry (used by the Claude Code hooks):

```powershell
$body = @{ actor = "claude"; action = "session.summary"; message = "README を更新" } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "$env:ORBIT_API/$PROJECT_ID/activity" `
  -Headers @{ Authorization = "Bearer $env:ORBIT_TOKEN" } `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

`actor` is one of `agent` / `claude` / `codex`. `action` is a short slug (default `agent.note`).

On Windows PowerShell 5.1, send the body as UTF-8 bytes as above, or Japanese text may be garbled.
