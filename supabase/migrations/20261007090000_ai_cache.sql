-- The AI cache: every model answer, keyed on the content of what was asked
-- about. Not hung off a file row, because a re-run deletes and re-creates every
-- file, and an unchanged file must still hit its cached answer afterwards.
--
-- explanations was keyed by file_id for exactly that reason it can't be, and
-- nothing ever wrote to it, so it goes.
drop table public.explanations;

create table public.ai_cache (
  -- sha256 over the organization, the pinned model, the prompt and the input.
  -- The organization is in the key, so one organization's row can never answer
  -- another's lookup even from the server's writer; the model is in it, so
  -- re-pinning one invalidates only that model's answers.
  key text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  model text not null,
  value jsonb not null,
  created_at timestamptz not null default now()
);

create index on public.ai_cache (organization_id);

-- Read like everything else; written only by the server's secret key, which
-- writes no matter the policy.
revoke all on public.ai_cache from anon, authenticated;
grant select on public.ai_cache to authenticated;

create policy "members read their organization's rows" on public.ai_cache
  for select to authenticated
  using (organization_id = (select coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')));
