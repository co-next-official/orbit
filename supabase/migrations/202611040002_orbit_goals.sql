create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  status text not null default 'active' check (status in ('active','paused','converted','archived')),
  project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists goals_owner_idx on public.goals(owner_id, updated_at desc);
alter table public.goals enable row level security;
create policy "owners manage goals" on public.goals for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop trigger if exists goals_touch_updated_at on public.goals;
create trigger goals_touch_updated_at before update on public.goals for each row execute function public.touch_updated_at();
