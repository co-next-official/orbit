# Claude Code integration

`orbit.mjs` connects Claude Code sessions to Orbit.

- **SessionStart hook**: when the working folder is linked to a project, the project's status, open TODOs (with ids) and recent activity are injected into Claude's context, together with rules for updating Orbit.
- **SessionEnd hook**: posts a one-line work summary (first request, number of requests, changed files, commits) to the activity log. Sessions with no file changes or commits are skipped. Resumed sessions only summarize new turns.
- **CLI**: Claude (or you) can update Orbit directly.

```bash
node orbit.mjs projects                      # list projects and ids
node orbit.mjs link <project_id> [--path D]  # link a folder (default: cwd)
node orbit.mjs show
node orbit.mjs todo add "<title>" [--priority high]
node orbit.mjs todo start|done|cancel|reopen <todo_id>
node orbit.mjs progress <0-100> [--status active]
node orbit.mjs note "<message>"
```

Requires `ORBIT_API` and `ORBIT_TOKEN` in the environment. Folder mappings live in `~/.claude/orbit/projects.json` (kept out of the repo). Hook errors never block Claude Code; they are appended to `~/.claude/orbit/error.log`. Set `ORBIT_DRY_RUN=1` to print the SessionEnd payload instead of posting it.

## Hook settings (`~/.claude/settings.json`)

```json
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"<path>/orbit.mjs\" hook session-start", "timeout": 15 }] }],
  "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "node \"<path>/orbit.mjs\" hook session-end", "timeout": 15 }] }]
}
```
