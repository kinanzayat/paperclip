create table "company_statuses" (
  "id" uuid primary key default gen_random_uuid() not null,
  "company_id" uuid not null references "companies"("id") on delete cascade,
  "slug" text not null,
  "label" text not null,
  "category" text not null,
  "color" text not null,
  "position" integer not null default 0,
  "is_default" boolean not null default false,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);
--> statement-breakpoint
create index "company_statuses_company_idx" on "company_statuses" using btree ("company_id");
--> statement-breakpoint
create unique index "company_statuses_company_position_idx" on "company_statuses" using btree ("company_id","position");
--> statement-breakpoint
create unique index "company_statuses_company_slug_idx" on "company_statuses" using btree ("company_id","slug");
--> statement-breakpoint
insert into "company_statuses" ("company_id", "slug", "label", "category", "color", "position", "is_default")
select "id", 'backlog', 'Backlog', 'unstarted', '#64748b', 0, true
from "companies";
--> statement-breakpoint
insert into "company_statuses" ("company_id", "slug", "label", "category", "color", "position", "is_default")
select "id", 'todo', 'Todo', 'unstarted', '#2563eb', 1, false
from "companies";
--> statement-breakpoint
insert into "company_statuses" ("company_id", "slug", "label", "category", "color", "position", "is_default")
select "id", 'in_progress', 'In Progress', 'started', '#8b5cf6', 2, true
from "companies";
--> statement-breakpoint
insert into "company_statuses" ("company_id", "slug", "label", "category", "color", "position", "is_default")
select "id", 'in_review', 'In Review', 'started', '#f59e0b', 3, false
from "companies";
--> statement-breakpoint
insert into "company_statuses" ("company_id", "slug", "label", "category", "color", "position", "is_default")
select "id", 'blocked', 'Blocked', 'blocked', '#ef4444', 4, true
from "companies";
--> statement-breakpoint
insert into "company_statuses" ("company_id", "slug", "label", "category", "color", "position", "is_default")
select "id", 'done', 'Done', 'completed', '#10b981', 5, true
from "companies";
--> statement-breakpoint
insert into "company_statuses" ("company_id", "slug", "label", "category", "color", "position", "is_default")
select "id", 'cancelled', 'Cancelled', 'cancelled', '#6b7280', 6, true
from "companies";
--> statement-breakpoint
drop index if exists "issues_open_routine_execution_uq";
--> statement-breakpoint
create unique index "issues_open_routine_execution_uq"
  on "issues" using btree ("company_id","origin_kind","origin_id")
  where "origin_kind" = 'routine_execution'
    and "origin_id" is not null
    and "hidden_at" is null
    and "execution_run_id" is not null
    and "completed_at" is null
    and "cancelled_at" is null;
