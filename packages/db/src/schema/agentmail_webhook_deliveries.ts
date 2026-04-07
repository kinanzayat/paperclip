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

export const agentmailWebhookDeliveries = pgTable(
  "agentmail_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id"),
    sourceMailbox: text("source_mailbox"),
    status: text("status").notNull().default("pending"),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    outboundStatus: text("outbound_status"),
    outboundError: text("outbound_error"),
    error: text("error"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("agentmail_webhook_deliveries_company_idx").on(table.companyId),
    statusIdx: index("agentmail_webhook_deliveries_status_idx").on(table.status),
    linkedIssueIdx: index("agentmail_webhook_deliveries_issue_idx").on(table.linkedIssueId),
    messageUniqueIdx: uniqueIndex("agentmail_webhook_deliveries_company_message_idx").on(
      table.companyId,
      table.messageId,
    ),
  }),
);
