# Supabase setup

Run from the repository root.

```bash
npx supabase login
npx supabase link --project-ref peaoudxbyrbwmukedpmk
npx supabase db push --remote
npx supabase secrets set SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
npx supabase functions deploy agent-api --no-verify-jwt
```

`db push --remote` is important: without it, the CLI tries to connect to a local Supabase stack at `127.0.0.1:54322`.

Get `SUPABASE_SERVICE_ROLE_KEY` from Supabase Dashboard → Project Settings → API. Do not put it in the browser, GitHub, or chat.

After deployment, open Orbit → Settings → AI agent integration, issue a key, and store it in the agent's environment as `ORBIT_TOKEN`.
