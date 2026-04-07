import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentmailWebhookDeliveries, companies } from "@paperclipai/db";
import type {
  AgentmailMessage,
  AgentmailRequirementItem,
  AgentmailWebhookBody,
} from "@paperclipai/shared";
import { agentmailMessageSchema } from "@paperclipai/shared";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

type RequirementExtraction = {
  title: string;
  summary: string;
  items: AgentmailRequirementItem[];
  projectReference: string | null;
  targetIssueId?: string | null;
  targetIssueIdentifier?: string | null;
};

type RequirementIssueSnapshot = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
};

function safeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function htmlToText(value: string): string {
  return value
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function findNestedMessageCandidate(root: Record<string, unknown>, maxDepth = 3): Record<string, unknown> | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const record = safeRecord(current.value);
    if (!record || seen.has(record)) continue;
    seen.add(record);

    const hasId = safeText(record.messageId ?? record.message_id ?? record.id ?? record.email_id).length > 0;
    const hasBody = typeof record.textBody === "string"
      || typeof record.text_body === "string"
      || typeof record.text === "string"
      || typeof record.htmlBody === "string"
      || typeof record.html_body === "string";
    const hasEmailShape = record.from !== undefined || record.sender !== undefined || record.from_email !== undefined;

    if (hasId && (hasBody || hasEmailShape)) return record;

    if (current.depth >= maxDepth) continue;
    for (const value of Object.values(record)) {
      if (typeof value === "object" && value !== null) {
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return safeText(entry);
      const obj = safeRecord(entry);
      return safeText(obj?.email ?? obj?.address ?? obj?.value);
    })
    .filter((entry) => entry.length > 0);
}

function readFromSender(value: unknown, fallbackEmail: unknown): { email: string; name?: string } | null {
  const direct = safeRecord(value);
  if (direct) {
    const email = safeText(direct.email ?? direct.address ?? fallbackEmail);
    if (!email) return null;
    const name = safeText(direct.name);
    return name ? { email, name } : { email };
  }

  const asString = safeText(value);
  if (asString) return { email: asString };

  const fallback = safeText(fallbackEmail);
  if (fallback) return { email: fallback };

  return null;
}

function normalizeIncomingMessageShape(payload: AgentmailWebhookBody): Record<string, unknown> | null {
  const root = safeRecord(payload);
  if (!root) return null;

  const nestedMessage = safeRecord(root.message)
    ?? safeRecord(safeRecord(root.data)?.message)
    ?? safeRecord(safeRecord(root.data)?.payload)
    ?? safeRecord(safeRecord(root.event)?.data)
    ?? safeRecord(root.payload)
    ?? safeRecord(root.email)
    ?? findNestedMessageCandidate(root)
    ?? root;

  const messageId = safeText(
    nestedMessage.messageId
      ?? nestedMessage.message_id
      ?? nestedMessage.email_id
      ?? nestedMessage.mail_id
      ?? nestedMessage.inbound_message_id
      ?? nestedMessage.id,
  );
  if (!messageId) return null;

  const from = readFromSender(
    nestedMessage.from ?? nestedMessage.sender,
    nestedMessage.from_email
      ?? nestedMessage.sender_email
      ?? safeRecord(nestedMessage.sender)?.email
      ?? safeRecord(nestedMessage.envelope)?.from,
  );
  const to = readStringArray(
    nestedMessage.to
      ?? nestedMessage.recipients
      ?? safeRecord(nestedMessage.envelope)?.to,
  );
  const cc = readStringArray(nestedMessage.cc);

  return {
    messageId,
    threadId: safeText(nestedMessage.threadId ?? nestedMessage.thread_id) || null,
    subject: safeText(nestedMessage.subject) || null,
    from,
    to,
    cc,
    textBody:
      safeText(
        nestedMessage.textBody
          ?? nestedMessage.text_body
          ?? nestedMessage.text
          ?? nestedMessage.plain_text,
      ) || null,
    htmlBody: safeText(nestedMessage.htmlBody ?? nestedMessage.html_body ?? nestedMessage.html) || null,
    receivedAt:
      safeText(
        nestedMessage.receivedAt
          ?? nestedMessage.received_at
          ?? nestedMessage.created_at
          ?? nestedMessage.sent_at
          ?? nestedMessage.timestamp,
      ) || null,
    fireflies: safeRecord(nestedMessage.fireflies) ?? null,
    requirements: safeRecord(nestedMessage.requirements) ?? null,
  };
}

function normalizeMessage(payload: AgentmailWebhookBody): AgentmailMessage | null {
  const directMessage = agentmailMessageSchema.safeParse(payload);
  if (directMessage.success) return directMessage.data;

  const nestedMessage = (payload as { message?: unknown }).message;
  if (nestedMessage) {
    const parsedNested = agentmailMessageSchema.safeParse(nestedMessage);
    if (parsedNested.success) return parsedNested.data;
  }

  const normalizedShape = normalizeIncomingMessageShape(payload);
  if (normalizedShape) {
    const parsedNormalized = agentmailMessageSchema.safeParse(normalizedShape);
    if (parsedNormalized.success) return parsedNormalized.data;
  }

  return null;
}

function detectIssueIdentifier(subject: string): string | null {
  const match = subject.match(/\b([A-Z]+-\d+)\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function extractProjectReference(subject: string): string | null {
  // Match [Project: ProjectName] or [Project: Project Name] at the start of the subject
  const match = subject.match(/^\s*\[\s*Project\s*:\s*([^\]]+)\s*\]/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

function extractChecklistItems(text: string): AgentmailRequirementItem[] {
  const lines = text.split(/\r?\n/);
  const items: AgentmailRequirementItem[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/^(?:[-*]|\d+[.)]|\[ \])\s+(.+)$/);
    if (!match) continue;
    const title = safeText(match[1]);
    if (!title) continue;
    items.push({ title, priority: "medium" });
    if (items.length >= 8) break;
  }

  return items;
}

function extractRequirements(message: AgentmailMessage): RequirementExtraction {
  const requirements = message.requirements ?? null;
  const subject = safeText(message.subject) || "Meeting follow-up";
  const textBody = safeText(message.textBody);
  const htmlBody = safeText(message.htmlBody);
  const bodyText = textBody || (htmlBody ? htmlToText(htmlBody) : "");

  const summary =
    safeText(requirements?.summary) ||
    (bodyText.length > 700 ? `${bodyText.slice(0, 700)}...` : bodyText) ||
    "No summary provided.";

  const title = safeText(requirements?.title) || subject;
  const items = (requirements?.items ?? []).length > 0
    ? requirements?.items ?? []
    : extractChecklistItems(bodyText);

  // Extract project reference from subject tag [Project: NAME] or from requirements
  const projectReferenceFromSubject = extractProjectReference(subject);
  const projectReferenceFromReqs = safeText(requirements?.projectReference);
  const projectReference: string | null = projectReferenceFromReqs || projectReferenceFromSubject;

  return {
    title,
    summary,
    items,
    projectReference,
    targetIssueId: requirements?.targetIssueId ?? null,
    targetIssueIdentifier: requirements?.targetIssueIdentifier ?? detectIssueIdentifier(subject),
  };
}

export function buildIssueDescription(message: AgentmailMessage, extraction: RequirementExtraction): string {
  const source = message.from?.email ? `Source: ${message.from.email}` : "Source: unknown sender";
  const lines = [
    "# AgentMail Intake",
    `- Source: ${source.replace(/^Source: /, "")}`,
    `- Subject: ${safeText(message.subject) || "(no subject)"}`,
    `- Message ID: ${safeText(message.messageId)}`,
    extraction.projectReference ? `- Project reference: ${extraction.projectReference}` : "- Project reference: none",
    "",
    "## Summary",
    extraction.summary,
  ];

  if (extraction.items.length > 0) {
    lines.push("", "## Requirements", ...extraction.items.map((item) => `- ${item.title}`));
  } else {
    lines.push("", "## Requirements", "- None extracted from the message body.");
  }

  return lines.join("\n");
}

export function buildUpdateComment(message: AgentmailMessage, extraction: RequirementExtraction, createdChildren: string[], updatedChildren: string[]): string {
  const subject = safeText(message.subject) || "(no subject)";
  const sender = safeText(message.from?.email) || "unknown";
  const lines = [
    "AgentMail update received.",
    `Subject: ${subject}`,
    `Sender: ${sender}`,
    "",
    "## Summary",
    extraction.summary,
  ];

  if (createdChildren.length > 0) {
    lines.push("", "## Created sub-issues", ...createdChildren.map((title) => `- ${title}`));
  }
  if (updatedChildren.length > 0) {
    lines.push("", "## Updated sub-issues", ...updatedChildren.map((title) => `- ${title}`));
  }

  return lines.join("\n");
}

export function buildAnalyzerBody(input: {
  issueIdentifier: string;
  issueTitle: string;
  summary: string;
  subIssueTitles: string[];
  createdSubIssueTitles: string[];
  updatedSubIssueTitles: string[];
  sourceMessageId: string;
  projectName: string | null;
  senderEmail: string | null;
}) {
  const lines = [
    `**AgentMail analysis for ${input.issueIdentifier}**`,
    "",
    `- Issue: ${input.issueIdentifier} - ${input.issueTitle}`,
    input.projectName ? `- Project: ${input.projectName}` : "- Project: Company backlog",
    input.senderEmail ? `- Sender: ${input.senderEmail}` : "- Sender: unknown",
    `- Source message: ${input.sourceMessageId}`,
    "",
    "## Summary",
    input.summary,
  ];

  if (input.subIssueTitles.length > 0) {
    lines.push("", "## Generated sub-issues", ...input.subIssueTitles.map((title, idx) => `${idx + 1}. ${title}`));
  }

  if (input.createdSubIssueTitles.length > 0) {
    lines.push("", "## Created this round", ...input.createdSubIssueTitles.map((title) => `- ${title}`));
  }

  if (input.updatedSubIssueTitles.length > 0) {
    lines.push("", "## Updated this round", ...input.updatedSubIssueTitles.map((title) => `- ${title}`));
  }

  lines.push(
    "",
    "## Reply with one of the following",
    "- approve",
    "- reject",
    "- clarify",
    "",
    "If you want changes, reply with the exact correction and I will update the issue tree again.",
  );

  return lines.join("\n");
}

export function buildRequirementPacket(input: {
  issue: RequirementIssueSnapshot | null;
  message: AgentmailMessage;
  extraction: RequirementExtraction;
  resolvedProject: { id: string; name: string } | null;
  createdSubIssueTitles: string[];
  updatedSubIssueTitles: string[];
}) {
  const lines = [
    "# Email Intake",
    `- Message: ${safeText(input.message.messageId)}`,
    input.message.threadId ? `- Thread: ${safeText(input.message.threadId)}` : null,
    `- Sender: ${safeText(input.message.from?.email) || "unknown"}`,
    `- Subject: ${safeText(input.message.subject) || "(no subject)"}`,
    input.resolvedProject ? `- Routed project: ${input.resolvedProject.name}` : "- Routed project: Company backlog",
    input.extraction.projectReference ? `- Requested project: ${input.extraction.projectReference}` : null,
    input.issue ? `- Linked issue: ${input.issue.identifier ?? input.issue.id}` : null,
    "",
    "## Summary",
    input.extraction.summary,
    "",
    "## Requirements",
    ...(input.extraction.items.length > 0
      ? input.extraction.items.map((item, index) => `${index + 1}. ${item.title}`)
      : ["- None extracted from the message body."]),
  ].filter((line): line is string => line !== null);

  if (input.createdSubIssueTitles.length > 0 || input.updatedSubIssueTitles.length > 0) {
    lines.push("");
  }
  if (input.createdSubIssueTitles.length > 0) {
    lines.push("## Created sub-issues", ...input.createdSubIssueTitles.map((title) => `- ${title}`));
  }
  if (input.updatedSubIssueTitles.length > 0) {
    lines.push("", "## Updated sub-issues", ...input.updatedSubIssueTitles.map((title) => `- ${title}`));
  }

  return lines.join("\n");
}

export function normalizeIssueTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function getWebhookEventType(payload: AgentmailWebhookBody): string | null {
  const root = safeRecord(payload);
  const eventType = safeText(root?.event_type ?? root?.eventType ?? safeRecord(root?.event)?.type ?? root?.type);
  return eventType || null;
}

async function resolveOutboundInboxId(apiBaseUrl: string, apiKey: string): Promise<string> {
  const configuredInboxId = process.env.PAPERCLIP_AGENTMAIL_OUTBOUND_INBOX_ID?.trim();
  if (configuredInboxId) return configuredInboxId;

  const listUrl = `${apiBaseUrl.replace(/\/$/, "")}/inboxes?limit=1`;
  const response = await fetch(listUrl, {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`AgentMail inbox lookup failed (${response.status}): ${responseText}`);
  }

  const payload = await response.json() as {
    inboxes?: Array<{ inbox_id?: string }>;
  };

  const inboxId = payload.inboxes?.[0]?.inbox_id?.trim();
  if (!inboxId) {
    throw new Error("AgentMail inbox lookup returned no inboxes. Set PAPERCLIP_AGENTMAIL_OUTBOUND_INBOX_ID.");
  }

  return inboxId;
}

async function sendAgentmailSummary(input: {
  companyId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  summary: string;
  sourceMessageId: string;
  subIssueTitles: string[];
  createdSubIssueTitles: string[];
  updatedSubIssueTitles: string[];
  analyzerEmail: string | null;
  projectName: string | null;
  senderEmail: string | null;
}) {
  const apiKey = process.env.PAPERCLIP_AGENTMAIL_API_KEY?.trim();
  const analyzerEmail = input.analyzerEmail?.trim();
  if (!apiKey || !analyzerEmail) {
    return { status: "skipped" as const, reason: "missing_api_key_or_analyzer_email" as const };
  }

  const baseUrl = process.env.PAPERCLIP_AGENTMAIL_API_BASE_URL?.trim() || "https://api.agentmail.to/v0";
  const inboxId = await resolveOutboundInboxId(baseUrl, apiKey);
  const url = `${baseUrl.replace(/\/$/, "")}/inboxes/${encodeURIComponent(inboxId)}/messages/send`;

  const body = buildAnalyzerBody({
    issueIdentifier: input.issueIdentifier,
    issueTitle: input.issueTitle,
    summary: input.summary,
    sourceMessageId: input.sourceMessageId,
    subIssueTitles: input.subIssueTitles,
    createdSubIssueTitles: input.createdSubIssueTitles,
    updatedSubIssueTitles: input.updatedSubIssueTitles,
    projectName: input.projectName,
    senderEmail: input.senderEmail,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to: analyzerEmail,
      subject: `[Paperclip] ${input.issueIdentifier} requirements summary`,
      text: body,
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`AgentMail send failed (${response.status}): ${responseText}`);
  }

  return { status: "sent" as const };
}

async function resolveProjectFromReference(
  db: Db,
  companyId: string,
  projectReference: string | null,
): Promise<{ id: string; name: string } | null> {
  if (!projectReference) return null;

  const projects = projectService(db);
  const allProjects = await projects.list(companyId);

  // Check if reference is a UUID and matches a project ID directly
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectReference)) {
    const byId = allProjects.find((p) => p.id === projectReference);
    if (byId) return { id: byId.id, name: byId.name };
  }

  // Try case-insensitive exact match by name
  const refLower = projectReference.toLowerCase();
  const byName = allProjects.find((p) => p.name.toLowerCase() === refLower);
  if (byName) return { id: byName.id, name: byName.name };

  // Log warning if project not found
  logger.warn(
    { companyId, projectReference },
    `AgentMail: Project not found for reference "${projectReference}"; issue will be created in company backlog`,
  );

  return null;
}

export function agentmailService(db: Db) {
  const issues = issueService(db);

  return {
    processWebhook: async (companyId: string, payload: AgentmailWebhookBody) => {
      const eventType = getWebhookEventType(payload);
      if (eventType && eventType !== "message.received") {
        logger.info({ companyId, eventType }, "AgentMail webhook ignored: unsupported event type");
        return { status: "ignored" as const, reason: eventType as string };
      }

      const message = normalizeMessage(payload);
      if (!message) {
        logger.warn(
          {
            companyId,
            payloadKeys: Object.keys(safeRecord(payload) ?? {}),
          },
          "AgentMail webhook ignored: unable to normalize message payload",
        );
        return { status: "ignored" as const, reason: "missing_message_payload" as const };
      }

      const messageId = safeText(message.messageId);
      if (!messageId) {
        return { status: "ignored" as const, reason: "missing_message_id" as const };
      }

      const [delivery] = await db
        .insert(agentmailWebhookDeliveries)
        .values({
          companyId,
          messageId,
          threadId: safeText(message.threadId) || null,
          sourceMailbox: safeText(message.from?.email) || null,
          status: "processing",
          payload: payload as Record<string, unknown>,
        })
        .onConflictDoNothing({
          target: [agentmailWebhookDeliveries.companyId, agentmailWebhookDeliveries.messageId],
        })
        .returning({ id: agentmailWebhookDeliveries.id });

      if (!delivery) {
        return { status: "duplicate" as const };
      }

      try {
        const extraction = extractRequirements(message);
        const company = await db
          .select({ productAnalyzerEmail: companies.productAnalyzerEmail })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0] ?? null);

        // Resolve project from reference (subject tag or requirements field)
        const resolvedProject = await resolveProjectFromReference(db, companyId, extraction.projectReference);
        const resolvedProjectId = resolvedProject?.id ?? null;

        let targetIssue = null as Awaited<ReturnType<typeof issues.getById>>;

        if (extraction.targetIssueId) {
          const byId = await issues.getById(extraction.targetIssueId);
          if (byId && byId.companyId === companyId) {
            targetIssue = byId;
          }
        }

        if (!targetIssue && extraction.targetIssueIdentifier) {
          const byIdentifier = await issues.getByIdentifier(extraction.targetIssueIdentifier);
          if (byIdentifier && byIdentifier.companyId === companyId) {
            targetIssue = byIdentifier;
          }
        }

        const existingChildren = targetIssue
          ? await issues.list(companyId, { parentId: targetIssue.id })
          : [];
        const existingChildrenByTitle = new Map(
          existingChildren.map((child) => [normalizeIssueTitle(child.title), child]),
        );

        const createdSubIssueTitles: string[] = [];
        const updatedSubIssueTitles: string[] = [];
        const hadExistingTargetIssue = Boolean(targetIssue);

        if (!targetIssue) {
          const issueData = {
            title: extraction.title,
            description: buildRequirementPacket({
              issue: null,
              message,
              extraction,
              resolvedProject,
              createdSubIssueTitles: [],
              updatedSubIssueTitles: [],
            }),
            createdByUserId: "system-agentmail",
            status: "backlog",
            priority: "medium",
            projectId: resolvedProjectId,
          };
          targetIssue = await issues.create(companyId, issueData);
        } else {
          const nextDescription = buildRequirementPacket({
            issue: {
              id: targetIssue.id,
              identifier: targetIssue.identifier ?? null,
              title: targetIssue.title,
              description: targetIssue.description ?? null,
            },
            message,
            extraction,
            resolvedProject,
            createdSubIssueTitles,
            updatedSubIssueTitles,
          });
          await issues.update(targetIssue.id, {
            description: nextDescription,
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
          });
        }

        for (const item of extraction.items) {
          const nextTitle = safeText(item.title);
          const matchedChild = existingChildrenByTitle.get(normalizeIssueTitle(nextTitle));
          const subIssueData = {
            title: nextTitle,
            description: safeText(item.description) || null,
            parentId: targetIssue.id,
            createdByUserId: "system-agentmail",
            status: "backlog",
            priority: item.priority ?? "medium",
            projectId: resolvedProjectId,
          };

          if (matchedChild) {
            await issues.update(matchedChild.id, {
              title: subIssueData.title,
              description: subIssueData.description,
              priority: subIssueData.priority,
              ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            });
            updatedSubIssueTitles.push(subIssueData.title);
            continue;
          }

          const created = await issues.create(companyId, subIssueData);
          createdSubIssueTitles.push(created.title);
        }

        await issues.update(targetIssue.id, {
          description: buildRequirementPacket({
            issue: {
              id: targetIssue.id,
              identifier: targetIssue.identifier ?? null,
              title: targetIssue.title,
              description: targetIssue.description ?? null,
            },
            message,
            extraction,
            resolvedProject,
            createdSubIssueTitles,
            updatedSubIssueTitles,
          }),
          ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
        });

        if (hadExistingTargetIssue) {
          await issues.addComment(
            targetIssue.id,
            buildUpdateComment(message, extraction, createdSubIssueTitles, updatedSubIssueTitles),
            {
              userId: "system-agentmail",
            },
          );
        }

        const subIssueTitles = [...createdSubIssueTitles, ...updatedSubIssueTitles];

        let outboundStatus: string | null = null;
        let outboundError: string | null = null;
        const sendImmediateSummary =
          process.env.PAPERCLIP_AGENTMAIL_SEND_IMMEDIATE_SUMMARY === "true"
          && !hadExistingTargetIssue;

        if (!sendImmediateSummary) {
          outboundStatus = "deferred_for_agent_analysis";
        } else {
          try {
            const outbound = await sendAgentmailSummary({
              companyId,
              issueId: targetIssue.id,
              issueIdentifier: targetIssue.identifier ?? targetIssue.id,
              issueTitle: targetIssue.title,
              summary: extraction.summary,
              sourceMessageId: messageId,
              subIssueTitles,
              createdSubIssueTitles,
              updatedSubIssueTitles,
              analyzerEmail: company?.productAnalyzerEmail ?? null,
              projectName: resolvedProject?.name ?? null,
              senderEmail: safeText(message.from?.email) || null,
            });
            outboundStatus = outbound.status;
          } catch (err) {
            outboundStatus = "failed";
            outboundError = err instanceof Error ? err.message : String(err);
            logger.warn({ err, companyId, messageId }, "AgentMail outbound summary send failed");
          }
        }

        await db
          .update(agentmailWebhookDeliveries)
          .set({
            status: "processed",
            linkedIssueId: targetIssue.id,
            outboundStatus,
            outboundError,
            processedAt: new Date(),
          })
          .where(and(
            eq(agentmailWebhookDeliveries.id, delivery.id),
            eq(agentmailWebhookDeliveries.companyId, companyId),
          ));

        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "agentmail",
          action: "agentmail.webhook_processed",
          entityType: "issue",
          entityId: targetIssue.id,
          details: {
            messageId,
            subject: safeText(message.subject) || null,
            senderEmail: safeText(message.from?.email) || null,
            projectReference: extraction.projectReference,
            routedProjectId: resolvedProjectId,
            routedProjectName: resolvedProject?.name ?? null,
            summary: extraction.summary,
            requirementItems: extraction.items.map((item) => item.title),
            createdSubIssueTitles,
            updatedSubIssueTitles,
            subIssueCount: subIssueTitles.length,
            outboundStatus,
          },
        });

        return {
          status: "processed" as const,
          issueId: targetIssue.id,
          issueIdentifier: targetIssue.identifier ?? null,
            subIssueCount: subIssueTitles.length,
          outboundStatus,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await db
          .update(agentmailWebhookDeliveries)
          .set({
            status: "failed",
            error: errorMessage,
            processedAt: new Date(),
          })
          .where(eq(agentmailWebhookDeliveries.id, delivery.id));
        throw err;
      }
    },
  };
}
