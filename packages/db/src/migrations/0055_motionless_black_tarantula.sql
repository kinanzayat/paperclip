CREATE TABLE "agentmail_outbound_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"delivery_id" uuid,
	"issue_id" uuid,
	"approval_id" uuid,
	"stage" text NOT NULL,
	"recipient" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" text,
	"thread_id" text,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentmail_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text,
	"source_mailbox" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"linked_issue_id" uuid,
	"linked_approval_id" uuid,
	"approval_status" text,
	"outbound_status" text,
	"outbound_message_id" text,
	"outbound_thread_id" text,
	"outbound_recipient" text,
	"outbound_sent_at" timestamp with time zone,
	"outbound_error" text,
	"reply_action" text,
	"error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "company_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"category" text NOT NULL,
	"color" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "issues_open_routine_execution_uq";--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "required_roles" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "approved_by_role_type" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "product_analyzer_email" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "product_owner_email" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "tech_team_email" text;--> statement-breakpoint
ALTER TABLE "agentmail_outbound_notifications" ADD CONSTRAINT "agentmail_outbound_notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_outbound_notifications" ADD CONSTRAINT "agentmail_outbound_notifications_delivery_id_agentmail_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."agentmail_webhook_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_outbound_notifications" ADD CONSTRAINT "agentmail_outbound_notifications_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_outbound_notifications" ADD CONSTRAINT "agentmail_outbound_notifications_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_webhook_deliveries" ADD CONSTRAINT "agentmail_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_webhook_deliveries" ADD CONSTRAINT "agentmail_webhook_deliveries_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_webhook_deliveries" ADD CONSTRAINT "agentmail_webhook_deliveries_linked_approval_id_approvals_id_fk" FOREIGN KEY ("linked_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_statuses" ADD CONSTRAINT "company_statuses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agentmail_outbound_notifications_company_idx" ON "agentmail_outbound_notifications" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agentmail_outbound_notifications_issue_idx" ON "agentmail_outbound_notifications" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "agentmail_outbound_notifications_approval_idx" ON "agentmail_outbound_notifications" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "agentmail_outbound_notifications_stage_idx" ON "agentmail_outbound_notifications" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "agentmail_outbound_notifications_message_idx" ON "agentmail_outbound_notifications" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "agentmail_outbound_notifications_thread_idx" ON "agentmail_outbound_notifications" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "agentmail_webhook_deliveries_company_idx" ON "agentmail_webhook_deliveries" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agentmail_webhook_deliveries_status_idx" ON "agentmail_webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agentmail_webhook_deliveries_issue_idx" ON "agentmail_webhook_deliveries" USING btree ("linked_issue_id");--> statement-breakpoint
CREATE INDEX "agentmail_webhook_deliveries_approval_idx" ON "agentmail_webhook_deliveries" USING btree ("linked_approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agentmail_webhook_deliveries_company_message_idx" ON "agentmail_webhook_deliveries" USING btree ("company_id","message_id");--> statement-breakpoint
CREATE INDEX "company_statuses_company_idx" ON "company_statuses" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_statuses_company_position_idx" ON "company_statuses" USING btree ("company_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "company_statuses_company_slug_idx" ON "company_statuses" USING btree ("company_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null
          and "issues"."completed_at" is null
          and "issues"."cancelled_at" is null;