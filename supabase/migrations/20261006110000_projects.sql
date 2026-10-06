-- Projects: an analysis records every project its adapters detected, and each
-- file says what reaches it other than an import.

-- The root and every folder below it whose package.json a framework adapter
-- detected, each with its adapter. One adapter per repository was a single
-- column; a repository can hold several projects. Rows from before keep what
-- they recorded, as the root's. They're all stored by an older parser, so
-- they ask to be re-run rather than load.
alter table public.analyses add column detected_projects jsonb;
update public.analyses
  set detected_projects = jsonb_build_array(jsonb_build_object('path', '.', 'adapter', adapter))
  where adapter is not null;
alter table public.analyses
  drop constraint analyses_complete_check,
  drop column adapter,
  add constraint analyses_complete_check check (
    (status = 'complete') = (coverage is not null and detected_projects is not null and commit_sha is not null)
  );

-- What reaches a parsed file other than an import, in its adapter's words:
-- "Next.js page", "test file, collected by the test runner". A skipped file
-- was never asked.
alter table public.files
  add column reached_by text,
  add constraint files_reached_by_check check (skip_reason is null or reached_by is null);
