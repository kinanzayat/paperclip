import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentmailWebhookDeliveries, companies } from "@paperclipai/db";
import type {
  AgentmailMessage,
  AgentmailRequirementItem,
  AgentmailWebhookBody,
} from "@paperclipai/shared";
import { agentmailMessageSchema } from "@paperclipai/shared";
import { approvalService } from "./approvals.js";
import { agentService } from "./agents.js";
import { heartbeatService } from "./heartbeat.js";
import { issueApprovalService } from "./issue-approvals.js";
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

type RequirementReviewSections = {
  requestedChange: string;
  feasibleNow: string;
  hardOrRiskyParts: string;
  scopeCutsAndTradeoffs: string;
  recommendedRequirement: string;
  proposedIssueBreakdown: string;
};

type RequirementReplyAction = "approve" | "reject" | "edit";

const AGENTMAIL_REQUIREMENT_REVIEW_MARKER = "<!-- paperclip:agentmail-requirement-review -->";
const AGENTMAIL_REQUIREMENT_APPROVAL_TYPE = "agentmail_requirement_confirmation";

const REQUIREMENT_REVIEW_SECTION_KEYS = {
  "requested change": "requestedChange",
  "feasible now": "feasibleNow",
  "hard or risky parts": "hardOrRiskyParts",
  "scope cuts and tradeoffs": "scopeCutsAndTradeoffs",
  "recommended requirement": "recommendedRequirement",
  "proposed issue breakdown": "proposedIssueBreakdown",
} as const satisfies Record<string, keyof RequirementReviewSections>;

function normalizeEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function sameEmail(left: string | null | undefined, right: string | null | undefined) {
  const normalizedLeft = normalizeEmail(left);
  const normalizedRight = normalizeEmail(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function normalizeSectionHeading(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function readMessageBodyText(message: AgentmailMessage) {
  const textBody = safeText(message.textBody);
  if (textBody) return textBody;
  const htmlBody = safeText(message.htmlBody);
  return htmlBody ? htmlToText(htmlBody) : "";
}

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
    inReplyTo: safeText(nestedMessage.inReplyTo ?? nestedMessage.in_reply_to) || null,
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

export function parseRequirementReviewComment(body: string): RequirementReviewSections | null {
  const raw = body.trim();
  if (!raw.includes(AGENTMAIL_REQUIREMENT_REVIEW_MARKER)) return null;

  const withoutMarker = raw.replace(AGENTMAIL_REQUIREMENT_REVIEW_MARKER, "").trim();
  const headerRegex = /^##\s+(.+?)\s*$/gm;
  const matches = Array.from(withoutMarker.matchAll(headerRegex));
  if (matches.length === 0) return null;

  const sections = new Map<keyof RequirementReviewSections, string>();

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match || typeof match.index !== "number") continue;
    const nextMatch = matches[index + 1];
    const header = normalizeSectionHeading(match[1] ?? "");
    const targetKey = REQUIREMENT_REVIEW_SECTION_KEYS[header as keyof typeof REQUIREMENT_REVIEW_SECTION_KEYS];
    if (!targetKey) continue;

    const valueStart = match.index + match[0].length;
    const valueEnd = typeof nextMatch?.index === "number" ? nextMatch.index : withoutMarker.length;
    const sectionBody = withoutMarker.slice(valueStart, valueEnd).trim();
    if (sectionBody.length > 0) {
      sections.set(targetKey, sectionBody);
    }
  }

  const requestedChange = sections.get("requestedChange");
  const feasibleNow = sections.get("feasibleNow");
  const hardOrRiskyParts = sections.get("hardOrRiskyParts");
  const scopeCutsAndTradeoffs = sections.get("scopeCutsAndTradeoffs");
  const recommendedRequirement = sections.get("recommendedRequirement");
  const proposedIssueBreakdown = sections.get("proposedIssueBreakdown");

  if (
    !requestedChange
    || !feasibleNow
    || !hardOrRiskyParts
    || !scopeCutsAndTradeoffs
    || !recommendedRequirement
    || !proposedIssueBreakdown
  ) {
    return null;
  }

  return {
    requestedChange,
    feasibleNow,
    hardOrRiskyParts,
    scopeCutsAndTradeoffs,
    recommendedRequirement,
    proposedIssueBreakdown,
  };
}

export function resolveRequirementReplyAction(
  message: AgentmailMessage,
  options?: { assumeEditOnFreeformReply?: boolean },
): RequirementReplyAction | null {
  const bodyText = readMessageBodyText(message);
  const subjectText = safeText(message.subject).toLowerCase();
  const firstLine = bodyText
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .find((line) => line.length > 0)
    ?? "";
  const normalizedBody = bodyText.trim().toLowerCase();
  const candidate = firstLine || normalizedBody || subjectText;

  if (/^approve(d)?\b/.test(candidate) || /\bapprove\b/.test(subjectText)) {
    return "approve";
  }
  if (/^reject(ed|ion)?\b/.test(candidate) || /\breject\b/.test(subjectText)) {
    return "reject";
  }
  if (/^(edit|clarify|revise|revision|change)\b/.test(candidate) || /\bclarify\b/.test(candidate)) {
    return "edit";
  }
  if (options?.assumeEditOnFreeformReply && candidate.length > 0) {
    return "edit";
  }
  return null;
}

function buildRequirementApprovalPayload(input: {
  issue: RequirementIssueSnapshot;
  message: AgentmailMessage;
  review: RequirementReviewSections;
  reviewerAgentId: string;
  reviewerAgentName: string;
  reviewCommentId: string;
  projectName: string | null;
}) {
  return {
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier ?? input.issue.id,
    issueTitle: input.issue.title,
    sourceMessageId: safeText(input.message.messageId),
    sourceThreadId: safeText(input.message.threadId) || null,
    senderEmail: safeText(input.message.from?.email) || null,
    reviewerAgentId: input.reviewerAgentId,
    reviewerAgentName: input.reviewerAgentName,
    reviewCommentId: input.reviewCommentId,
    projectName: input.projectName,
    replyActionHint: "approve / reject / edit",
    requestedChange: input.review.requestedChange,
    feasibleNow: input.review.feasibleNow,
    hardOrRiskyParts: input.review.hardOrRiskyParts,
    scopeCutsAndTradeoffs: input.review.scopeCutsAndTradeoffs,
    recommendedRequirement: input.review.recommendedRequirement,
    proposedIssueBreakdown: input.review.proposedIssueBreakdown,
  } satisfies Record<string, unknown>;
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
    "Execution remains gated until Product Analyzer review and email confirmation are complete.",
    "No implementation sub-issues are created from AgentMail intake until the requirement is approved.",
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
  sourceMessageId: string;
  projectName: string | null;
  senderEmail: string | null;
  review: RequirementReviewSections;
}) {
  const lines = [
    `**Requirement review for ${input.issueIdentifier}**`,
    "",
    `- Issue: ${input.issueIdentifier} - ${input.issueTitle}`,
    input.projectName ? `- Project: ${input.projectName}` : "- Project: Company backlog",
    input.senderEmail ? `- Sender: ${input.senderEmail}` : "- Sender: unknown",
    `- Source message: ${input.sourceMessageId}`,
    "",
    "## Requested Change",
    input.review.requestedChange,
    "",
    "## Feasible Now",
    input.review.feasibleNow,
    "",
    "## Hard Or Risky Parts",
    input.review.hardOrRiskyParts,
    "",
    "## Scope Cuts And Tradeoffs",
    input.review.scopeCutsAndTradeoffs,
    "",
    "## Recommended Requirement",
    input.review.recommendedRequirement,
    "",
    "## Proposed Issue Breakdown",
    input.review.proposedIssueBreakdown,
  ];

  lines.push(
    "",
    "## Reply with one of the following",
    "- approve",
    "- reject",
    "- edit",
    "",
    "If you want changes, reply with `edit` and the exact correction.",
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
    "- Execution gate: Product Analyzer review and email confirmation are required before implementation starts.",
    "- Implementation sub-issues are intentionally deferred until the requirement is approved.",
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
  issueIdentifier: string;
  issueTitle: string;
  sourceMessageId: string;
  analyzerEmail: string | null;
  projectName: string | null;
  senderEmail: string | null;
  review: RequirementReviewSections;
}) {
  const apiKey = process.env.PAPERCLIP_AGENTMAIL_API_KEY?.trim();
  const analyzerEmail = input.analyzerEmail?.trim();
  if (!apiKey || !analyzerEmail) {
    return {
      status: "skipped" as const,
      reason: "missing_api_key_or_analyzer_email" as const,
      messageId: null,
      threadId: null,
      recipient: analyzerEmail ?? null,
    };
  }

  const baseUrl = process.env.PAPERCLIP_AGENTMAIL_API_BASE_URL?.trim() || "https://api.agentmail.to/v0";
  const inboxId = await resolveOutboundInboxId(baseUrl, apiKey);
  const url = `${baseUrl.replace(/\/$/, "")}/inboxes/${encodeURIComponent(inboxId)}/messages/send`;

  const body = buildAnalyzerBody({
    issueIdentifier: input.issueIdentifier,
    issueTitle: input.issueTitle,
    sourceMessageId: input.sourceMessageId,
    projectName: input.projectName,
    senderEmail: input.senderEmail,
    review: input.review,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to: analyzerEmail,
      subject: `[Paperclip] ${input.issueIdentifier} requirement confirmation`,
      text: body,
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`AgentMail send failed (${response.status}): ${responseText}`);
  }

  const responseText = await response.text();
  let parsed: Record<string, unknown> | null = null;
  if (responseText.trim().length > 0) {
    try {
      parsed = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  return {
    status: "sent" as const,
    reason: null,
    recipient: analyzerEmail,
    messageId: safeText(parsed?.message_id ?? parsed?.messageId ?? parsed?.id) || null,
    threadId: safeText(parsed?.thread_id ?? parsed?.threadId) || null,
  };
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

function isActiveAgentStatus(status: string) {
  return status !== "paused" && status !== "terminated" && status !== "pending_approval";
}

function pickProductAnalyzerAgent(
  availableAgents: Array<{ id: string; name: string; role: string; status: string }>,
  assigneeAgentId: string | null,
) {
  const active = availableAgents.filter((agent) => isActiveAgentStatus(agent.status));
  if (assigneeAgentId) {
    const assigned = active.find((agent) => agent.id === assigneeAgentId && agent.role === "product_analyzer");
    if (assigned) return assigned;
  }
  return active.find((agent) => agent.role === "product_analyzer") ?? null;
}

function pickImplementationLead(
  availableAgents: Array<{ id: string; name: string; role: string; status: string }>,
) {
  const active = availableAgents.filter((agent) => isActiveAgentStatus(agent.status));
  return active.find((agent) => agent.role === "ceo") ?? null;
}

function buildRequirementReplyComment(input: {
  action: RequirementReplyAction;
  senderEmail: string | null;
  messageId: string;
  note: string | null;
}) {
  const actionLabel =
    input.action === "approve"
      ? "approved"
      : input.action === "reject"
        ? "rejected"
        : "requested edits";
  const lines = [
    `AgentMail requirement reply ${actionLabel}.`,
    `Sender: ${input.senderEmail ?? "unknown"}`,
    `Reply message: ${input.messageId}`,
  ];
  if (input.note) {
    lines.push("", input.note);
  }
  return lines.join("\n");
}

function buildRequirementApprovalComment(input: {
  action: RequirementReplyAction;
  senderEmail: string | null;
  messageId: string;
  note: string | null;
}) {
  const actionLabel =
    input.action === "approve"
      ? "approve"
      : input.action === "reject"
        ? "reject"
        : "edit";
  const lines = [
    `AgentMail reply received: ${actionLabel}`,
    `Sender: ${input.senderEmail ?? "unknown"}`,
    `Message: ${input.messageId}`,
  ];
  if (input.note) {
    lines.push("", input.note);
  }
  return lines.join("\n");
}

export function agentmailService(db: Db) {
  const issues = issueService(db);
  const approvalsSvc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const agentsSvc = agentService(db);
  const heartbeat = heartbeatService(db);

  async function getCompanySettings(companyId: string) {
    return db
      .select({ productAnalyzerEmail: companies.productAnalyzerEmail })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestIssueDelivery(companyId: string, issueId: string) {
    return db
      .select()
      .from(agentmailWebhookDeliveries)
      .where(and(
        eq(agentmailWebhookDeliveries.companyId, companyId),
        eq(agentmailWebhookDeliveries.linkedIssueId, issueId),
      ))
      .orderBy(desc(agentmailWebhookDeliveries.createdAt))
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestRequirementApprovalForIssue(issueId: string) {
    const linkedApprovals = await issueApprovalsSvc.listApprovalsForIssue(issueId);
    return linkedApprovals.find((approval) => approval.type === AGENTMAIL_REQUIREMENT_APPROVAL_TYPE) ?? null;
  }

  async function findMatchingReplyDelivery(companyId: string, message: AgentmailMessage) {
    const threadId = safeText(message.threadId) || null;
    const passthrough = message as Record<string, unknown>;
    const inReplyTo = safeText(passthrough.inReplyTo ?? passthrough.in_reply_to) || null;
    const senderEmail = safeText(message.from?.email) || null;
    const correlationFilters = [];

    if (threadId) {
      correlationFilters.push(eq(agentmailWebhookDeliveries.outboundThreadId, threadId));
      correlationFilters.push(eq(agentmailWebhookDeliveries.threadId, threadId));
    }
    if (inReplyTo) {
      correlationFilters.push(eq(agentmailWebhookDeliveries.outboundMessageId, inReplyTo));
    }
    if (correlationFilters.length === 0) return null;

    const candidates = await db
      .select()
      .from(agentmailWebhookDeliveries)
      .where(and(
        eq(agentmailWebhookDeliveries.companyId, companyId),
        isNotNull(agentmailWebhookDeliveries.linkedApprovalId),
        or(...correlationFilters),
      ))
      .orderBy(desc(agentmailWebhookDeliveries.createdAt));

    for (const candidate of candidates) {
      if (
        senderEmail
        && candidate.outboundRecipient
        && !sameEmail(senderEmail, candidate.outboundRecipient)
      ) {
        continue;
      }
      if (!candidate.linkedApprovalId) continue;
      const approval = await approvalsSvc.getById(candidate.linkedApprovalId);
      if (!approval || approval.type !== AGENTMAIL_REQUIREMENT_APPROVAL_TYPE) continue;
      if (approval.status !== "pending" && approval.status !== "revision_requested") continue;
      return { delivery: candidate, approval };
    }

    return null;
  }

  async function queueAgentWakeup(
    agentId: string,
    input: {
      reason: string;
      issueId: string;
      approvalId?: string | null;
      requestedByActorType: "user" | "agent" | "system";
      requestedByActorId: string;
      payload?: Record<string, unknown>;
      source: string;
    },
  ) {
    try {
      return await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: input.reason,
        payload: {
          issueId: input.issueId,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
          ...(input.payload ?? {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId: input.issueId,
          taskId: input.issueId,
          source: input.source,
          wakeReason: input.reason,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
      });
    } catch (err) {
      logger.warn({ err, agentId, issueId: input.issueId, reason: input.reason }, "AgentMail wakeup failed");
      return null;
    }
  }

  async function applyRequirementApprovalDecision(input: {
    approvalId: string;
    action: RequirementReplyAction;
    actorType: "user" | "agent" | "system";
    actorId: string;
    senderEmail: string | null;
    sourceMessageId: string;
    note: string | null;
  }) {
    const approval = await approvalsSvc.getById(input.approvalId);
    if (!approval || approval.type !== AGENTMAIL_REQUIREMENT_APPROVAL_TYPE) return null;

    const payload = (typeof approval.payload === "object" && approval.payload !== null
      ? approval.payload
      : {}) as Record<string, unknown>;
    const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
    if (!issueId) return null;

    const issue = await issues.getById(issueId);
    if (!issue || issue.companyId !== approval.companyId) return null;

    const availableAgents = await agentsSvc.list(approval.companyId);
    const analyzerAgentId = typeof payload.reviewerAgentId === "string" ? payload.reviewerAgentId : null;
    const analyzerAgent =
      (analyzerAgentId ? availableAgents.find((agent) => agent.id === analyzerAgentId) ?? null : null)
      ?? pickProductAnalyzerAgent(
        availableAgents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          status: agent.status,
        })),
        issue.assigneeAgentId ?? null,
      );
    const implementationLead = pickImplementationLead(
      availableAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
      })),
    );

    await approvalsSvc.addComment(
      approval.id,
      buildRequirementApprovalComment({
        action: input.action,
        senderEmail: input.senderEmail,
        messageId: input.sourceMessageId,
        note: input.note,
      }),
      { userId: "system-agentmail" },
    );

    if (input.action === "approve") {
      await issues.update(issue.id, {
        status: "todo",
        assigneeAgentId: implementationLead?.id ?? null,
      });
      await issues.addComment(
        issue.id,
        buildRequirementReplyComment({
          action: input.action,
          senderEmail: input.senderEmail,
          messageId: input.sourceMessageId,
          note: input.note,
        }),
        { userId: "system-agentmail" },
      );

      if (implementationLead) {
        await queueAgentWakeup(implementationLead.id, {
          reason: "agentmail_requirement_approved",
          issueId: issue.id,
          approvalId: approval.id,
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          payload: {
            sourceMessageId: input.sourceMessageId,
            senderEmail: input.senderEmail,
          },
          source: "agentmail.approval.approved",
        });
      }
    } else {
      await issues.update(issue.id, {
        status: "blocked",
        assigneeAgentId: analyzerAgent?.id ?? null,
      });
      await issues.addComment(
        issue.id,
        buildRequirementReplyComment({
          action: input.action,
          senderEmail: input.senderEmail,
          messageId: input.sourceMessageId,
          note: input.note,
        }),
        { userId: "system-agentmail" },
      );

      if (analyzerAgent) {
        await queueAgentWakeup(analyzerAgent.id, {
          reason:
            input.action === "edit"
              ? "agentmail_requirement_revision_requested"
              : "agentmail_requirement_rejected",
          issueId: issue.id,
          approvalId: approval.id,
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          payload: {
            sourceMessageId: input.sourceMessageId,
            senderEmail: input.senderEmail,
            replyAction: input.action,
          },
          source: "agentmail.approval.feedback",
        });
      }
    }

    await db
      .update(agentmailWebhookDeliveries)
      .set({
        approvalStatus: approval.status,
        replyAction: input.action,
      })
      .where(and(
        eq(agentmailWebhookDeliveries.companyId, approval.companyId),
        eq(agentmailWebhookDeliveries.linkedApprovalId, approval.id),
      ));

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: "agentmail.requirement_reply_processed",
      entityType: "issue",
      entityId: issue.id,
      details: {
        issueId: issue.id,
        approvalId: approval.id,
        replyAction: input.action,
        approvalStatus: approval.status,
        senderEmail: input.senderEmail,
        sourceMessageId: input.sourceMessageId,
        analyzerAgentId: analyzerAgent?.id ?? null,
        implementationLeadAgentId: implementationLead?.id ?? null,
      },
    });

    return {
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
      approvalId: approval.id,
      approvalStatus: approval.status,
      analyzerAgentId: analyzerAgent?.id ?? null,
      implementationLeadAgentId: implementationLead?.id ?? null,
    };
  }

  return {
    handleRequirementReviewComment: async (input: {
      issueId: string;
      commentId: string;
      commentBody: string;
      authorAgentId: string;
    }) => {
      const review = parseRequirementReviewComment(input.commentBody);
      if (!review) {
        return { status: "ignored" as const, reason: "missing_requirement_review_marker" as const };
      }

      const issue = await issues.getById(input.issueId);
      if (!issue) {
        return { status: "ignored" as const, reason: "issue_not_found" as const };
      }

      const reviewer = await agentsSvc.getById(input.authorAgentId);
      if (!reviewer || reviewer.companyId !== issue.companyId || reviewer.role !== "product_analyzer") {
        return { status: "ignored" as const, reason: "unauthorized_reviewer" as const };
      }

      const latestDelivery = await getLatestIssueDelivery(issue.companyId, issue.id);
      if (!latestDelivery) {
        return { status: "ignored" as const, reason: "missing_agentmail_delivery" as const };
      }

      const company = await getCompanySettings(issue.companyId);
      const latestApproval = await getLatestRequirementApprovalForIssue(issue.id);
      const approvalPayload = buildRequirementApprovalPayload({
        issue: {
          id: issue.id,
          identifier: issue.identifier ?? null,
          title: issue.title,
          description: issue.description ?? null,
        },
        message: normalizeMessage(latestDelivery.payload as AgentmailWebhookBody) ?? {
          messageId: latestDelivery.messageId,
          threadId: latestDelivery.threadId,
          subject: issue.title,
          from: latestDelivery.sourceMailbox ? { email: latestDelivery.sourceMailbox } : null,
          to: [],
          cc: [],
          textBody: null,
          htmlBody: null,
          receivedAt: null,
          fireflies: null,
          requirements: null,
        },
        review,
        reviewerAgentId: reviewer.id,
        reviewerAgentName: reviewer.name,
        reviewCommentId: input.commentId,
        projectName: null,
      });

      let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
      if (latestApproval?.status === "pending") {
        return { status: "ignored" as const, reason: "approval_already_pending" as const };
      }
      if (latestApproval?.status === "revision_requested") {
        approval = await approvalsSvc.resubmit(latestApproval.id, approvalPayload);
      } else {
        approval = await approvalsSvc.create(issue.companyId, {
          type: AGENTMAIL_REQUIREMENT_APPROVAL_TYPE,
          requestedByAgentId: null,
          requestedByUserId: null,
          status: "pending",
          payload: approvalPayload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: new Date(),
        });
        await issueApprovalsSvc.link(issue.id, approval.id, { agentId: reviewer.id, userId: null });
      }
      if (!approval) {
        return { status: "ignored" as const, reason: "approval_creation_failed" as const };
      }

      let outboundStatus: string | null = null;
      let outboundError: string | null = null;
      let outboundMessageId: string | null = null;
      let outboundThreadId: string | null = null;
      let outboundRecipient: string | null = null;
      try {
        const outbound = await sendAgentmailSummary({
          companyId: issue.companyId,
          issueIdentifier: issue.identifier ?? issue.id,
          issueTitle: issue.title,
          sourceMessageId: latestDelivery.messageId,
          analyzerEmail: company?.productAnalyzerEmail ?? null,
          projectName: null,
          senderEmail: safeText((approvalPayload as Record<string, unknown>).senderEmail) || null,
          review,
        });
        outboundStatus =
          outbound.status === "skipped"
            ? `skipped_${outbound.reason}`
            : outbound.status;
        outboundMessageId = outbound.messageId ?? null;
        outboundThreadId = outbound.threadId ?? null;
        outboundRecipient = outbound.recipient ?? null;
      } catch (err) {
        outboundStatus = "failed";
        outboundError = err instanceof Error ? err.message : String(err);
        logger.warn({ err, issueId: issue.id, approvalId: approval.id }, "AgentMail requirement review send failed");
      }

      await issues.update(issue.id, {
        status: "blocked",
        assigneeAgentId: reviewer.id,
      });

      await db
        .update(agentmailWebhookDeliveries)
        .set({
          linkedApprovalId: approval.id,
          approvalStatus: approval.status,
          outboundStatus,
          outboundMessageId,
          outboundThreadId,
          outboundRecipient,
          outboundSentAt: outboundStatus === "sent" ? new Date() : null,
          outboundError,
        })
        .where(and(
          eq(agentmailWebhookDeliveries.id, latestDelivery.id),
          eq(agentmailWebhookDeliveries.companyId, issue.companyId),
        ));

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "agentmail",
        action: "agentmail.requirement_review_sent",
        entityType: "issue",
        entityId: issue.id,
        details: {
          issueId: issue.id,
          approvalId: approval.id,
          approvalStatus: approval.status,
          reviewerAgentId: reviewer.id,
          reviewerAgentName: reviewer.name,
          outboundStatus,
          outboundRecipient,
          outboundMessageId,
          outboundThreadId,
        },
      });

      return {
        status: "processed" as const,
        issueId: issue.id,
        approvalId: approval.id,
        outboundStatus,
      };
    },

    onApprovalApproved: async (input: {
      approvalId: string;
      actorType: "user" | "agent" | "system";
      actorId: string;
      senderEmail?: string | null;
      sourceMessageId?: string | null;
      note?: string | null;
    }) =>
      applyRequirementApprovalDecision({
        approvalId: input.approvalId,
        action: "approve",
        actorType: input.actorType,
        actorId: input.actorId,
        senderEmail: input.senderEmail ?? null,
        sourceMessageId: input.sourceMessageId ?? input.approvalId,
        note: input.note ?? null,
      }),

    onApprovalRejected: async (input: {
      approvalId: string;
      actorType: "user" | "agent" | "system";
      actorId: string;
      senderEmail?: string | null;
      sourceMessageId?: string | null;
      note?: string | null;
      action?: RequirementReplyAction;
    }) =>
      applyRequirementApprovalDecision({
        approvalId: input.approvalId,
        action: input.action ?? "reject",
        actorType: input.actorType,
        actorId: input.actorId,
        senderEmail: input.senderEmail ?? null,
        sourceMessageId: input.sourceMessageId ?? input.approvalId,
        note: input.note ?? null,
      }),

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
        const replyContext = await findMatchingReplyDelivery(companyId, message);
        if (replyContext) {
          const action =
            resolveRequirementReplyAction(message, { assumeEditOnFreeformReply: true })
            ?? "edit";
          const note = readMessageBodyText(message) || null;
          let replyResult = null;

          if (action === "approve") {
            const resolved = await approvalsSvc.approve(replyContext.approval.id, "agentmail", note);
            if (resolved.applied) {
              replyResult = await applyRequirementApprovalDecision({
                approvalId: resolved.approval.id,
                action,
                actorType: "system",
                actorId: "agentmail",
                senderEmail: safeText(message.from?.email) || null,
                sourceMessageId: messageId,
                note,
              });
            }
          } else if (action === "reject") {
            const resolved = await approvalsSvc.reject(replyContext.approval.id, "agentmail", note);
            if (resolved.applied) {
              replyResult = await applyRequirementApprovalDecision({
                approvalId: resolved.approval.id,
                action,
                actorType: "system",
                actorId: "agentmail",
                senderEmail: safeText(message.from?.email) || null,
                sourceMessageId: messageId,
                note,
              });
            }
          } else if (action === "edit") {
            const resolvedApproval =
              replyContext.approval.status === "revision_requested"
                ? replyContext.approval
                : await approvalsSvc.requestRevision(replyContext.approval.id, "agentmail", note);
            replyResult = await applyRequirementApprovalDecision({
              approvalId: resolvedApproval.id,
              action,
              actorType: "system",
              actorId: "agentmail",
              senderEmail: safeText(message.from?.email) || null,
              sourceMessageId: messageId,
              note,
            });
          }

          await db
            .update(agentmailWebhookDeliveries)
            .set({
              status: "processed",
              linkedIssueId: replyResult?.issueId ?? replyContext.delivery.linkedIssueId,
              linkedApprovalId: replyContext.approval.id,
              approvalStatus: (
                await approvalsSvc.getById(replyContext.approval.id)
              )?.status ?? replyContext.approval.status,
              replyAction: action,
              outboundStatus: "reply_processed",
              processedAt: new Date(),
            })
            .where(and(
              eq(agentmailWebhookDeliveries.id, delivery.id),
              eq(agentmailWebhookDeliveries.companyId, companyId),
            ));

          return {
            status: "reply_processed" as const,
            issueId: replyResult?.issueId ?? replyContext.delivery.linkedIssueId ?? null,
            approvalId: replyContext.approval.id,
            replyAction: action,
          };
        }

        const extraction = extractRequirements(message);
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
        const outboundStatus = "awaiting_requirement_review";

        await db
          .update(agentmailWebhookDeliveries)
          .set({
            status: "processed",
            linkedIssueId: targetIssue.id,
            outboundStatus,
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
            threadId: safeText(message.threadId) || null,
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
            approvalStatus: null,
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
