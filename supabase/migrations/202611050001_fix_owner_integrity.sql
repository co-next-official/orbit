drop policy if exists "owners manage todos" on public.todos;
create policy "owners manage todos" on public.todos
  for all
  using (
    owner_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = todos.project_id and p.owner_id = auth.uid())
  )
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = todos.project_id and p.owner_id = auth.uid())
  );

drop policy if exists "owners read activity" on public.activity_logs;
create policy "owners read activity" on public.activity_logs
  for select
  using (
    owner_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = activity_logs.project_id and p.owner_id = auth.uid())
  );

drop policy if exists "owners create activity" on public.activity_logs;
create policy "owners create activity" on public.activity_logs
  for insert
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = activity_logs.project_id and p.owner_id = auth.uid())
  );
