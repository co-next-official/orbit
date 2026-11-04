create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  status text not null default 'planning' check (status in ('planning','active','paused','completed','archived')),
  progress integer not null default 0 check (progress between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.todos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo','in_progress','done','cancelled')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  due_at timestamptz,
  created_by text not null default 'human' check (created_by in ('human','codex','claude','api')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor text not null default 'human',
  action text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  scopes text[] not null default array['read','write'],
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists projects_owner_idx on public.projects(owner_id, updated_at desc);
create index if not exists todos_project_idx on public.todos(project_id, status, updated_at desc);
create index if not exists activity_project_idx on public.activity_logs(project_id, created_at desc);
create index if not exists agent_tokens_hash_idx on public.agent_tokens(token_hash);

alter table public.projects enable row level security;
alter table public.todos enable row level security;
alter table public.activity_logs enable row level security;
alter table public.agent_tokens enable row level security;

create policy "owners manage projects" on public.projects for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owners manage todos" on public.todos for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owners read activity" on public.activity_logs for select using (owner_id = auth.uid());
create policy "owners create activity" on public.activity_logs for insert with check (owner_id = auth.uid());
create policy "owners manage tokens" on public.agent_tokens for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at before update on public.projects for each row execute function public.touch_updated_at();
drop trigger if exists todos_touch_updated_at on public.todos;
create trigger todos_touch_updated_at before update on public.todos for each row execute function public.touch_updated_at();
