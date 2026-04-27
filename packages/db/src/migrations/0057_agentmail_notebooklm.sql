CREATE TABLE "agentmail_notebooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "delivery_id" uuid,
  "message_id" text NOT NULL,
  "thread_id" text,
  "notebook_id" text,
  "notebook_title" text,
  "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sync_status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "last_synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentmail_notebook_issue_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "notebook_record_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agentmail_notebooks" ADD CONSTRAINT "agentmail_notebooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agentmail_notebooks" ADD CONSTRAINT "agentmail_notebooks_delivery_id_agentmail_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."agentmail_webhook_deliveries"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agentmail_notebook_issue_links" ADD CONSTRAINT "agentmail_notebook_issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agentmail_notebook_issue_links" ADD CONSTRAINT "agentmail_notebook_issue_links_notebook_record_id_agentmail_notebooks_id_fk" FOREIGN KEY ("notebook_record_id") REFERENCES "public"."agentmail_notebooks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agentmail_notebook_issue_links" ADD CONSTRAINT "agentmail_notebook_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agentmail_notebooks_company_idx" ON "agentmail_notebooks" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "agentmail_notebooks_delivery_idx" ON "agentmail_notebooks" USING btree ("delivery_id");
--> statement-breakpoint
CREATE INDEX "agentmail_notebooks_status_idx" ON "agentmail_notebooks" USING btree ("sync_status");
--> statement-breakpoint
CREATE INDEX "agentmail_notebooks_notebook_idx" ON "agentmail_notebooks" USING btree ("notebook_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentmail_notebooks_company_message_idx" ON "agentmail_notebooks" USING btree ("company_id","message_id");
--> statement-breakpoint
CREATE INDEX "agentmail_notebook_issue_links_company_idx" ON "agentmail_notebook_issue_links" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "agentmail_notebook_issue_links_notebook_idx" ON "agentmail_notebook_issue_links" USING btree ("notebook_record_id");
--> statement-breakpoint
CREATE INDEX "agentmail_notebook_issue_links_issue_idx" ON "agentmail_notebook_issue_links" USING btree ("issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentmail_notebook_issue_links_unique_idx" ON "agentmail_notebook_issue_links" USING btree ("notebook_record_id","issue_id");
