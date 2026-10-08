-- An agent credential reads no organization row. Its organization is already
-- the claim it carries, and no lookup reads this table, so the members'
-- policy letting it through was an accident rather than a decision.
--
-- A member's Clerk token has no analysis_id claim, and for it this is true.

create policy "an agent credential reads no organization" on public.organizations
  as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'analysis_id') is null);
