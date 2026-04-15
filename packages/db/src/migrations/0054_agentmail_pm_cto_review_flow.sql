alter table "companies"
  add column "product_owner_email" text;

alter table "companies"
  add column "tech_team_email" text;

update "companies"
set "product_owner_email" = "product_analyzer_email"
where "product_owner_email" is null
  and "product_analyzer_email" is not null;

create table "agentmail_outbound_notifications" (
  "id" uuid primary key default gen_random_uuid() not null,
  "company_id" uuid not null references "companies"("id") on delete cascade,
  "delivery_id" uuid references "agentmail_webhook_deliveries"("id") on delete set null,
  "issue_id" uuid references "issues"("id") on delete set null,
  "approval_id" uuid references "approvals"("id") on delete set null,
  "stage" text not null,
  "recipient" text,
  "status" text not null default 'pending',
  "message_id" text,
  "thread_id" text,
  "sent_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);

create index "agentmail_outbound_notifications_company_idx"
  on "agentmail_outbound_notifications" using btree ("company_id");

create index "agentmail_outbound_notifications_issue_idx"
  on "agentmail_outbound_notifications" using btree ("issue_id");

create index "agentmail_outbound_notifications_approval_idx"
  on "agentmail_outbound_notifications" using btree ("approval_id");

create index "agentmail_outbound_notifications_stage_idx"
  on "agentmail_outbound_notifications" using btree ("stage");

create index "agentmail_outbound_notifications_message_idx"
  on "agentmail_outbound_notifications" using btree ("message_id");

create index "agentmail_outbound_notifications_thread_idx"
  on "agentmail_outbound_notifications" using btree ("thread_id");
