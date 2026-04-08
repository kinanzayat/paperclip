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
import { approvals } from "./approvals.js";

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
    linkedApprovalId: uuid("linked_approval_id").references(() => approvals.id, { onDelete: "set null" }),
    approvalStatus: text("approval_status"),
    outboundStatus: text("outbound_status"),
    outboundMessageId: text("outbound_message_id"),
    outboundThreadId: text("outbound_thread_id"),
    outboundRecipient: text("outbound_recipient"),
    outboundSentAt: timestamp("outbound_sent_at", { withTimezone: true }),
    outboundError: text("outbound_error"),
    replyAction: text("reply_action"),
    error: text("error"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("agentmail_webhook_deliveries_company_idx").on(table.companyId),
    statusIdx: index("agentmail_webhook_deliveries_status_idx").on(table.status),
    linkedIssueIdx: index("agentmail_webhook_deliveries_issue_idx").on(table.linkedIssueId),
    linkedApprovalIdx: index("agentmail_webhook_deliveries_approval_idx").on(table.linkedApprovalId),
    messageUniqueIdx: uniqueIndex("agentmail_webhook_deliveries_company_message_idx").on(
      table.companyId,
      table.messageId,
    ),
  }),
);
