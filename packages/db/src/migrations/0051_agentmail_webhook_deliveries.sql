create table "agentmail_webhook_deliveries" (
  "id" uuid primary key default gen_random_uuid() not null,
  "company_id" uuid not null references "companies"("id") on delete cascade,
  "message_id" text not null,
  "thread_id" text,
  "source_mailbox" text,
  "status" text not null default 'pending',
  "linked_issue_id" uuid references "issues"("id") on delete set null,
  "outbound_status" text,
  "outbound_error" text,
  "error" text,
  "payload" jsonb not null default '{}'::jsonb,
  "created_at" timestamp with time zone not null default now(),
  "processed_at" timestamp with time zone
);
--> statement-breakpoint
create index "agentmail_webhook_deliveries_company_idx"
  on "agentmail_webhook_deliveries" using btree ("company_id");
--> statement-breakpoint
create index "agentmail_webhook_deliveries_status_idx"
  on "agentmail_webhook_deliveries" using btree ("status");
--> statement-breakpoint
create index "agentmail_webhook_deliveries_issue_idx"
  on "agentmail_webhook_deliveries" using btree ("linked_issue_id");
--> statement-breakpoint
create unique index "agentmail_webhook_deliveries_company_message_idx"
  on "agentmail_webhook_deliveries" using btree ("company_id", "message_id");
