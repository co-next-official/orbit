create table if not exists public.todo_external_links (
  id uuid primary key default gen_random_uuid(),
  todo_id uuid not null references public.todos(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('github')),
  external_id text not null,
  url text not null,
  status text not null default 'open' check (status in ('open','closed','unknown')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (todo_id, provider, external_id)
);

create index if not exists todo_external_links_todo_idx
  on public.todo_external_links(todo_id, provider);

alter table public.todo_external_links enable row level security;

drop policy if exists "owners manage todo external links" on public.todo_external_links;
create policy "owners manage todo external links" on public.todo_external_links
  for all
  using (
    owner_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = todo_external_links.project_id and p.owner_id = auth.uid())
    and exists (select 1 from public.todos t where t.id = todo_external_links.todo_id and t.project_id = todo_external_links.project_id and t.owner_id = auth.uid())
  )
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = todo_external_links.project_id and p.owner_id = auth.uid())
    and exists (select 1 from public.todos t where t.id = todo_external_links.todo_id and t.project_id = todo_external_links.project_id and t.owner_id = auth.uid())
  );

drop trigger if exists todo_external_links_touch_updated_at on public.todo_external_links;
create trigger todo_external_links_touch_updated_at
  before update on public.todo_external_links
  for each row execute function public.touch_updated_at();
