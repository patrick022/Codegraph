-- Nothing creates a real analysis yet, so these stand in. Two organizations,
-- so the dashboard can show that switching changes what comes back. The ids
-- are the real Clerk organizations; rows for any other id are invisible.
insert into public.organizations (id) values
  ('org_3KDwijdOlFiYL8iTPoH6gSZFFHt'), -- Patrick's clerk org
  ('org_3KDwo6rJcbE5NdgdQntP5OZaabl')  -- Test 2nd org
on conflict do nothing;

with p as (
  insert into public.projects (organization_id, repo_owner, repo_name) values
    ('org_3KDwijdOlFiYL8iTPoH6gSZFFHt', 'vercel', 'next.js'),
    ('org_3KDwijdOlFiYL8iTPoH6gSZFFHt', 'shadcn-ui', 'ui'),
    ('org_3KDwijdOlFiYL8iTPoH6gSZFFHt', 'trpc', 'trpc'),
    ('org_3KDwo6rJcbE5NdgdQntP5OZaabl', 'expressjs', 'express'),
    ('org_3KDwo6rJcbE5NdgdQntP5OZaabl', 'remix-run', 'react-router')
  on conflict (organization_id, repo_owner, repo_name) do update set repo_name = excluded.repo_name
  returning id, organization_id, repo_owner, repo_name
)
insert into public.analyses (organization_id, project_id, status, commit_sha, error, created_at, finished_at)
select p.organization_id, p.id, v.status::public.analysis_status, v.commit_sha, v.error,
       now() - v.started, now() - v.finished
from p
join (values
  ('next.js',      'complete', 'a3f9c1e7b2d4085f6e1c9a7b3d2e4f6a8b0c1d2e', null, interval '2 days',   interval '2 days' - interval '4 minutes'),
  ('ui',           'parsing',  '5e8d2c4a1b3f7e9d0c6a2b4e8f1d3c5a7b9e0f2d', null, interval '40 seconds', null),
  ('trpc',         'failed',   null, 'Repository is larger than the parse limit', interval '3 hours', interval '3 hours' - interval '20 seconds'),
  ('express',      'complete', 'c7b1e3d5f9a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0', null, interval '5 hours',  interval '5 hours' - interval '1 minute'),
  ('react-router', 'queued',   null, null, interval '10 seconds', null)
) as v(repo_name, status, commit_sha, error, started, finished)
  on v.repo_name = p.repo_name
-- Re-running the seed returns the same projects, so skip ones already seeded.
where not exists (
  select 1 from public.analyses a
  where a.project_id = p.id
    and a.organization_id = p.organization_id
    and a.status = v.status::public.analysis_status
);
