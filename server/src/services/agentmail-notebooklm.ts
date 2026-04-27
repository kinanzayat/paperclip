import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentmailNotebookIssueLinks,
  agentmailNotebooks,
  agentmailWebhookDeliveries,
} from "@paperclipai/db";
import type { AgentmailAttachment, AgentmailMessage, AgentmailRequirementItem } from "@paperclipai/shared";
import { agentmailMessageSchema } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const execFile = promisify(execFileCallback);

const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_ALLOWED_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export type AgentmailNotebookSyncStatus = "pending" | "syncing" | "synced" | "failed" | "disabled";

type RequirementExtractionSnapshot = {
  title: string;
  summary: string;
  items: AgentmailRequirementItem[];
  projectReference: string | null;
  rawSubject: string;
  canonicalSubject: string;
};

type NotebookCommandResult = {
  stdout: string;
  stderr: string;
};

type PreparedAttachment = {
  path: string;
  title: string;
};

function notebooklmEnabled() {
  return process.env.PAPERCLIP_NOTEBOOKLM_ENABLED?.trim().toLowerCase() === "true";
}

function attachmentMaxBytes() {
  const raw = process.env.PAPERCLIP_NOTEBOOKLM_ATTACHMENT_MAX_BYTES?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_ATTACHMENT_MAX_BYTES;
}

function allowedMimeTypes() {
  const raw = process.env.PAPERCLIP_NOTEBOOKLM_ALLOWED_MIME_TYPES?.trim()
    ?? process.env.PAPERCLIP_NOTEBOOKLM_ATTACHMENT_MIME_TYPES?.trim();
  if (!raw) return new Set(DEFAULT_ALLOWED_MIME_TYPES);
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function sanitizeTitle(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 120) || "AgentMail intake";
}

function shortMessageId(messageId: string) {
  const normalized = messageId.replace(/[^a-zA-Z0-9_-]+/g, "").trim();
  return (normalized || messageId).slice(0, 12);
}

function buildNotebookTitle(message: AgentmailMessage) {
  return sanitizeTitle(`AgentMail ${shortMessageId(message.messageId)} - ${safeText(message.subject) || "(no subject)"}`);
}

function firefliesTranscriptText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const candidates = [
    record.transcript,
    record.transcriptText,
    record.transcript_text,
    record.summary,
    record.notes,
  ];
  return candidates.map(safeText).filter(Boolean).join("\n\n");
}

function buildCanonicalEmailSource(input: {
  message: AgentmailMessage;
  extraction?: RequirementExtractionSnapshot | null;
}) {
  const { message, extraction } = input;
  const lines = [
    "# AgentMail Source",
    `Message ID: ${message.messageId}`,
    `Thread ID: ${safeText(message.threadId) || "none"}`,
    `Subject: ${safeText(message.subject) || "(no subject)"}`,
    `From: ${safeText(message.from?.name) ? `${message.from?.name} <${message.from?.email}>` : safeText(message.from?.email) || "unknown"}`,
    `To: ${(message.to ?? []).join(", ") || "none"}`,
    `Cc: ${(message.cc ?? []).join(", ") || "none"}`,
    "",
    "## Raw Email Body",
    safeText(message.textBody) || safeText(message.htmlBody) || "No body text was provided.",
  ];

  if (extraction) {
    lines.push(
      "",
      "## Extracted Requirement",
      `Title: ${extraction.title}`,
      extraction.projectReference ? `Project reference: ${extraction.projectReference}` : "Project reference: none",
      "",
      "### Summary",
      extraction.summary || "No summary extracted.",
      "",
      "### Requirement Items",
      ...(extraction.items.length > 0
        ? extraction.items.map((item, index) => `${index + 1}. ${item.title}${item.description ? ` - ${item.description}` : ""}`)
        : ["None extracted."]),
    );
  }

  const transcript = firefliesTranscriptText(message.fireflies);
  if (transcript) {
    lines.push("", "## Transcript", transcript);
  }

  return lines.join("\n");
}

function tryParseJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readCommandId(stdout: string, keys: string[]) {
  const parsed = tryParseJson(stdout);
  if (parsed) {
    for (const key of keys) {
      const value = safeText(parsed[key]);
      if (value) return value;
    }
  }

  const uuid = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid?.[0]) return uuid[0];

  const idMatch = stdout.match(/(?:notebook|source)?\s*id\s*[:=]\s*([^\s]+)/i);
  return idMatch?.[1]?.trim() ?? null;
}

async function runNlm(args: string[]): Promise<NotebookCommandResult> {
  const result = await execFile("nlm", args, {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  }) as unknown;
  if (typeof result === "string") {
    return { stdout: result, stderr: "" };
  }
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return { stdout: safeText(record.stdout), stderr: safeText(record.stderr) };
}

async function checkAuth() {
  await runNlm(["login", "--check"]);
}

function isAllowedAttachment(attachment: AgentmailAttachment, maxBytes: number, allowed: Set<string>) {
  const mimeType = safeText(attachment.mimeType).toLowerCase();
  if (!mimeType || !allowed.has(mimeType)) {
    return { ok: false as const, reason: "unsupported_mime" };
  }
  if (attachment.byteSize != null && attachment.byteSize > maxBytes) {
    return { ok: false as const, reason: "too_large" };
  }
  if (!attachment.textContent && !attachment.base64Content && !attachment.downloadUrl) {
    return { ok: false as const, reason: "no_content" };
  }
  return { ok: true as const };
}

function extensionForMime(mimeType: string) {
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "application/json") return ".json";
  if (mimeType === "text/markdown") return ".md";
  if (mimeType === "text/csv") return ".csv";
  if (mimeType.includes("wordprocessingml")) return ".docx";
  if (mimeType.includes("spreadsheetml")) return ".xlsx";
  if (mimeType.includes("msword")) return ".doc";
  if (mimeType.includes("ms-excel")) return ".xls";
  return ".txt";
}

function safeFilename(value: string | null | undefined, mimeType: string, index: number) {
  const fallback = `attachment-${index + 1}${extensionForMime(mimeType)}`;
  const candidate = safeText(value).replace(/[\\/:*?"<>|]+/g, "-").trim();
  return candidate || fallback;
}

async function prepareAttachmentFiles(attachments: AgentmailAttachment[]) {
  const maxBytes = attachmentMaxBytes();
  const allowed = allowedMimeTypes();
  const skipped: Array<{ filename: string | null; mimeType: string | null; byteSize: number | null; reason: string }> = [];
  const prepared: PreparedAttachment[] = [];
  let tempDir: string | null = null;

  for (const [index, attachment] of attachments.entries()) {
    const eligibility = isAllowedAttachment(attachment, maxBytes, allowed);
    if (!eligibility.ok) {
      skipped.push({
        filename: safeText(attachment.filename) || null,
        mimeType: safeText(attachment.mimeType) || null,
        byteSize: attachment.byteSize ?? null,
        reason: eligibility.reason,
      });
      continue;
    }

    let bytes: Buffer | null = null;
    if (attachment.textContent) {
      bytes = Buffer.from(attachment.textContent, "utf8");
    } else if (attachment.base64Content) {
      bytes = Buffer.from(attachment.base64Content, "base64");
    } else if (attachment.downloadUrl) {
      const response = await fetch(attachment.downloadUrl);
      if (!response.ok) {
        skipped.push({
          filename: safeText(attachment.filename) || null,
          mimeType: safeText(attachment.mimeType) || null,
          byteSize: attachment.byteSize ?? null,
          reason: `download_failed_${response.status}`,
        });
        continue;
      }
      const arrayBuffer = await response.arrayBuffer();
      bytes = Buffer.from(arrayBuffer);
    }

    if (!bytes || bytes.byteLength === 0) {
      skipped.push({
        filename: safeText(attachment.filename) || null,
        mimeType: safeText(attachment.mimeType) || null,
        byteSize: attachment.byteSize ?? null,
        reason: "empty_content",
      });
      continue;
    }

    if (bytes.byteLength > maxBytes) {
      skipped.push({
        filename: safeText(attachment.filename) || null,
        mimeType: safeText(attachment.mimeType) || null,
        byteSize: bytes.byteLength,
        reason: "too_large",
      });
      continue;
    }

    tempDir ??= await mkdtemp(path.join(os.tmpdir(), "paperclip-agentmail-nlm-"));
    const title = safeFilename(attachment.filename, safeText(attachment.mimeType).toLowerCase(), index);
    const filePath = path.join(tempDir, title);
    await writeFile(filePath, bytes);
    prepared.push({ path: filePath, title });
  }

  return { prepared, skipped, tempDir };
}

function parseStoredMessage(payload: unknown): AgentmailMessage | null {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const candidate = record?.message ?? payload;
  const parsed = agentmailMessageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function toStatusPayload(row: typeof agentmailNotebooks.$inferSelect | null, issueIds: string[] = []) {
  if (!row) {
    return {
      enabled: notebooklmEnabled(),
      status: notebooklmEnabled() ? "missing" : "disabled",
      notebookId: null,
      notebookTitle: null,
      messageId: null,
      threadId: null,
      error: notebooklmEnabled() ? null : "NotebookLM sync is disabled",
      lastSyncedAt: null,
      issueIds,
      sourceMetadata: {},
    };
  }
  return {
    enabled: notebooklmEnabled(),
    status: row.syncStatus,
    notebookId: row.notebookId,
    notebookTitle: row.notebookTitle,
    messageId: row.messageId,
    threadId: row.threadId,
    error: row.error,
    lastSyncedAt: row.lastSyncedAt,
    issueIds,
    sourceMetadata: row.sourceMetadata,
    linkPath: row.notebookId ? `https://notebooklm.google.com/notebook/${encodeURIComponent(row.notebookId)}` : null,
  };
}

export function agentmailNotebookService(db: Db) {
  async function upsertNotebookRecord(input: {
    companyId: string;
    deliveryId: string | null;
    messageId: string;
    threadId: string | null;
    notebookTitle: string | null;
    status: AgentmailNotebookSyncStatus;
    error?: string | null;
  }) {
    const now = new Date();
    const [row] = await db
      .insert(agentmailNotebooks)
      .values({
        companyId: input.companyId,
        deliveryId: input.deliveryId,
        messageId: input.messageId,
        threadId: input.threadId,
        notebookTitle: input.notebookTitle,
        syncStatus: input.status,
        error: input.error ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [agentmailNotebooks.companyId, agentmailNotebooks.messageId],
        set: {
          deliveryId: input.deliveryId,
          threadId: input.threadId,
          notebookTitle: input.notebookTitle,
          syncStatus: input.status,
          error: input.error ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  async function linkIssue(input: { companyId: string; notebookRecordId: string; issueId: string }) {
    await db
      .insert(agentmailNotebookIssueLinks)
      .values(input)
      .onConflictDoNothing({
        target: [agentmailNotebookIssueLinks.notebookRecordId, agentmailNotebookIssueLinks.issueId],
      });
  }

  async function getByIssue(issueId: string) {
    const link = await db
      .select()
      .from(agentmailNotebookIssueLinks)
      .where(eq(agentmailNotebookIssueLinks.issueId, issueId))
      .then((rows) => rows[0] ?? null);
    if (!link) return { row: null, issueIds: [] };
    const row = await db
      .select()
      .from(agentmailNotebooks)
      .where(and(
        eq(agentmailNotebooks.id, link.notebookRecordId),
        eq(agentmailNotebooks.companyId, link.companyId),
      ))
      .then((rows) => rows[0] ?? null);
    const issueIds = row
      ? await db
        .select({ issueId: agentmailNotebookIssueLinks.issueId })
        .from(agentmailNotebookIssueLinks)
        .where(eq(agentmailNotebookIssueLinks.notebookRecordId, row.id))
        .then((rows) => rows.map((entry) => entry.issueId))
      : [];
    return { row, issueIds };
  }

  async function getByMessage(companyId: string, messageId: string) {
    const row = await db
      .select()
      .from(agentmailNotebooks)
      .where(and(eq(agentmailNotebooks.companyId, companyId), eq(agentmailNotebooks.messageId, messageId)))
      .then((rows) => rows[0] ?? null);
    const issueIds = row
      ? await db
        .select({ issueId: agentmailNotebookIssueLinks.issueId })
        .from(agentmailNotebookIssueLinks)
        .where(eq(agentmailNotebookIssueLinks.notebookRecordId, row.id))
        .then((rows) => rows.map((entry) => entry.issueId))
      : [];
    return { row, issueIds };
  }

  async function updateSyncResult(
    id: string,
    patch: Partial<typeof agentmailNotebooks.$inferInsert>,
  ) {
    await db
      .update(agentmailNotebooks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentmailNotebooks.id, id));
  }

  return {
    isEnabled: notebooklmEnabled,

    statusForIssue: async (issueId: string) => {
      const { row, issueIds } = await getByIssue(issueId);
      return toStatusPayload(row, issueIds);
    },

    statusForMessage: async (companyId: string, messageId: string) => {
      const { row, issueIds } = await getByMessage(companyId, messageId);
      return toStatusPayload(row, issueIds);
    },

    queryIssueNotebook: async (issueId: string, question: string) => {
      const { row } = await getByIssue(issueId);
      if (!row || !row.notebookId || row.syncStatus !== "synced") {
        return {
          ok: false as const,
          status: row?.syncStatus ?? (notebooklmEnabled() ? "missing" : "disabled"),
          error: row?.error ?? "No synced NotebookLM notebook is linked to this issue.",
        };
      }
      const result = await runNlm(["notebook", "query", row.notebookId, question, "--json"]);
      return {
        ok: true as const,
        notebookId: row.notebookId,
        answer: tryParseJson(result.stdout) ?? { text: result.stdout.trim() },
      };
    },

    resyncMessageNotebook: async (companyId: string, messageId: string) => {
      const delivery = await db
        .select()
        .from(agentmailWebhookDeliveries)
        .where(and(
          eq(agentmailWebhookDeliveries.companyId, companyId),
          eq(agentmailWebhookDeliveries.messageId, messageId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!delivery) return { ok: false as const, status: "missing_delivery" as const };
      const message = parseStoredMessage(delivery.payload);
      if (!message) return { ok: false as const, status: "missing_message" as const };
      const service = agentmailNotebookService(db);
      await service.syncAgentmailNotebook({
        companyId,
        deliveryId: delivery.id,
        issueId: delivery.linkedIssueId,
        message,
        extraction: null,
      });
      return { ok: true as const, ...(await service.statusForMessage(companyId, messageId)) };
    },

    syncAgentmailNotebook: async (input: {
      companyId: string;
      deliveryId: string | null;
      issueId: string | null;
      message: AgentmailMessage;
      extraction?: RequirementExtractionSnapshot | null;
    }) => {
      const notebookTitle = buildNotebookTitle(input.message);
      const row = await upsertNotebookRecord({
        companyId: input.companyId,
        deliveryId: input.deliveryId,
        messageId: input.message.messageId,
        threadId: safeText(input.message.threadId) || null,
        notebookTitle,
        status: notebooklmEnabled() ? "syncing" : "disabled",
        error: notebooklmEnabled() ? null : "NotebookLM sync is disabled",
      });
      if (input.issueId) {
        await linkIssue({ companyId: input.companyId, notebookRecordId: row.id, issueId: input.issueId });
      }
      if (!notebooklmEnabled()) return toStatusPayload(row, input.issueId ? [input.issueId] : []);

      let tempDir: string | null = null;
      try {
        await checkAuth();

        let notebookId = row.notebookId;
        if (!notebookId) {
          const created = await runNlm(["notebook", "create", notebookTitle, "--json"]);
          notebookId = readCommandId(created.stdout, ["notebookId", "notebook_id", "id"]);
          if (!notebookId) {
            throw new Error(`NotebookLM notebook creation did not return an id: ${created.stdout || created.stderr}`);
          }
        }

        const canonicalSource = buildCanonicalEmailSource({
          message: input.message,
          extraction: input.extraction ?? null,
        });
        const canonicalUpload = await runNlm([
          "source",
          "add",
          notebookId,
          "--text",
          canonicalSource,
          "--title",
          "AgentMail email and extracted requirements",
          "--wait",
        ]);
        const canonicalSourceId = readCommandId(canonicalUpload.stdout, ["sourceId", "source_id", "id"]);

        const { prepared, skipped, tempDir: preparedTempDir } = await prepareAttachmentFiles(input.message.attachments ?? []);
        tempDir = preparedTempDir;
        const attachmentSourceIds: string[] = [];
        for (const attachment of prepared) {
          const result = await runNlm(["source", "add", notebookId, "--file", attachment.path, "--wait"]);
          const sourceId = readCommandId(result.stdout, ["sourceId", "source_id", "id"]);
          if (sourceId) attachmentSourceIds.push(sourceId);
        }

        await updateSyncResult(row.id, {
          notebookId,
          notebookTitle,
          syncStatus: "synced",
          error: null,
          lastSyncedAt: new Date(),
          sourceMetadata: {
            canonicalSourceId,
            attachmentSourceIds,
            skippedAttachments: skipped,
          },
        });

        return toStatusPayload({
          ...row,
          notebookId,
          notebookTitle,
          syncStatus: "synced",
          error: null,
          lastSyncedAt: new Date(),
          sourceMetadata: {
            canonicalSourceId,
            attachmentSourceIds,
            skippedAttachments: skipped,
          },
        }, input.issueId ? [input.issueId] : []);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await updateSyncResult(row.id, {
          syncStatus: "failed",
          error,
        });
        logger.warn(
          { err, companyId: input.companyId, deliveryId: input.deliveryId, messageId: input.message.messageId },
          "AgentMail NotebookLM sync failed",
        );
        return toStatusPayload({ ...row, syncStatus: "failed", error }, input.issueId ? [input.issueId] : []);
      } finally {
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };
}
