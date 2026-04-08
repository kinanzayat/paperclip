alter table "agentmail_webhook_deliveries"
  add column "linked_approval_id" uuid references "approvals"("id") on delete set null;

alter table "agentmail_webhook_deliveries"
  add column "approval_status" text;

alter table "agentmail_webhook_deliveries"
  add column "outbound_message_id" text;

alter table "agentmail_webhook_deliveries"
  add column "outbound_thread_id" text;

alter table "agentmail_webhook_deliveries"
  add column "outbound_recipient" text;

alter table "agentmail_webhook_deliveries"
  add column "outbound_sent_at" timestamp with time zone;

alter table "agentmail_webhook_deliveries"
  add column "reply_action" text;

create index "agentmail_webhook_deliveries_approval_idx"
  on "agentmail_webhook_deliveries" using btree ("linked_approval_id");
