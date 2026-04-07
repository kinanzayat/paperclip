import { z } from "zod";

export const agentmailRequirementItemSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional().nullable(),
});

export const agentmailRequirementsSchema = z.object({
  targetIssueId: z.string().uuid().optional().nullable(),
  targetIssueIdentifier: z.string().optional().nullable(),
  projectReference: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  action: z.enum(["create", "update", "create_or_update"]).optional().default("create_or_update"),
  items: z.array(agentmailRequirementItemSchema).optional().default([]),
});

export const agentmailMessageSchema = z.object({
  messageId: z.string().min(1),
  threadId: z.string().optional().nullable(),
  subject: z.string().optional().nullable(),
  from: z.object({
    email: z.string().min(1),
    name: z.string().optional().nullable(),
  }).optional().nullable(),
  to: z.array(z.string().min(1)).optional().default([]),
  cc: z.array(z.string().min(1)).optional().default([]),
  textBody: z.string().optional().nullable(),
  htmlBody: z.string().optional().nullable(),
  receivedAt: z.string().datetime().optional().nullable(),
  fireflies: z.record(z.unknown()).optional().nullable(),
  requirements: agentmailRequirementsSchema.optional().nullable(),
}).passthrough();

export const agentmailWebhookEnvelopeSchema = z.object({
  event: z.string().optional(),
  message: z.unknown().optional(),
}).passthrough();

export const agentmailWebhookBodySchema = z.union([
  agentmailMessageSchema,
  agentmailWebhookEnvelopeSchema,
]);

export type AgentmailRequirementItem = z.infer<typeof agentmailRequirementItemSchema>;
export type AgentmailRequirements = z.infer<typeof agentmailRequirementsSchema>;
export type AgentmailMessage = z.infer<typeof agentmailMessageSchema>;
export type AgentmailWebhookBody = z.infer<typeof agentmailWebhookBodySchema>;
