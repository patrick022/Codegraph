-- Which parser output an analysis was stored from. Rows from an older parser
-- have no roles or routes stored, and must say so rather than show an empty
-- route table and every file unclassified as if that had been checked.
-- Everything complete so far predates roles and routes, so it's version 1.
alter table public.analyses add column schema_version integer;
update public.analyses set schema_version = 1 where status = 'complete';
alter table public.analyses
  add constraint analyses_schema_version_check check ((status = 'complete') = (schema_version is not null));

-- Withheld routes, and the declarations left out, live in the coverage report
-- with the rest of what the parser couldn't read.
alter table public.analyses drop column routes_withheld;

alter table public.routes
  add constraint routes_unique_key unique (analysis_id, file_id, method, path);
