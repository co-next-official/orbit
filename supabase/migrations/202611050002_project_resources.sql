create table if not exists public.project_resources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('github')),
  resource_type text not null check (resource_type in ('repository')),
  external_id text not null,
  url text not null,
  name text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, provider, resource_type, external_id)
);

create index if not exists project_resources_project_idx
  on public.project_resources(project_id, provider, resource_type);

alter table public.project_resources enable row level security;

drop policy if exists "owners manage project resources" on public.project_resources;
create policy "owners manage project resources" on public.project_resources
  for all
  using (
    owner_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = project_resources.project_id and p.owner_id = auth.uid())
  )
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = project_resources.project_id and p.owner_id = auth.uid())
  );

drop trigger if exists project_resources_touch_updated_at on public.project_resources;
create trigger project_resources_touch_updated_at
  before update on public.project_resources
  for each row execute function public.touch_updated_at();
