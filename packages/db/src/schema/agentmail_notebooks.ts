import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agentmailWebhookDeliveries } from "./agentmail_webhook_deliveries.js";

export type AgentmailNotebookSourceMetadata = {
  canonicalSourceId?: string | null;
  attachmentSourceIds?: string[];
  skippedAttachments?: Array<{
    filename: string | null;
    mimeType: string | null;
    byteSize: number | null;
    reason: string;
  }>;
};

export const agentmailNotebooks = pgTable(
  "agentmail_notebooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    deliveryId: uuid("delivery_id").references(() => agentmailWebhookDeliveries.id, { onDelete: "set null" }),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id"),
    notebookId: text("notebook_id"),
    notebookTitle: text("notebook_title"),
    sourceMetadata: jsonb("source_metadata").$type<AgentmailNotebookSourceMetadata>().notNull().default({}),
    syncStatus: text("sync_status").notNull().default("pending"),
    error: text("error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agentmail_notebooks_company_idx").on(table.companyId),
    deliveryIdx: index("agentmail_notebooks_delivery_idx").on(table.deliveryId),
    statusIdx: index("agentmail_notebooks_status_idx").on(table.syncStatus),
    notebookIdx: index("agentmail_notebooks_notebook_idx").on(table.notebookId),
    messageUniqueIdx: uniqueIndex("agentmail_notebooks_company_message_idx").on(
      table.companyId,
      table.messageId,
    ),
  }),
);

export const agentmailNotebookIssueLinks = pgTable(
  "agentmail_notebook_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    notebookRecordId: uuid("notebook_record_id")
      .notNull()
      .references(() => agentmailNotebooks.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agentmail_notebook_issue_links_company_idx").on(table.companyId),
    notebookIdx: index("agentmail_notebook_issue_links_notebook_idx").on(table.notebookRecordId),
    issueIdx: index("agentmail_notebook_issue_links_issue_idx").on(table.issueId),
    issueUniqueIdx: uniqueIndex("agentmail_notebook_issue_links_unique_idx").on(
      table.notebookRecordId,
      table.issueId,
    ),
  }),
);
