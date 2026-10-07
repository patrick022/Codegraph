-- The cache, reshaped: each answer records which task asked it, and the key is
-- unique within an organization rather than across all of them. Nothing has
-- been cached yet, so it's recreated rather than altered.
drop table public.ai_cache;

-- The key is a digest of the task, the prompt version, the pinned model and
-- every input the prompt is built from, so an answer is reused exactly when
-- the question is the same. It outlives re-runs: unchanged files and folders
-- are answered again from here. Scoped to the organization like everything
-- else; the server's writer inserts, members only read.
create table public.ai_cache (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  key text not null,
  task text not null check (task in ('explain-file', 'explain-folder', 'classify-file')),
  model text not null,
  body text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, key)
);

create index on public.ai_cache (organization_id);

revoke all on public.ai_cache from anon, authenticated;
grant select on public.ai_cache to authenticated;

create policy "members read their organization's rows" on public.ai_cache
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));

-- Convention owns the structural roles: they decide the route table and which
-- files read as entry points. A role from the model can only ever be one of
-- the layers or plumbing, and the database refuses anything else.
alter table public.file_roles
  add constraint file_roles_model_roles_check check (
    source = 'convention'
    or role in ('service', 'repository', 'model', 'util', 'config', 'component', 'hook')
  );
