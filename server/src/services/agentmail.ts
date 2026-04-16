import { and, desc, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentmailOutboundNotifications, agentmailWebhookDeliveries, companies } from "@paperclipai/db";
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
  rawSubject: string;
  canonicalSubject: string;
  targetIssueId?: string | null;
  targetIssueIdentifier?: string | null;
};

type RequirementIssueSnapshot = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
};

type PmClarificationSections = {
  ownerSummary: string;
  followUpQuestions: string;
  recommendedRequirement: string;
  notesForTech: string;
};

type CtoIntakeSections = {
  repoSummary: string;
  implementationConstraints: string;
  pmFollowUp: string;
  recommendedRequirement: string;
};

type CeoApprovalSections = {
  decision: string;
  rationale: string;
  notesForCto: string;
};

type TechReviewSections = {
  fitsCurrentCode: string;
  openQuestions: string;
  redFlags: string;
  implementationNotes: string;
};

type ReviewDecisionAction = "approve" | "reject" | "edit";

type AgentmailNotificationStage =
  | "product_owner_confirmation_requested"
  | "tech_review_requested";

export type AgentmailInboundTransport = "webhook" | "websocket";

type AgentmailInboundProcessMeta = {
  transport: AgentmailInboundTransport;
  eventType?: string | null;
  rawPayload?: unknown;
};

const AGENTMAIL_CEO_INTAKE_MARKER = "<!-- paperclip:agentmail-ceo-intake -->";
const AGENTMAIL_CTO_INTAKE_MARKER = "<!-- paperclip:agentmail-cto-intake -->";
const AGENTMAIL_PM_REVIEW_MARKER = "<!-- paperclip:agentmail-pm-review -->";
const AGENTMAIL_CEO_APPROVAL_MARKER = "<!-- paperclip:agentmail-ceo-approval -->";
const AGENTMAIL_TECH_REVIEW_MARKER = "<!-- paperclip:agentmail-tech-review -->";
const AGENTMAIL_LEGACY_REQUIREMENT_REVIEW_MARKER = "<!-- paperclip:agentmail-requirement-review -->";
const AGENTMAIL_LEGACY_REQUIREMENT_APPROVAL_TYPE = "agentmail_requirement_confirmation";
const AGENTMAIL_PRODUCT_OWNER_APPROVAL_TYPE = "agentmail_product_owner_confirmation";
const AGENTMAIL_TECH_REVIEW_APPROVAL_TYPE = "agentmail_tech_review";

function defaultRequiredRolesForApprovalType(type: string): string[] {
  if (type === AGENTMAIL_PRODUCT_OWNER_APPROVAL_TYPE) return ["product_owner_head"];
  if (type === AGENTMAIL_TECH_REVIEW_APPROVAL_TYPE) return ["tech_team"];
  return [];
}

const CTO_INTAKE_SECTION_KEYS = {
  "repo summary": "repoSummary",
  "implementation constraints": "implementationConstraints",
  "pm follow up": "pmFollowUp",
  "recommended requirement": "recommendedRequirement",
} as const satisfies Record<string, keyof CtoIntakeSections>;

const PM_REVIEW_SECTION_KEYS = {
  "owner summary": "ownerSummary",
  "follow up questions": "followUpQuestions",
  "recommended requirement": "recommendedRequirement",
  "notes for tech": "notesForTech",
} as const satisfies Record<string, keyof PmClarificationSections>;

const CEO_APPROVAL_SECTION_KEYS = {
  decision: "decision",
  rationale: "rationale",
  "notes for cto": "notesForCto",
} as const satisfies Record<string, keyof CeoApprovalSections>;

const TECH_REVIEW_SECTION_KEYS = {
  "fits current code": "fitsCurrentCode",
  "open questions": "openQuestions",
  "red flags": "redFlags",
  "implementation notes": "implementationNotes",
} as const satisfies Record<string, keyof TechReviewSections>;

const LEGACY_REQUIREMENT_REVIEW_SECTION_KEYS = {
  "requested change": "requestedChange",
  "feasible now": "feasibleNow",
  "hard or risky parts": "hardOrRiskyParts",
  "scope cuts and tradeoffs": "scopeCutsAndTradeoffs",
  "recommended requirement": "recommendedRequirement",
  "proposed issue breakdown": "proposedIssueBreakdown",
} as const;

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
  if (asString) {
    const match = asString.match(/^(.*?)<([^>]+)>$/);
    if (match?.[2]) {
      const email = safeText(match[2]);
      const name = safeText(match[1]);
      if (email) {
        return name ? { email, name } : { email };
      }
    }
    return { email: asString };
  }

  const fallback = safeText(fallbackEmail);
  if (fallback) return { email: fallback };

  return null;
}

function normalizeIncomingMessageShape(payload: unknown): Record<string, unknown> | null {
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

export function normalizeAgentmailMessagePayload(payload: unknown): AgentmailMessage | null {
  const directMessage = agentmailMessageSchema.safeParse(payload);
  if (directMessage.success) return directMessage.data;

  const root = safeRecord(payload);
  const nestedMessage = root?.message;
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

export function canonicalizeAgentmailSubject(subject: string): string {
  let current = subject.trim();
  while (true) {
    const next = current.replace(/^(?:(?:\s*(?:re|fw|fwd)\s*:\s*)+)/i, "").trim();
    if (next === current) return current;
    current = next;
  }
}

function extractProjectReference(subject: string): string | null {
  const match = subject.match(/\[\s*Project\s*:\s*([^\]]+)\s*\]/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

function stripProjectReferenceTag(subject: string): string {
  return subject.replace(/^\s*\[\s*Project\s*:\s*[^\]]+\]\s*/i, "").trim();
}

function findForwardedSubjectHeader(text: string): string | null {
  const matches = text.matchAll(/^\s*>?\s*Subject:\s*(.+?)\s*$/gim);
  for (const match of matches) {
    const subject = safeText(match[1]);
    if (subject) return subject;
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

function extractPlainTextRequirements(text: string): AgentmailRequirementItem[] {
  const normalized = text.replace(/\r/g, "");
  const segments = normalized
    .split(/\n+/)
    .flatMap((line) => line.split(/\s+(?:and then|and of course)\s+/i))
    .map((line) => line.trim())
    .filter(Boolean);
  const items: AgentmailRequirementItem[] = [];
  const seen = new Set<string>();

  const pushItem = (candidate: string | null) => {
    const value = candidate?.trim();
    if (!value) return;
    const normalizedValue = value.toLowerCase();
    if (seen.has(normalizedValue)) return;
    seen.add(normalizedValue);
    items.push({ title: value, priority: "medium" });
  };

  for (const segment of segments) {
    let candidate = segment
      .replace(/^>\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!candidate) continue;
    if (/^\[?\s*project\s*:/i.test(candidate)) continue;
    if (/^subject\s*:/i.test(candidate)) continue;
    if (/^[- ]*forwarded message/i.test(candidate)) continue;

    const lower = candidate.toLowerCase();
    if (lower === "so in the employee handbook i want to add a small detail") continue;
    if (lower.startsWith("so for the policy it have ")) continue;

    candidate = candidate.replace(/^(?:so|then|also)\s+/i, "");

    if (/^we already have\s+/i.test(candidate)) {
      candidate = `Reuse ${candidate.replace(/^we already have\s+/i, "").trim()}`;
    } else {
      candidate = candidate
        .replace(/^(?:i|we)\s+want\s+to\s+/i, "")
        .replace(/^(?:i|we)\s+need\s+to\s+/i, "")
        .replace(/^(?:i|we)\s+should\s+/i, "")
        .replace(/^it is just\s+/i, "");
    }

    candidate = candidate.replace(/[. ]+$/g, "").trim();
    if (candidate.length < 20) continue;

    pushItem(candidate[0] ? `${candidate[0].toUpperCase()}${candidate.slice(1)}` : candidate);
    if (items.length >= 8) break;
  }

  return items;
}

function extractRequirements(message: AgentmailMessage): RequirementExtraction {
  const requirements = message.requirements ?? null;
  const rawSubject = safeText(message.subject) || "Meeting follow-up";
  const canonicalSubject = canonicalizeAgentmailSubject(rawSubject);
  const textBody = safeText(message.textBody);
  const htmlBody = safeText(message.htmlBody);
  const bodyText = textBody || (htmlBody ? htmlToText(htmlBody) : "");

  const summary =
    safeText(requirements?.summary) ||
    (bodyText.length > 700 ? `${bodyText.slice(0, 700)}...` : bodyText) ||
    "No summary provided.";

  const requirementsTitle = safeText(requirements?.title);
  const canonicalRequirementsTitle = requirementsTitle ? canonicalizeAgentmailSubject(requirementsTitle) : "";
  const title =
    stripProjectReferenceTag(canonicalRequirementsTitle || canonicalSubject)
    || canonicalRequirementsTitle
    || canonicalSubject
    || "Meeting follow-up";
  const items = (requirements?.items ?? []).length > 0
    ? requirements?.items ?? []
    : (() => {
      const checklistItems = extractChecklistItems(bodyText);
      if (checklistItems.length > 0) return checklistItems;
      return extractPlainTextRequirements(bodyText);
    })();

  const forwardedSubject = bodyText ? findForwardedSubjectHeader(bodyText) : null;
  const canonicalForwardedSubject = forwardedSubject ? canonicalizeAgentmailSubject(forwardedSubject) : null;
  const projectReferenceFromSubject = extractProjectReference(canonicalSubject);
  const projectReferenceFromForwardedBody = canonicalForwardedSubject
    ? extractProjectReference(canonicalForwardedSubject)
    : null;
  const projectReferenceFromReqs = safeText(requirements?.projectReference);
  const projectReference: string | null =
    projectReferenceFromReqs
    || projectReferenceFromSubject
    || projectReferenceFromForwardedBody;

  return {
    title,
    summary,
    items,
    projectReference,
    rawSubject,
    canonicalSubject,
    targetIssueId: requirements?.targetIssueId ?? null,
    targetIssueIdentifier: requirements?.targetIssueIdentifier ?? detectIssueIdentifier(canonicalSubject),
  };
}

type LegacyRequirementReviewSections = {
  requestedChange: string;
  feasibleNow: string;
  hardOrRiskyParts: string;
  scopeCutsAndTradeoffs: string;
  recommendedRequirement: string;
  proposedIssueBreakdown: string;
};

type AgentSummary = {
  id: string;
  name: string;
  role: string;
  status: string;
};

function isProductOwnerAgentRole(role: string) {
  return role === "pm";
}

function parseStructuredCommentSections<T extends Record<string, string>>(
  body: string,
  marker: string,
  sectionKeys: Record<string, keyof T>,
): T | null {
  const raw = body.trim();
  if (!raw.includes(marker)) return null;

  const withoutMarker = raw.replace(marker, "").trim();
  const headerRegex = /^##\s+(.+?)\s*$/gm;
  const matches = Array.from(withoutMarker.matchAll(headerRegex));
  if (matches.length === 0) return null;

  const sections = new Map<keyof T, string>();

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match || typeof match.index !== "number") continue;
    const nextMatch = matches[index + 1];
    const header = normalizeSectionHeading(match[1] ?? "");
    const targetKey = sectionKeys[header as keyof typeof sectionKeys];
    if (!targetKey) continue;

    const valueStart = match.index + match[0].length;
    const valueEnd = typeof nextMatch?.index === "number" ? nextMatch.index : withoutMarker.length;
    const sectionBody = withoutMarker.slice(valueStart, valueEnd).trim();
    if (sectionBody.length > 0) {
      sections.set(targetKey, sectionBody);
    }
  }

  const expectedKeys = Array.from(new Set(Object.values(sectionKeys))) as Array<keyof T>;
  if (expectedKeys.some((key) => !sections.get(key))) {
    return null;
  }

  return Object.fromEntries(expectedKeys.map((key) => [key, sections.get(key) ?? ""])) as T;
}

export function parsePmClarificationComment(body: string): PmClarificationSections | null {
  return parseStructuredCommentSections<PmClarificationSections>(
    body,
    AGENTMAIL_PM_REVIEW_MARKER,
    PM_REVIEW_SECTION_KEYS,
  );
}

export function parseCtoIntakeComment(body: string): CtoIntakeSections | null {
  return parseStructuredCommentSections<CtoIntakeSections>(
    body,
    AGENTMAIL_CEO_INTAKE_MARKER,
    CTO_INTAKE_SECTION_KEYS,
  ) ?? parseStructuredCommentSections<CtoIntakeSections>(
    body,
    AGENTMAIL_CTO_INTAKE_MARKER,
    CTO_INTAKE_SECTION_KEYS,
  );
}

export function parseCeoApprovalComment(body: string): CeoApprovalSections | null {
  return parseStructuredCommentSections<CeoApprovalSections>(
    body,
    AGENTMAIL_CEO_APPROVAL_MARKER,
    CEO_APPROVAL_SECTION_KEYS,
  );
}

export function parseTechReviewComment(body: string): TechReviewSections | null {
  return parseStructuredCommentSections<TechReviewSections>(
    body,
    AGENTMAIL_TECH_REVIEW_MARKER,
    TECH_REVIEW_SECTION_KEYS,
  );
}

export function parseRequirementReviewComment(body: string): LegacyRequirementReviewSections | null {
  return parseStructuredCommentSections<LegacyRequirementReviewSections>(
    body,
    AGENTMAIL_LEGACY_REQUIREMENT_REVIEW_MARKER,
    LEGACY_REQUIREMENT_REVIEW_SECTION_KEYS,
  );
}

function buildProductOwnerApprovalPayload(input: {
  issue: RequirementIssueSnapshot;
  message: AgentmailMessage;
  review: PmClarificationSections;
  pmAgentId: string | null;
  pmAgentName: string | null;
  reviewCommentId: string | null;
  projectName: string | null;
  productOwnerEmail: string | null;
  pmReviewReady: boolean;
}) {
  return {
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier ?? input.issue.id,
    issueTitle: input.issue.title,
    sourceMessageId: safeText(input.message.messageId),
    sourceThreadId: safeText(input.message.threadId) || null,
    senderEmail: safeText(input.message.from?.email) || null,
    pmAgentId: input.pmAgentId,
    pmAgentName: input.pmAgentName,
    reviewCommentId: input.reviewCommentId,
    projectName: input.projectName,
    productOwnerEmail: input.productOwnerEmail,
    pmReviewReady: input.pmReviewReady,
    ownerSummary: input.review.ownerSummary,
    followUpQuestions: input.review.followUpQuestions,
    recommendedRequirement: input.review.recommendedRequirement,
    notesForTech: input.review.notesForTech,
  } satisfies Record<string, unknown>;
}

function buildTechReviewApprovalPayload(input: {
  issue: RequirementIssueSnapshot;
  message: AgentmailMessage;
  review: TechReviewSections;
  reviewerAgentId: string | null;
  reviewerAgentName: string | null;
  reviewCommentId: string | null;
  projectName: string | null;
  techTeamEmail: string | null;
  techReviewReady: boolean;
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
    techTeamEmail: input.techTeamEmail,
    techReviewReady: input.techReviewReady,
    fitsCurrentCode: input.review.fitsCurrentCode,
    openQuestions: input.review.openQuestions,
    redFlags: input.review.redFlags,
    implementationNotes: input.review.implementationNotes,
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
    "Execution remains gated until CEO intake, PM clarification, CEO approval, and CTO technical review are complete.",
    "No implementation starts from AgentMail intake until the executive and technical gates are approved.",
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

function formatNotificationStageLabel(stage: AgentmailNotificationStage) {
  return stage === "product_owner_confirmation_requested"
    ? "product-owner confirmation"
    : "tech review";
}

function buildStageNotificationBody(input: {
  stage: AgentmailNotificationStage;
  issueIdentifier: string;
  issueTitle: string;
  payload: Record<string, unknown>;
  projectName: string | null;
  sourceMessageId: string | null;
}) {
  if (input.stage === "product_owner_confirmation_requested") {
    const lines = [
      `${input.issueIdentifier} is ready for product-owner confirmation.`,
      "",
      `Issue: ${input.issueIdentifier} - ${input.issueTitle}`,
      input.projectName ? `Project: ${input.projectName}` : "Project: Company backlog",
      input.sourceMessageId ? `Source message: ${input.sourceMessageId}` : null,
      "",
      "Please review the updated issue description and PM comment in Paperclip, then resolve the linked Product Owner Confirmation approval.",
    ].filter((line): line is string => line !== null);

    const ownerSummary = safeText(input.payload.ownerSummary);
    const followUpQuestions = safeText(input.payload.followUpQuestions);
    const recommendedRequirement = safeText(input.payload.recommendedRequirement);

    if (ownerSummary) {
      lines.push("", "Owner Summary", ownerSummary);
    }
    if (followUpQuestions) {
      lines.push("", "Follow-up Questions", followUpQuestions);
    }
    if (recommendedRequirement) {
      lines.push("", "Recommended Requirement", recommendedRequirement);
    }

    return lines.join("\n");
  }

  const lines = [
    `${input.issueIdentifier} is ready for CTO technical review.`,
    "",
    `Issue: ${input.issueIdentifier} - ${input.issueTitle}`,
    input.projectName ? `Project: ${input.projectName}` : "Project: Company backlog",
    input.sourceMessageId ? `Source message: ${input.sourceMessageId}` : null,
    "",
    "Please review the linked issue card, continue discussion in card comments, and resolve the linked Tech Review approval in Paperclip.",
  ].filter((line): line is string => line !== null);

  const openQuestions = safeText(input.payload.openQuestions);
  const redFlags = safeText(input.payload.redFlags);

  if (openQuestions) {
    lines.push("", "Open Questions", openQuestions);
  }
  if (redFlags) {
    lines.push("", "Red Flags", redFlags);
  }

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
    `- Subject: ${input.extraction.canonicalSubject || "(no subject)"}`,
    input.extraction.rawSubject !== input.extraction.canonicalSubject
      ? `- Raw subject: ${input.extraction.rawSubject || "(no subject)"}`
      : null,
    input.resolvedProject ? `- Routed project: ${input.resolvedProject.name}` : "- Routed project: Company backlog",
    input.extraction.projectReference ? `- Requested project: ${input.extraction.projectReference}` : null,
    input.issue ? `- Linked issue: ${input.issue.identifier ?? input.issue.id}` : null,
    "- Execution gate: CEO intake, PM clarification, CEO approval, and CTO technical review are required before implementation starts.",
    "- CTO implementation begins only after CEO approval and CTO technical review are complete.",
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

async function sendAgentmailNotification(db: Db, input: {
  companyId: string;
  deliveryId: string | null;
  issueId: string;
  approvalId: string | null;
  stage: AgentmailNotificationStage;
  recipient: string | null;
  issueIdentifier: string;
  issueTitle: string;
  projectName: string | null;
  sourceMessageId: string | null;
  payload: Record<string, unknown>;
}) {
  const recipient = normalizeEmail(input.recipient);
  const [notification] = await db
    .insert(agentmailOutboundNotifications)
    .values({
      companyId: input.companyId,
      deliveryId: input.deliveryId,
      issueId: input.issueId,
      approvalId: input.approvalId,
      stage: input.stage,
      recipient,
      status: "pending",
    })
    .returning({ id: agentmailOutboundNotifications.id });

  const notificationId = notification?.id ?? null;
  if (!notificationId) {
    return {
      status: "skipped" as const,
      reason: "notification_insert_failed" as const,
      recipient,
      messageId: null,
      threadId: null,
      error: "failed_to_create_notification_record",
      notificationId,
    };
  }

  async function updateNotification(patch: Partial<typeof agentmailOutboundNotifications.$inferInsert>) {
    await db
      .update(agentmailOutboundNotifications)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(agentmailOutboundNotifications.id, notificationId));
  }

  const apiKey = process.env.PAPERCLIP_AGENTMAIL_API_KEY?.trim();
  if (!apiKey || !recipient) {
    const reason = !recipient ? "missing_recipient" : "missing_api_key";
    await updateNotification({
      status: "skipped",
      error: reason,
    });
    return {
      status: "skipped" as const,
      reason,
      recipient,
      messageId: null,
      threadId: null,
      error: null,
      notificationId,
    };
  }

  const baseUrl = process.env.PAPERCLIP_AGENTMAIL_API_BASE_URL?.trim() || "https://api.agentmail.to/v0";
  const inboxId = await resolveOutboundInboxId(baseUrl, apiKey);
  const url = `${baseUrl.replace(/\/$/, "")}/inboxes/${encodeURIComponent(inboxId)}/messages/send`;
  const body = buildStageNotificationBody(input);
  const subject =
    input.stage === "product_owner_confirmation_requested"
      ? `[Paperclip] ${input.issueIdentifier} product-owner confirmation requested`
      : `[Paperclip] ${input.issueIdentifier} tech review requested`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to: recipient,
      subject,
      text: body,
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    await updateNotification({
      status: "failed",
      error: `AgentMail send failed (${response.status}): ${responseText}`,
    });
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

  const messageId = safeText(parsed?.message_id ?? parsed?.messageId ?? parsed?.id) || null;
  const threadId = safeText(parsed?.thread_id ?? parsed?.threadId) || null;

  await updateNotification({
    status: "sent",
    messageId,
    threadId,
    sentAt: new Date(),
    error: null,
  });

  return {
    status: "sent" as const,
    reason: null,
    recipient,
    messageId,
    threadId,
    error: null,
    notificationId,
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

function pickPmAgent(
  availableAgents: AgentSummary[],
  assigneeAgentId: string | null,
) {
  const active = availableAgents.filter((agent) => isActiveAgentStatus(agent.status));
  if (assigneeAgentId) {
    const assigned = active.find((agent) => agent.id === assigneeAgentId && isProductOwnerAgentRole(agent.role));
    if (assigned) return assigned;
  }
  return active.find((agent) => agent.role === "pm") ?? null;
}

function pickCeoAgent(
  availableAgents: AgentSummary[],
  assigneeAgentId: string | null,
) {
  const active = availableAgents.filter((agent) => isActiveAgentStatus(agent.status));
  if (assigneeAgentId) {
    const assigned = active.find((agent) => agent.id === assigneeAgentId && agent.role === "ceo");
    if (assigned) return assigned;
  }
  return active.find((agent) => agent.role === "ceo") ?? null;
}

function pickCtoAgent(
  availableAgents: AgentSummary[],
  assigneeAgentId: string | null,
) {
  const active = availableAgents.filter((agent) => isActiveAgentStatus(agent.status));
  if (assigneeAgentId) {
    const assigned = active.find((agent) => agent.id === assigneeAgentId && agent.role === "cto");
    if (assigned) return assigned;
  }
  return active.find((agent) => agent.role === "cto") ?? null;
}

function buildNotificationReplyComment(input: {
  stage: AgentmailNotificationStage;
  senderEmail: string | null;
  messageId: string;
  note: string | null;
}) {
  const lines = [
    "AgentMail notification reply received.",
    `Stage: ${formatNotificationStageLabel(input.stage)}`,
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
      .select({
        productOwnerEmail: companies.productOwnerEmail,
        techTeamEmail: companies.techTeamEmail,
      })
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

  async function findLatestIssueForThread(companyId: string, threadId: string | null) {
    if (!threadId) return null;
    const deliveries = await db
      .select()
      .from(agentmailWebhookDeliveries)
      .where(and(
        eq(agentmailWebhookDeliveries.companyId, companyId),
        eq(agentmailWebhookDeliveries.threadId, threadId),
      ))
      .orderBy(desc(agentmailWebhookDeliveries.createdAt));

    for (const delivery of deliveries) {
      if (!delivery.linkedIssueId) continue;
      const issue = await issues.getById(delivery.linkedIssueId);
      if (issue && issue.companyId === companyId) return issue;
    }

    return null;
  }

  async function getLatestStageApprovalForIssue(issueId: string, type: string) {
    const linkedApprovals = await issueApprovalsSvc.listApprovalsForIssue(issueId);
    return linkedApprovals.find((approval) => approval.type === type) ?? null;
  }

  async function findMatchingNotificationReply(companyId: string, message: AgentmailMessage) {
    const threadId = safeText(message.threadId) || null;
    const passthrough = message as Record<string, unknown>;
    const inReplyTo = safeText(passthrough.inReplyTo ?? passthrough.in_reply_to) || null;
    const senderEmail = safeText(message.from?.email) || null;
    const correlationFilters = [];

    if (threadId) {
      correlationFilters.push(eq(agentmailOutboundNotifications.threadId, threadId));
    }
    if (inReplyTo) {
      correlationFilters.push(eq(agentmailOutboundNotifications.messageId, inReplyTo));
    }
    if (correlationFilters.length === 0) return null;

    const candidates = await db
      .select()
      .from(agentmailOutboundNotifications)
      .where(and(
        eq(agentmailOutboundNotifications.companyId, companyId),
        or(...correlationFilters),
      ))
      .orderBy(desc(agentmailOutboundNotifications.createdAt));

    for (const candidate of candidates) {
      if (
        senderEmail
        && candidate.recipient
        && !sameEmail(senderEmail, candidate.recipient)
      ) {
        continue;
      }
      return candidate;
    }

    return null;
  }

  async function updateLatestIssueDelivery(
    companyId: string,
    issueId: string,
    patch: Partial<typeof agentmailWebhookDeliveries.$inferInsert>,
  ) {
    const latestDelivery = await getLatestIssueDelivery(companyId, issueId);
    if (!latestDelivery) return null;
    await db
      .update(agentmailWebhookDeliveries)
      .set(patch)
      .where(and(
        eq(agentmailWebhookDeliveries.id, latestDelivery.id),
        eq(agentmailWebhookDeliveries.companyId, companyId),
      ));
    return latestDelivery;
  }

  async function notifyRoleStage(input: {
    companyId: string;
    deliveryId: string | null;
    issueId: string;
    approvalId: string;
    stage: AgentmailNotificationStage;
    roleType: "product_owner_head" | "tech_team";
    fallbackRecipient: string | null;
    issueIdentifier: string;
    issueTitle: string;
    sourceMessageId: string;
    payload: Record<string, unknown>;
  }) {
    const roleRecipients = await approvalsSvc.listRoleUserEmails(input.companyId, input.roleType);
    const recipients = Array.from(
      new Set(
        [...roleRecipients, normalizeEmail(input.fallbackRecipient)]
          .filter((value): value is string => Boolean(value)),
      ),
    );

    if (recipients.length === 0) {
      const skipped = await sendAgentmailNotification(db, {
        companyId: input.companyId,
        deliveryId: input.deliveryId,
        issueId: input.issueId,
        approvalId: input.approvalId,
        stage: input.stage,
        recipient: null,
        issueIdentifier: input.issueIdentifier,
        issueTitle: input.issueTitle,
        projectName: null,
        sourceMessageId: input.sourceMessageId,
        payload: input.payload,
      });
      return { primaryNotification: skipped, notifications: [skipped] };
    }

    const notifications: Array<Awaited<ReturnType<typeof sendAgentmailNotification>>> = [];
    for (const recipient of recipients) {
      notifications.push(await sendAgentmailNotification(db, {
        companyId: input.companyId,
        deliveryId: input.deliveryId,
        issueId: input.issueId,
        approvalId: input.approvalId,
        stage: input.stage,
        recipient,
        issueIdentifier: input.issueIdentifier,
        issueTitle: input.issueTitle,
        projectName: null,
        sourceMessageId: input.sourceMessageId,
        payload: input.payload,
      }));
    }

    return {
      primaryNotification: notifications.find((notification) => notification.status === "sent") ?? notifications[0],
      notifications,
    };
  }

  async function resolveIssueForApproval(approvalId: string) {
    const approval = await approvalsSvc.getById(approvalId);
    if (!approval) return null;
    const payload = safeRecord(approval.payload);
    const payloadIssueId = safeText(payload?.issueId);
    if (payloadIssueId) {
      const byId = await issues.getById(payloadIssueId);
          if (byId && byId.companyId === approval.companyId) return { issue: byId, approval };
    }
    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
    const linkedIssue = linkedIssues[0] ?? null;
    if (!linkedIssue) return null;
    const fullIssue = await issues.getById(linkedIssue.id);
    if (!fullIssue || fullIssue.companyId !== approval.companyId) return null;
    return { issue: fullIssue, approval };
  }

  async function ensurePendingApprovalForIssue(input: {
    companyId: string;
    issueId: string;
    type: string;
    payload: Record<string, unknown>;
    requestedByAgentId: string | null;
    requiredRoles?: string[] | null;
    linkActorAgentId?: string | null;
  }) {
    const requiredRoles = (input.requiredRoles ?? defaultRequiredRolesForApprovalType(input.type))
      .filter((role): role is string => typeof role === "string" && role.trim().length > 0);
    const latestApproval = await getLatestStageApprovalForIssue(input.issueId, input.type);
    if (latestApproval?.status === "pending") {
      const approval = await approvalsSvc.updatePayload(latestApproval.id, input.payload);
      return { approval, disposition: "updated" as const };
    }
    if (latestApproval?.status === "revision_requested") {
      const approval = await approvalsSvc.resubmit(latestApproval.id, input.payload);
      return { approval, disposition: "resubmitted" as const };
    }

    const approval = await approvalsSvc.create(input.companyId, {
      type: input.type,
      requestedByAgentId: input.requestedByAgentId,
      requestedByUserId: null,
      status: "pending",
      requiredRoles,
      payload: input.payload,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    await issueApprovalsSvc.link(input.issueId, approval.id, {
      agentId: input.linkActorAgentId ?? input.requestedByAgentId,
      userId: null,
    });
    return { approval, disposition: "created" as const };
  }

  async function cancelOpenApprovalsForIssue(issueId: string, type: string, note: string) {
    const linkedApprovals = await issueApprovalsSvc.listApprovalsForIssue(issueId);
    const openApprovals = linkedApprovals.filter(
      (approval) =>
        approval.type === type && (approval.status === "pending" || approval.status === "revision_requested"),
    );

    for (const approval of openApprovals) {
      await approvalsSvc.cancel(approval.id, note);
    }

    return openApprovals.map((approval) => approval.id);
  }

  async function addSystemIssueComment(issueId: string, body: string) {
    return issues.addComment(issueId, body, { userId: "system-agentmail" });
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

  async function cancelActiveIssueRun(issue: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
  }) {
    if (!issue.assigneeAgentId) return null;
    const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
    const activeIssueId =
      activeRun &&
      activeRun.contextSnapshot &&
      typeof activeRun.contextSnapshot === "object" &&
      typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
        ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
        : null;
    if (!activeRun || activeRun.status !== "running" || activeIssueId !== issue.id) return null;

    const cancelled = await heartbeat.cancelRun(activeRun.id);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "agentmail",
      action: "agentmail.active_run_cancelled",
      entityType: "issue",
      entityId: issue.id,
      details: {
        issueId: issue.id,
        cancelledRunId: cancelled?.id ?? activeRun.id,
        assigneeAgentId: issue.assigneeAgentId,
      },
    });
    return cancelled;
  }

  async function applyAgentmailApprovalDecision(input: {
    approvalId: string;
    action: ReviewDecisionAction;
    actorType: "user" | "agent" | "system";
    actorId: string;
    sourceMessageId: string;
    note: string | null;
  }) {
    const resolved = await resolveIssueForApproval(input.approvalId);
    if (!resolved) return null;

    const { approval, issue } = resolved;
    if (
      approval.type !== AGENTMAIL_PRODUCT_OWNER_APPROVAL_TYPE
      && approval.type !== AGENTMAIL_TECH_REVIEW_APPROVAL_TYPE
      && approval.type !== AGENTMAIL_LEGACY_REQUIREMENT_APPROVAL_TYPE
    ) {
      return null;
    }

    if (approval.type === AGENTMAIL_LEGACY_REQUIREMENT_APPROVAL_TYPE) {
      return {
        status: "ignored" as const,
        reason: "legacy_approval_read_only" as const,
        issueId: issue.id,
        approvalId: approval.id,
      };
    }

    const company = await getCompanySettings(issue.companyId);
    const availableAgents = (await agentsSvc.list(issue.companyId)).map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
    }));
    const pmAgent = pickPmAgent(availableAgents, issue.assigneeAgentId ?? null);
    const ctoAgent = pickCtoAgent(availableAgents, issue.assigneeAgentId ?? null);
    const latestDelivery = await getLatestIssueDelivery(issue.companyId, issue.id);
    const sourceMessage = latestDelivery
      ? normalizeAgentmailMessagePayload(latestDelivery.payload) ?? {
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
        }
      : {
          messageId: input.sourceMessageId,
          threadId: null,
          subject: issue.title,
          from: null,
          to: [],
          cc: [],
          textBody: null,
          htmlBody: null,
          receivedAt: null,
          fireflies: null,
          requirements: null,
        };

    if (approval.type === AGENTMAIL_PRODUCT_OWNER_APPROVAL_TYPE) {
      if (input.action === "approve") {
        const techApprovalPayload = buildTechReviewApprovalPayload({
          issue: {
            id: issue.id,
            identifier: issue.identifier ?? null,
            title: issue.title,
            description: issue.description ?? null,
          },
          message: sourceMessage,
          review: {
            fitsCurrentCode: "",
            openQuestions: "",
            redFlags: "",
            implementationNotes: "",
          },
          reviewerAgentId: ctoAgent?.id ?? null,
          reviewerAgentName: ctoAgent?.name ?? null,
          reviewCommentId: null,
          projectName: null,
          techTeamEmail: company?.techTeamEmail ?? null,
          techReviewReady: false,
        });
        const techApprovalResult = await ensurePendingApprovalForIssue({
          companyId: issue.companyId,
          issueId: issue.id,
          type: AGENTMAIL_TECH_REVIEW_APPROVAL_TYPE,
          payload: techApprovalPayload,
          requestedByAgentId: ctoAgent?.id ?? null,
        });
        const { primaryNotification: notification } = await notifyRoleStage({
          companyId: issue.companyId,
          deliveryId: latestDelivery?.id ?? null,
          issueId: issue.id,
          approvalId: techApprovalResult.approval.id,
          stage: "tech_review_requested",
          roleType: "tech_team",
          fallbackRecipient: company?.techTeamEmail ?? null,
          issueIdentifier: issue.identifier ?? issue.id,
          issueTitle: issue.title,
          sourceMessageId: sourceMessage.messageId,
          payload: techApprovalPayload,
        });

        await issues.update(issue.id, {
          status: "blocked",
          assigneeAgentId: ctoAgent?.id ?? null,
        });
        await addSystemIssueComment(
          issue.id,
          "Product-owner confirmation approved. CTO technical review is now required before implementation.",
        );
        await updateLatestIssueDelivery(issue.companyId, issue.id, {
          linkedApprovalId: techApprovalResult.approval.id,
          approvalStatus: techApprovalResult.approval.status,
          outboundStatus:
            notification.status === "skipped"
              ? `skipped_${notification.reason}`
              : notification.status,
          outboundMessageId: notification.messageId,
          outboundThreadId: notification.threadId,
          outboundRecipient: notification.recipient,
          outboundSentAt: notification.status === "sent" ? new Date() : null,
          outboundError: notification.error,
        });

        if (ctoAgent) {
          await queueAgentWakeup(ctoAgent.id, {
            reason: "agentmail_tech_review_requested",
            issueId: issue.id,
            approvalId: techApprovalResult.approval.id,
            requestedByActorType: input.actorType,
            requestedByActorId: input.actorId,
            payload: {
              sourceMessageId: input.sourceMessageId,
            },
            source: "agentmail.product_owner_approval.approved",
          });
        } else {
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: input.actorType,
            actorId: input.actorId,
            action: "agentmail.awaiting_cto_agent",
            entityType: "issue",
            entityId: issue.id,
            details: {
              issueId: issue.id,
              approvalId: techApprovalResult.approval.id,
              state: "awaiting_cto_agent",
            },
          });
        }

        await logActivity(db, {
          companyId: issue.companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          action: "agentmail.product_owner_approved",
          entityType: "issue",
          entityId: issue.id,
          details: {
            issueId: issue.id,
            approvalId: approval.id,
            nextApprovalId: techApprovalResult.approval.id,
            notificationStatus:
              notification.status === "skipped"
                ? `skipped_${notification.reason}`
                : notification.status,
            assigneeAgentId: ctoAgent?.id ?? null,
          },
        });

        return {
          status: "processed" as const,
          issueId: issue.id,
          issueIdentifier: issue.identifier ?? null,
          approvalId: approval.id,
          nextApprovalId: techApprovalResult.approval.id,
          assigneeAgentId: ctoAgent?.id ?? null,
        };
      }

      await issues.update(issue.id, {
        status: "blocked",
        assigneeAgentId: pmAgent?.id ?? null,
      });
      await addSystemIssueComment(
        issue.id,
        input.action === "edit"
          ? "Product-owner confirmation requested edits. PM clarification remains required."
          : "Product-owner confirmation was rejected. The issue remains blocked.",
      );

      if (pmAgent) {
        await queueAgentWakeup(pmAgent.id, {
          reason:
            input.action === "edit"
              ? "agentmail_product_owner_revision_requested"
              : "agentmail_product_owner_rejected",
          issueId: issue.id,
          approvalId: approval.id,
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          payload: {
            sourceMessageId: input.sourceMessageId,
            decisionAction: input.action,
          },
          source: "agentmail.product_owner_approval.feedback",
        });
      }

      await updateLatestIssueDelivery(issue.companyId, issue.id, {
        linkedApprovalId: approval.id,
        approvalStatus: approval.status,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: "agentmail.product_owner_feedback",
        entityType: "issue",
        entityId: issue.id,
        details: {
          issueId: issue.id,
          approvalId: approval.id,
          action: input.action,
          assigneeAgentId: pmAgent?.id ?? null,
        },
      });

      return {
        status: "processed" as const,
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? null,
        approvalId: approval.id,
        assigneeAgentId: pmAgent?.id ?? null,
      };
    }

    if (input.action === "approve") {
      await issues.update(issue.id, {
        status: "todo",
        assigneeAgentId: ctoAgent?.id ?? issue.assigneeAgentId ?? null,
      });
      await addSystemIssueComment(issue.id, "Tech review approved. Implementation is now authorized.");

      if (ctoAgent) {
        await queueAgentWakeup(ctoAgent.id, {
          reason: "agentmail_implementation_authorized",
          issueId: issue.id,
          approvalId: approval.id,
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          payload: {
            sourceMessageId: input.sourceMessageId,
          },
          source: "agentmail.tech_review.approved",
        });
      }

      await updateLatestIssueDelivery(issue.companyId, issue.id, {
        linkedApprovalId: approval.id,
        approvalStatus: approval.status,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: "agentmail.tech_review_approved",
        entityType: "issue",
        entityId: issue.id,
        details: {
          issueId: issue.id,
          approvalId: approval.id,
          assigneeAgentId: ctoAgent?.id ?? issue.assigneeAgentId ?? null,
        },
      });

      return {
        status: "processed" as const,
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? null,
        approvalId: approval.id,
        assigneeAgentId: ctoAgent?.id ?? issue.assigneeAgentId ?? null,
      };
    }

    await issues.update(issue.id, {
      status: "blocked",
      assigneeAgentId: ctoAgent?.id ?? issue.assigneeAgentId ?? null,
    });
    await addSystemIssueComment(
      issue.id,
      input.action === "edit"
        ? "Tech review requested edits. The issue remains blocked until review is updated."
        : "Tech review was rejected. Implementation remains blocked.",
    );

    if (input.action === "edit" && ctoAgent) {
      await queueAgentWakeup(ctoAgent.id, {
        reason: "agentmail_tech_review_revision_requested",
        issueId: issue.id,
        approvalId: approval.id,
        requestedByActorType: input.actorType,
        requestedByActorId: input.actorId,
        payload: {
          sourceMessageId: input.sourceMessageId,
          decisionAction: input.action,
        },
        source: "agentmail.tech_review.feedback",
      });
    }

    await updateLatestIssueDelivery(issue.companyId, issue.id, {
      linkedApprovalId: approval.id,
      approvalStatus: approval.status,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: "agentmail.tech_review_feedback",
      entityType: "issue",
      entityId: issue.id,
      details: {
        issueId: issue.id,
        approvalId: approval.id,
        action: input.action,
        assigneeAgentId: ctoAgent?.id ?? issue.assigneeAgentId ?? null,
      },
    });

    return {
      status: "processed" as const,
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
      approvalId: approval.id,
      assigneeAgentId: ctoAgent?.id ?? issue.assigneeAgentId ?? null,
    };
  }

  const service = {
    handleRequirementReviewComment: async (input: {
      issueId: string;
      commentId: string;
      commentBody: string;
      authorAgentId: string;
    }) => {
      const issue = await issues.getById(input.issueId);
      if (!issue) {
        return { status: "ignored" as const, reason: "issue_not_found" as const };
      }

      const reviewer = await agentsSvc.getById(input.authorAgentId);
      if (!reviewer || reviewer.companyId !== issue.companyId) {
        return { status: "ignored" as const, reason: "unauthorized_reviewer" as const };
      }

      const executiveIntake = parseCtoIntakeComment(input.commentBody);
      const pmReview = parsePmClarificationComment(input.commentBody);
      const ceoApproval = parseCeoApprovalComment(input.commentBody);
      const techReview = parseTechReviewComment(input.commentBody);
      const hasLegacyMarker = input.commentBody.includes(AGENTMAIL_LEGACY_REQUIREMENT_REVIEW_MARKER);
      if (!executiveIntake && !pmReview && !ceoApproval && !techReview) {
        return {
          status: "ignored" as const,
          reason: hasLegacyMarker ? "legacy_marker_ignored" as const : "missing_requirement_review_marker" as const,
        };
      }

      const latestDelivery = await getLatestIssueDelivery(issue.companyId, issue.id);
      const company = await getCompanySettings(issue.companyId);
      const sourceMessage = latestDelivery
        ? normalizeAgentmailMessagePayload(latestDelivery.payload) ?? {
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
          }
        : {
            messageId: issue.id,
            threadId: null,
            subject: issue.title,
            from: null,
            to: [],
            cc: [],
            textBody: null,
            htmlBody: null,
            receivedAt: null,
            fireflies: null,
            requirements: null,
          };

      const availableAgents = (await agentsSvc.list(issue.companyId)).map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
      }));

      if (executiveIntake) {
        if (reviewer.role !== "ceo") {
          return { status: "ignored" as const, reason: "unauthorized_reviewer" as const };
        }

        const pmAgent = pickPmAgent(availableAgents, issue.assigneeAgentId ?? null);
        await issues.update(issue.id, {
          status: "blocked",
          assigneeAgentId: pmAgent?.id ?? null,
        });
        await updateLatestIssueDelivery(issue.companyId, issue.id, {
          outboundStatus: pmAgent ? "awaiting_pm_clarification" : "awaiting_pm_agent",
          linkedApprovalId: null,
          approvalStatus: null,
        });

        if (pmAgent) {
          await queueAgentWakeup(pmAgent.id, {
            reason: "agentmail_pm_clarification_requested",
            issueId: issue.id,
            requestedByActorType: "agent",
            requestedByActorId: reviewer.id,
            payload: {
              sourceMessageId: sourceMessage.messageId,
              ceoReviewCommentId: input.commentId,
            },
            source: "agentmail.ceo_intake.completed",
          });
        } else {
          await issues.addComment(
            issue.id,
            "AgentMail clarification is waiting because no active PM agent is currently available.",
            { userId: "system-agentmail" },
          );
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "agent",
            actorId: reviewer.id,
            agentId: reviewer.id,
            action: "agentmail.awaiting_pm_agent",
            entityType: "issue",
            entityId: issue.id,
            details: {
              issueId: issue.id,
              ceoAgentId: reviewer.id,
              ceoReviewCommentId: input.commentId,
              state: "awaiting_pm_agent",
            },
          });
        }

        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "agent",
          actorId: reviewer.id,
          agentId: reviewer.id,
          action: "agentmail.pm_clarification_requested",
          entityType: "issue",
          entityId: issue.id,
          details: {
            issueId: issue.id,
            ceoAgentId: reviewer.id,
            ceoAgentName: reviewer.name,
            ceoReviewCommentId: input.commentId,
            assigneeAgentId: pmAgent?.id ?? null,
          },
        });

        return {
          status: "processed" as const,
          issueId: issue.id,
          assigneeAgentId: pmAgent?.id ?? null,
        };
      }

      if (pmReview) {
        if (!isProductOwnerAgentRole(reviewer.role)) {
          return { status: "ignored" as const, reason: "unauthorized_reviewer" as const };
        }

        const ceoAgent = pickCeoAgent(availableAgents, issue.assigneeAgentId ?? null);
        await issues.update(issue.id, {
          status: "blocked",
          assigneeAgentId: ceoAgent?.id ?? null,
        });
        await updateLatestIssueDelivery(issue.companyId, issue.id, {
          linkedApprovalId: null,
          approvalStatus: null,
          outboundStatus: ceoAgent ? "awaiting_ceo_approval" : "awaiting_ceo_agent",
          outboundMessageId: null,
          outboundThreadId: null,
          outboundRecipient: null,
          outboundSentAt: null,
          outboundError: null,
        });

        if (ceoAgent) {
          await queueAgentWakeup(ceoAgent.id, {
            reason: "agentmail_ceo_approval_requested",
            issueId: issue.id,
            requestedByActorType: "agent",
            requestedByActorId: reviewer.id,
            payload: {
              sourceMessageId: sourceMessage.messageId,
              pmReviewCommentId: input.commentId,
            },
            source: "agentmail.pm_review.completed",
          });
        } else {
          await issues.addComment(
            issue.id,
            "AgentMail clarification is waiting because no active CEO agent is currently available.",
            { userId: "system-agentmail" },
          );
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "agent",
            actorId: reviewer.id,
            agentId: reviewer.id,
            action: "agentmail.awaiting_ceo_agent",
            entityType: "issue",
            entityId: issue.id,
            details: {
              issueId: issue.id,
              pmAgentId: reviewer.id,
              pmReviewCommentId: input.commentId,
              state: "awaiting_ceo_agent",
            },
          });
        }

        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "agent",
          actorId: reviewer.id,
          agentId: reviewer.id,
          action: "agentmail.ceo_approval_requested",
          entityType: "issue",
          entityId: issue.id,
          details: {
            issueId: issue.id,
            pmAgentId: reviewer.id,
            pmAgentName: reviewer.name,
            pmReviewCommentId: input.commentId,
            assigneeAgentId: ceoAgent?.id ?? null,
          },
        });

        return {
          status: "processed" as const,
          issueId: issue.id,
          assigneeAgentId: ceoAgent?.id ?? null,
          outboundStatus: ceoAgent ? "awaiting_ceo_approval" : "awaiting_ceo_agent",
        };
      }

      if (ceoApproval) {
        if (reviewer.role !== "ceo") {
          return { status: "ignored" as const, reason: "unauthorized_reviewer" as const };
        }

        const normalizedDecision = normalizeSectionHeading(ceoApproval.decision);
        const approved = normalizedDecision.includes("approve");
        const pmAgent = pickPmAgent(availableAgents, issue.assigneeAgentId ?? null);
        const ctoAgent = pickCtoAgent(availableAgents, issue.assigneeAgentId ?? null);

        if (approved) {
          await issues.update(issue.id, {
            status: "blocked",
            assigneeAgentId: ctoAgent?.id ?? null,
          });
          await addSystemIssueComment(
            issue.id,
            "CEO approved the clarified requirement. CTO technical review is now required before implementation.",
          );
          await updateLatestIssueDelivery(issue.companyId, issue.id, {
            linkedApprovalId: null,
            approvalStatus: null,
            outboundStatus: ctoAgent ? "awaiting_tech_review" : "awaiting_cto_agent",
          });

          if (ctoAgent) {
            await queueAgentWakeup(ctoAgent.id, {
              reason: "agentmail_tech_review_requested",
              issueId: issue.id,
              requestedByActorType: "agent",
              requestedByActorId: reviewer.id,
              payload: {
                sourceMessageId: sourceMessage.messageId,
                ceoApprovalCommentId: input.commentId,
              },
              source: "agentmail.ceo_approval.approved",
            });
          } else {
            await issues.addComment(
              issue.id,
              "AgentMail clarification is approved by the CEO, but no active CTO agent is currently available for technical review.",
              { userId: "system-agentmail" },
            );
            await logActivity(db, {
              companyId: issue.companyId,
              actorType: "agent",
              actorId: reviewer.id,
              agentId: reviewer.id,
              action: "agentmail.awaiting_cto_agent",
              entityType: "issue",
              entityId: issue.id,
              details: {
                issueId: issue.id,
                ceoAgentId: reviewer.id,
                ceoApprovalCommentId: input.commentId,
                state: "awaiting_cto_agent",
              },
            });
          }

          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "agent",
            actorId: reviewer.id,
            agentId: reviewer.id,
            action: "agentmail.ceo_approval_approved",
            entityType: "issue",
            entityId: issue.id,
            details: {
              issueId: issue.id,
              ceoAgentId: reviewer.id,
              ceoApprovalCommentId: input.commentId,
              assigneeAgentId: ctoAgent?.id ?? null,
            },
          });

          return {
            status: "processed" as const,
            issueId: issue.id,
            assigneeAgentId: ctoAgent?.id ?? null,
            outboundStatus: ctoAgent ? "awaiting_tech_review" : "awaiting_cto_agent",
          };
        }

        await issues.update(issue.id, {
          status: "blocked",
          assigneeAgentId: pmAgent?.id ?? null,
        });
        await addSystemIssueComment(
          issue.id,
          normalizedDecision.includes("reject")
            ? "CEO rejected the clarified requirement. PM clarification is required before the flow can continue."
            : "CEO requested revisions before approval. PM clarification remains required.",
        );
        await updateLatestIssueDelivery(issue.companyId, issue.id, {
          linkedApprovalId: null,
          approvalStatus: null,
          outboundStatus: pmAgent ? "awaiting_pm_clarification" : "awaiting_pm_agent",
        });

        if (pmAgent) {
          await queueAgentWakeup(pmAgent.id, {
            reason: "agentmail_ceo_revision_requested",
            issueId: issue.id,
            requestedByActorType: "agent",
            requestedByActorId: reviewer.id,
            payload: {
              sourceMessageId: sourceMessage.messageId,
              ceoApprovalCommentId: input.commentId,
              decision: ceoApproval.decision,
            },
            source: "agentmail.ceo_approval.feedback",
          });
        } else {
          await issues.addComment(
            issue.id,
            "CEO feedback is waiting because no active PM agent is currently available.",
            { userId: "system-agentmail" },
          );
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "agent",
            actorId: reviewer.id,
            agentId: reviewer.id,
            action: "agentmail.awaiting_pm_agent",
            entityType: "issue",
            entityId: issue.id,
            details: {
              issueId: issue.id,
              ceoAgentId: reviewer.id,
              ceoApprovalCommentId: input.commentId,
              state: "awaiting_pm_agent",
            },
          });
        }

        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "agent",
          actorId: reviewer.id,
          agentId: reviewer.id,
          action: "agentmail.ceo_approval_feedback",
          entityType: "issue",
          entityId: issue.id,
          details: {
            issueId: issue.id,
            ceoAgentId: reviewer.id,
            ceoApprovalCommentId: input.commentId,
            assigneeAgentId: pmAgent?.id ?? null,
            decision: ceoApproval.decision,
          },
        });

        return {
          status: "processed" as const,
          issueId: issue.id,
          assigneeAgentId: pmAgent?.id ?? null,
          outboundStatus: pmAgent ? "awaiting_pm_clarification" : "awaiting_pm_agent",
        };
      }

      if (reviewer.role !== "cto" || !techReview) {
        return { status: "ignored" as const, reason: "unauthorized_reviewer" as const };
      }

      const techApprovalPayload = buildTechReviewApprovalPayload({
        issue: {
          id: issue.id,
          identifier: issue.identifier ?? null,
          title: issue.title,
          description: issue.description ?? null,
        },
        message: sourceMessage,
        review: techReview,
        reviewerAgentId: reviewer.id,
        reviewerAgentName: reviewer.name,
        reviewCommentId: input.commentId,
        projectName: null,
        techTeamEmail: company?.techTeamEmail ?? null,
        techReviewReady: true,
      });
      const techApproval = await ensurePendingApprovalForIssue({
        companyId: issue.companyId,
        issueId: issue.id,
        type: AGENTMAIL_TECH_REVIEW_APPROVAL_TYPE,
        payload: techApprovalPayload,
        requestedByAgentId: reviewer.id,
        linkActorAgentId: reviewer.id,
      });
      const { primaryNotification: techReviewNotification } = await notifyRoleStage({
        companyId: issue.companyId,
        deliveryId: latestDelivery?.id ?? null,
        issueId: issue.id,
        approvalId: techApproval.approval.id,
        stage: "tech_review_requested",
        roleType: "tech_team",
        fallbackRecipient: company?.techTeamEmail ?? null,
        issueIdentifier: issue.identifier ?? issue.id,
        issueTitle: issue.title,
        sourceMessageId: sourceMessage.messageId,
        payload: techApprovalPayload,
      });

      await issues.update(issue.id, {
        status: "blocked",
        assigneeAgentId: reviewer.id,
      });
      await updateLatestIssueDelivery(issue.companyId, issue.id, {
        linkedApprovalId: techApproval.approval.id,
        approvalStatus: techApproval.approval.status,
        outboundStatus:
          techReviewNotification.status === "skipped"
            ? `skipped_${techReviewNotification.reason}`
            : techReviewNotification.status,
        outboundMessageId: techReviewNotification.messageId,
        outboundThreadId: techReviewNotification.threadId,
        outboundRecipient: techReviewNotification.recipient,
        outboundSentAt: techReviewNotification.status === "sent" ? new Date() : null,
        outboundError: techReviewNotification.error,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "agent",
        actorId: reviewer.id,
        agentId: reviewer.id,
        action: "agentmail.tech_review_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          issueId: issue.id,
          approvalId: techApproval.approval.id,
          reviewerAgentId: reviewer.id,
          reviewerAgentName: reviewer.name,
        },
      });

      return {
        status: "processed" as const,
        issueId: issue.id,
        approvalId: techApproval.approval.id,
        outboundStatus: null,
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
      applyAgentmailApprovalDecision({
        approvalId: input.approvalId,
        action: "approve",
        actorType: input.actorType,
        actorId: input.actorId,
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
      action?: ReviewDecisionAction;
    }) =>
      applyAgentmailApprovalDecision({
        approvalId: input.approvalId,
        action: input.action ?? "reject",
        actorType: input.actorType,
        actorId: input.actorId,
        sourceMessageId: input.sourceMessageId ?? input.approvalId,
        note: input.note ?? null,
      }),

    sendStageNotifications: async (input: {
      companyId: string;
      issueId: string;
      approvalId: string;
      stage: AgentmailNotificationStage;
      issueIdentifier: string;
      issueTitle: string;
      recipients: string[];
      payload?: Record<string, unknown>;
      projectName?: string | null;
      sourceMessageId?: string | null;
      deliveryId?: string | null;
    }) => {
      const recipients = Array.from(
        new Set(
          input.recipients
            .map((email) => normalizeEmail(email))
            .filter((value): value is string => Boolean(value)),
        ),
      );

      const results = [] as Array<{
        recipient: string | null;
        status: "sent" | "skipped";
        reason: string | null;
        messageId: string | null;
        threadId: string | null;
        error: string | null;
        notificationId: string | null;
      }>;

      for (const recipient of recipients) {
        try {
          const result = await sendAgentmailNotification(db, {
            companyId: input.companyId,
            deliveryId: input.deliveryId ?? null,
            issueId: input.issueId,
            approvalId: input.approvalId,
            stage: input.stage,
            recipient,
            issueIdentifier: input.issueIdentifier,
            issueTitle: input.issueTitle,
            projectName: input.projectName ?? null,
            sourceMessageId: input.sourceMessageId ?? null,
            payload: input.payload ?? {},
          });
          results.push({
            recipient: result.recipient,
            status: result.status,
            reason: result.reason,
            messageId: result.messageId,
            threadId: result.threadId,
            error: result.error,
            notificationId: result.notificationId,
          });
        } catch (err) {
          results.push({
            recipient,
            status: "skipped",
            reason: "send_failed",
            messageId: null,
            threadId: null,
            error: err instanceof Error ? err.message : String(err),
            notificationId: null,
          });
        }
      }

      return results;
    },

    processInboundMessage: async (
      companyId: string,
      message: AgentmailMessage,
      meta: AgentmailInboundProcessMeta,
    ) => {
      const messageId = safeText(message.messageId);
      if (!messageId) {
        return { status: "ignored" as const, reason: "missing_message_id" as const };
      }

      const storedPayload = {
        transport: meta.transport,
        eventType: meta.eventType ?? null,
        message,
        ...(meta.rawPayload !== undefined ? { raw: meta.rawPayload } : {}),
      } satisfies Record<string, unknown>;

      const [delivery] = await db
        .insert(agentmailWebhookDeliveries)
        .values({
          companyId,
          messageId,
          threadId: safeText(message.threadId) || null,
          sourceMailbox: safeText(message.from?.email) || null,
          status: "processing",
          payload: storedPayload,
        })
        .onConflictDoNothing({
          target: [agentmailWebhookDeliveries.companyId, agentmailWebhookDeliveries.messageId],
        })
        .returning({ id: agentmailWebhookDeliveries.id });

      if (!delivery) {
        return { status: "duplicate" as const };
      }

      try {
        const company = await getCompanySettings(companyId);
        const replyContext = await findMatchingNotificationReply(companyId, message);
        if (replyContext) {
          const note = readMessageBodyText(message) || null;
          const linkedIssueId = replyContext.issueId;
          const linkedApprovalId = replyContext.approvalId;
          let linkedIssue = linkedIssueId ? await issues.getById(linkedIssueId) : null;
          if (!linkedIssue && linkedApprovalId) {
            linkedIssue = (await resolveIssueForApproval(linkedApprovalId))?.issue ?? null;
          }

          if (linkedIssue) {
            await addSystemIssueComment(
              linkedIssue.id,
              buildNotificationReplyComment({
                stage:
                  replyContext.stage === "product_owner_confirmation_requested"
                    ? "product_owner_confirmation_requested"
                    : "tech_review_requested",
                senderEmail: safeText(message.from?.email) || null,
                messageId,
                note,
              }),
            );

            if (linkedIssue.assigneeAgentId) {
              await queueAgentWakeup(linkedIssue.assigneeAgentId, {
                reason: "agentmail_notification_reply_received",
                issueId: linkedIssue.id,
                approvalId: linkedApprovalId ?? null,
                requestedByActorType: "system",
                requestedByActorId: "agentmail",
                payload: {
                  sourceMessageId: messageId,
                  stage: replyContext.stage,
                  senderEmail: safeText(message.from?.email) || null,
                  transport: meta.transport,
                },
                source: `agentmail.notification.reply.${meta.transport}`,
              });
            }

            await logActivity(db, {
              companyId,
              actorType: "system",
              actorId: "agentmail",
              action: "agentmail.notification_reply_logged",
              entityType: "issue",
              entityId: linkedIssue.id,
              details: {
                issueId: linkedIssue.id,
                approvalId: linkedApprovalId,
                messageId,
                senderEmail: safeText(message.from?.email) || null,
                stage: replyContext.stage,
                notificationId: replyContext.id,
                transport: meta.transport,
              },
            });
          }

          const currentApproval = linkedApprovalId ? await approvalsSvc.getById(linkedApprovalId) : null;

          await db
            .update(agentmailWebhookDeliveries)
            .set({
              status: "processed",
              linkedIssueId: linkedIssue?.id ?? replyContext.issueId,
              linkedApprovalId,
              approvalStatus: currentApproval?.status ?? null,
              outboundStatus: "reply_comment_added",
              processedAt: new Date(),
            })
            .where(and(
              eq(agentmailWebhookDeliveries.id, delivery.id),
              eq(agentmailWebhookDeliveries.companyId, companyId),
            ));

          return {
            status: "reply_processed" as const,
            issueId: linkedIssue?.id ?? replyContext.issueId ?? null,
            approvalId: linkedApprovalId ?? null,
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

        if (!targetIssue) {
          targetIssue = await findLatestIssueForThread(companyId, safeText(message.threadId) || null);
        }

        const createdSubIssueTitles: string[] = [];
        const updatedSubIssueTitles: string[] = [];
        const hadExistingTargetIssue = Boolean(targetIssue);
        const nextDescription = buildRequirementPacket({
          issue: targetIssue
            ? {
                id: targetIssue.id,
                identifier: targetIssue.identifier ?? null,
                title: targetIssue.title,
                description: targetIssue.description ?? null,
              }
            : null,
          message,
          extraction,
          resolvedProject,
          createdSubIssueTitles,
          updatedSubIssueTitles,
        });

        if (!targetIssue) {
          targetIssue = await issues.create(companyId, {
            title: extraction.title,
            description: nextDescription,
            createdByUserId: "system-agentmail",
            status: "blocked",
            priority: "medium",
            projectId: resolvedProjectId,
          });
        } else {
          await cancelActiveIssueRun({
            id: targetIssue.id,
            companyId: targetIssue.companyId,
            assigneeAgentId: targetIssue.assigneeAgentId ?? null,
          });
          await issues.update(targetIssue.id, {
            title: extraction.title,
            status: "blocked",
            assigneeAgentId: null,
            description: nextDescription,
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
          });
        }

        if (hadExistingTargetIssue) {
          await addSystemIssueComment(
            targetIssue.id,
            buildUpdateComment(message, extraction, createdSubIssueTitles, updatedSubIssueTitles),
          );
        }

        await cancelOpenApprovalsForIssue(
          targetIssue.id,
          AGENTMAIL_PRODUCT_OWNER_APPROVAL_TYPE,
          "Superseded by new AgentMail intake.",
        );
        await cancelOpenApprovalsForIssue(
          targetIssue.id,
          AGENTMAIL_TECH_REVIEW_APPROVAL_TYPE,
          "Superseded by new AgentMail intake.",
        );
        await cancelOpenApprovalsForIssue(
          targetIssue.id,
          AGENTMAIL_LEGACY_REQUIREMENT_APPROVAL_TYPE,
          "Superseded by new AgentMail intake.",
        );

        const subIssueTitles = [...createdSubIssueTitles, ...updatedSubIssueTitles];
        const outboundStatus = "awaiting_ceo_analysis";

        await db
          .update(agentmailWebhookDeliveries)
          .set({
            status: "processed",
            linkedIssueId: targetIssue.id,
            linkedApprovalId: null,
            approvalStatus: null,
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
          action: "agentmail.inbound_processed",
          entityType: "issue",
          entityId: targetIssue.id,
          details: {
            messageId,
            threadId: safeText(message.threadId) || null,
            subject: extraction.rawSubject || null,
            canonicalSubject: extraction.canonicalSubject || null,
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
            linkedApprovalId: null,
            transport: meta.transport,
            eventType: meta.eventType ?? null,
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

    processWebhook: async (companyId: string, payload: AgentmailWebhookBody) => {
      const eventType = getWebhookEventType(payload);
      if (eventType && eventType !== "message.received") {
        logger.info({ companyId, eventType }, "AgentMail webhook ignored: unsupported event type");
        return { status: "ignored" as const, reason: eventType as string };
      }

      const message = normalizeAgentmailMessagePayload(payload);
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

      return service.processInboundMessage(companyId, message, {
        transport: "webhook",
        eventType: eventType ?? "message.received",
        rawPayload: payload,
      });
    },
  };

  return service;
}
