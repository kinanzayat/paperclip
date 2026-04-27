import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentmailNotebookIssueLinks,
  agentmailNotebooks,
  agentmailWebhookDeliveries,
} from "@paperclipai/db";
import { agentmailNotebookService } from "../services/agentmail-notebooklm.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

function createFakeDb() {
  const notebooks: Array<typeof agentmailNotebooks.$inferSelect> = [];
  const links: Array<typeof agentmailNotebookIssueLinks.$inferSelect> = [];
  const deliveries: Array<typeof agentmailWebhookDeliveries.$inferSelect> = [];

  const tableRows = (table: unknown) => {
    if (table === agentmailNotebooks) return notebooks;
    if (table === agentmailNotebookIssueLinks) return links;
    if (table === agentmailWebhookDeliveries) return deliveries;
    return [];
  };

  return {
    rows: { notebooks, links, deliveries },
    db: {
      insert(table: unknown) {
        let value: any;
        return {
          values(next: any) {
            value = next;
            return this;
          },
          onConflictDoUpdate() {
            return this;
          },
          onConflictDoNothing() {
            void this.returning();
            return this;
          },
          returning() {
            const rows = tableRows(table) as any[];
            if (table === agentmailNotebooks) {
              const existing = rows.find((row) => row.companyId === value.companyId && row.messageId === value.messageId);
              if (existing) {
                Object.assign(existing, value);
                return Promise.resolve([existing]);
              }
            }
            if (table === agentmailNotebookIssueLinks) {
              const existing = rows.find(
                (row) => row.notebookRecordId === value.notebookRecordId && row.issueId === value.issueId,
              );
              if (existing) return Promise.resolve([existing]);
            }
            const row = {
              id: value.id ?? `row-${rows.length + 1}`,
              createdAt: value.createdAt ?? new Date("2026-04-14T00:00:00.000Z"),
              updatedAt: value.updatedAt ?? new Date("2026-04-14T00:00:00.000Z"),
              sourceMetadata: {},
              notebookId: null,
              lastSyncedAt: null,
              ...value,
            };
            rows.push(row);
            return Promise.resolve([row]);
          },
          then(resolve: (value: unknown) => unknown) {
            return this.returning().then(resolve);
          },
        };
      },
      update(table: unknown) {
        let patch: any;
        return {
          set(next: any) {
            patch = next;
            return this;
          },
          where() {
            const rows = tableRows(table) as any[];
            if (table === agentmailNotebooks) {
              Object.assign(rows[0], patch);
            }
            return Promise.resolve([]);
          },
        };
      },
      select(selection?: Record<string, unknown>) {
        let tableRef: unknown;
        return {
          from(table: unknown) {
            tableRef = table;
            return this;
          },
          where() {
            return this;
          },
          then(resolve: (value: unknown) => unknown) {
            const rows = tableRows(tableRef) as any[];
            const selected = selection?.issueId
              ? rows.map((row) => ({ issueId: row.issueId }))
              : rows;
            return Promise.resolve(selected).then(resolve);
          },
        };
      },
    },
  };
}

describe("agentmailNotebookService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_NOTEBOOKLM_ENABLED = "true";
    delete process.env.PAPERCLIP_NOTEBOOKLM_ATTACHMENT_MAX_BYTES;
    delete process.env.PAPERCLIP_NOTEBOOKLM_ALLOWED_MIME_TYPES;

    mockExecFile.mockImplementation((_command: any, args: any, _options: any, callback: any) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv[0] === "login") {
        callback(null, "", "");
        return {} as any;
      }
      if (argv[0] === "notebook" && argv[1] === "create") {
        callback(null, JSON.stringify({ notebookId: "notebook-1" }), "");
        return {} as any;
      }
      if (argv[0] === "source" && argv[1] === "add" && argv.includes("--text")) {
        callback(null, JSON.stringify({ sourceId: "source-text" }), "");
        return {} as any;
      }
      if (argv[0] === "source" && argv[1] === "add" && argv.includes("--file")) {
        callback(null, JSON.stringify({ sourceId: "source-file" }), "");
        return {} as any;
      }
      callback(null, "{}", "");
      return {} as any;
    });
  });

  it("creates a notebook, uploads canonical text, uploads supported attachments, and records skips", async () => {
    const { db, rows } = createFakeDb();
    const svc = agentmailNotebookService(db as any);

    const result = await svc.syncAgentmailNotebook({
      companyId: "company-1",
      deliveryId: "delivery-1",
      issueId: "issue-1",
      message: {
        messageId: "message-1",
        threadId: "thread-1",
        subject: "Build imports",
        from: { email: "sender@example.com" },
        to: ["team@example.com"],
        cc: [],
        textBody: "Please build imports.",
        htmlBody: null,
        receivedAt: null,
        fireflies: null,
        requirements: null,
        attachments: [
          {
            filename: "requirements.txt",
            mimeType: "text/plain",
            textContent: "Attachment requirement",
          },
          {
            filename: "screenshot.png",
            mimeType: "image/png",
            base64Content: "aWdub3Jl",
          },
        ],
      },
      extraction: {
        title: "Build imports",
        summary: "Build importer flow",
        items: [{ title: "Import CSV" }],
        projectReference: null,
        rawSubject: "Build imports",
        canonicalSubject: "Build imports",
      },
    });

    expect(result.status).toBe("synced");
    expect(rows.notebooks[0]).toEqual(expect.objectContaining({
      notebookId: "notebook-1",
      syncStatus: "synced",
      error: null,
    }));
    expect(rows.links).toHaveLength(1);
    expect(rows.notebooks[0]?.sourceMetadata).toEqual(expect.objectContaining({
      canonicalSourceId: "source-text",
      attachmentSourceIds: ["source-file"],
      skippedAttachments: [
        expect.objectContaining({
          filename: "screenshot.png",
          mimeType: "image/png",
          reason: "unsupported_mime",
        }),
      ],
    }));
    expect(mockExecFile).toHaveBeenCalledWith("nlm", ["login", "--check"], expect.any(Object), expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledWith(
      "nlm",
      expect.arrayContaining(["source", "add", "notebook-1", "--text"]),
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "nlm",
      expect.arrayContaining(["source", "add", "notebook-1", "--file"]),
      expect.any(Object),
      expect.any(Function),
    );
  });
});
