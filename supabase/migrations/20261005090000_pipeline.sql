-- The pipeline: analyses become real runs with named stages, files carry what
-- the parser measured, and the database publishes progress as a run moves.
--
-- The pipeline writes with the server-only secret key, because a run outlives
-- the request and the Clerk token that came with it expires in about a
-- minute. So there are still no write grants or write policies for
-- authenticated: reading stays a policy, writing is server code only.

-- The seed rows were stand-ins with no files behind them. Real submissions
-- replace them; the organization rows come back on the first submission.
delete from public.organizations
where id in ('org_3KDwijdOlFiYL8iTPoH6gSZFFHt', 'org_3KDwo6rJcbE5NdgdQntP5OZaabl');

-- "parsing" was the name for any unfinished run. Which step it's on is the
-- stage's job now, so the status just says it's running.
alter type public.analysis_status rename value 'parsing' to 'running';

create type public.analysis_stage as enum ('fetch', 'select', 'parse', 'store');

alter table public.analyses
  -- Last stage entered. On a failed run, the stage it failed in.
  add column stage public.analysis_stage,
  add column stage_message text,
  -- Set when a run (or re-run) begins. A re-run reuses the row, so created_at
  -- can't say how long an unfinished run has been going; staleness is
  -- measured from here.
  add column started_at timestamptz,
  add column adapter text,
  -- The parser's coverage report, minus the skipped-file list: that's the
  -- files table, and storing it twice would let the two disagree.
  add column coverage jsonb,
  -- One analysis per repository. Running it again reuses this row.
  add constraint analyses_project_id_key unique (project_id),
  add constraint analyses_stage_check check ((status = 'queued') = (stage is null)),
  add constraint analyses_started_check check ((status = 'queued') = (started_at is null)),
  add constraint analyses_complete_check check (
    (status = 'complete') = (coverage is not null and adapter is not null and commit_sha is not null)
  );

-- The unique constraint's index serves lookups by project; this one is redundant.
drop index public.analyses_project_id_organization_id_idx;

-- A parsed file has its measurements; a skipped one has a reason and the
-- detail behind it and nothing else, so it can never pass for a file with no
-- imports.
alter table public.files
  add column skip_detail text,
  add column lines integer check (lines >= 0),
  add column hash text,
  add constraint files_parsed_or_skipped_check check (
    case when skip_reason is null
      then skip_detail is null and lines is not null and hash is not null
      else skip_detail is not null and lines is null and hash is null
    end
  );

-- An edge is one (source, target) pair however many ways source imports
-- target; the ways are listed in kinds. Nothing has been written to edges
-- yet, so changing the columns is safe.
alter table public.edges
  drop column kind,
  drop column specifier,
  add column kinds text[] not null check (
    cardinality(kinds) > 0
    and kinds <@ array['import', 're-export', 'dynamic-import', 'require']
  ),
  add constraint edges_source_target_key unique (source_file_id, target_file_id);

-- Live progress. Each analysis has a private broadcast channel,
-- "analysis:<id>", and the database publishes to it when a run moves.

-- The channel pattern is declared here, before anything publishes to it: a
-- private channel with no select policy on realtime.messages accepts the
-- broadcast and delivers it to nobody, silently. This is also who may
-- subscribe. The subquery on analyses runs under that table's own policy, so
-- the topic of another organization's analysis matches no row and the join
-- is refused, exactly as its rows aren't selectable. Topics are compared as
-- text so a malformed topic is refused rather than failing a uuid cast.
create policy "members receive their organization's analysis progress" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1 from public.analyses a
      where 'analysis:' || a.id::text = (select realtime.topic())
    )
  );

-- No insert policy: browsers listen on these channels and never send. Only
-- the trigger below publishes.

-- The stage and its message, not the row. On failure the message is the
-- reason, so a subscriber shows what arrives without interpreting it.
-- Security definer because it runs inside the pipeline's writes, and
-- publishing is the database's act, not the writer's.
create function public.publish_analysis_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'status', new.status,
      'stage', new.stage,
      'message', case when new.status = 'failed' then new.error else new.stage_message end
    ),
    'progress',
    'analysis:' || new.id::text,
    true
  );
  return null;
end;
$$;

revoke execute on function public.publish_analysis_progress() from public, anon, authenticated;

-- On our own table, never on the realtime machinery.
create trigger publish_progress
  after update of status, stage, stage_message, error on public.analyses
  for each row
  when (
    old.status is distinct from new.status
    or old.stage is distinct from new.stage
    or old.stage_message is distinct from new.stage_message
  )
  execute function public.publish_analysis_progress();
