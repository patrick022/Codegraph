-- The agent reads with a credential the app signs: an authenticated token
-- carrying the organization, as a member's does, plus an analysis_id claim.
-- The organization policies already apply to it. These restrictive policies
-- narrow it further to that one analysis, so a prompt-injected request for
-- another analysis returns nothing however it's phrased.
--
-- A member's Clerk token has no analysis_id claim, and for it every one of
-- these is true: members read exactly what they did before.

create policy "an agent credential reads one analysis" on public.analyses
  as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'analysis_id') is null or id = (select (auth.jwt() ->> 'analysis_id')::uuid));

create policy "an agent credential reads one analysis" on public.files
  as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'analysis_id') is null or analysis_id = (select (auth.jwt() ->> 'analysis_id')::uuid));

create policy "an agent credential reads one analysis" on public.edges
  as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'analysis_id') is null or analysis_id = (select (auth.jwt() ->> 'analysis_id')::uuid));

create policy "an agent credential reads one analysis" on public.routes
  as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'analysis_id') is null or analysis_id = (select (auth.jwt() ->> 'analysis_id')::uuid));

create policy "an agent credential reads one analysis" on public.insights
  as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'analysis_id') is null or analysis_id = (select (auth.jwt() ->> 'analysis_id')::uuid));

-- No analysis column: a role belongs to a file, and the files policy above
-- decides which files this subquery can see.
create policy "an agent credential reads one analysis" on public.file_roles
  as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'analysis_id') is null or exists (select 1 from public.files f where f.id = file_roles.file_id));

-- The repository the analysis is of, and no other project of the organization.
create policy "an agent credential reads one analysis" on public.projects
  as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'analysis_id') is null or exists (select 1 from public.analyses a where a.project_id = projects.id));

-- Cached answers are keyed across every analysis of the organization. The
-- agent has no use for them, so it reads none.
create policy "an agent credential reads no cache" on public.ai_cache
  as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'analysis_id') is null);
