# Supabase setup

Run from the repository root.

```bash
npx supabase login
npx supabase link --project-ref peaoudxbyrbwmukedpmk
npx supabase db push
npx supabase secrets set SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
npx supabase functions deploy agent-api --no-verify-jwt
```

Get `SUPABASE_SERVICE_ROLE_KEY` from Supabase Dashboard → Project Settings → API. Do not put it in the browser, GitHub, or chat.

After deployment, open Orbit → Settings → AI agent integration, issue a key, and store it in the agent's environment as `ORBIT_TOKEN`.
