import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { approvals } from "./approvals.js";
import { agentmailWebhookDeliveries } from "./agentmail_webhook_deliveries.js";

export const agentmailOutboundNotifications = pgTable(
  "agentmail_outbound_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    deliveryId: uuid("delivery_id").references(() => agentmailWebhookDeliveries.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    stage: text("stage").notNull(),
    recipient: text("recipient"),
    status: text("status").notNull().default("pending"),
    messageId: text("message_id"),
    threadId: text("thread_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agentmail_outbound_notifications_company_idx").on(table.companyId),
    issueIdx: index("agentmail_outbound_notifications_issue_idx").on(table.issueId),
    approvalIdx: index("agentmail_outbound_notifications_approval_idx").on(table.approvalId),
    stageIdx: index("agentmail_outbound_notifications_stage_idx").on(table.stage),
    messageIdx: index("agentmail_outbound_notifications_message_idx").on(table.messageId),
    threadIdx: index("agentmail_outbound_notifications_thread_idx").on(table.threadId),
  }),
);
