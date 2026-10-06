-- Framework adapters: each file's role by convention goes in file_roles, and
-- each route the syntax fully states goes in routes. Both tables exist from
-- the first migration, policies included; nothing has written to them yet.

-- The line the route is declared on, so it can be checked against the code.
alter table public.routes
  add column line integer not null check (line >= 1),
  add constraint routes_method_check check (method <> ''),
  add constraint routes_path_check check (path like '/%');

-- Why an adapter that can read routes stored none: a setting that changes
-- every full path. An empty route table with this null means none were found.
alter table public.analyses
  add column routes_withheld text;
