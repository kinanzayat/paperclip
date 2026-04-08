import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentmailRoutes } from "../routes/agentmail.js";

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentmailService = vi.hoisted(() => ({
  processWebhook: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/companies.js", () => ({
  companyService: () => mockCompanyService,
}));

vi.mock("../services/agentmail.js", () => ({
  agentmailService: () => mockAgentmailService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", agentmailRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("AgentMail webhook routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_AGENTMAIL_WEBHOOK_SECRET = "test-secret-123";
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.update.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-1" });
  });

  it("rejects webhook without secret when secret is configured", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Company",
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/webhooks/agentmail")
      .send({
        event_type: "message.received",
        message: {
          messageId: "msg-123",
          subject: "Test",
          from: { email: "sender@example.com" },
          to: ["recipient@example.com"],
          text: "Test message",
        },
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid AgentMail webhook secret");
  });

  it("rejects webhook with invalid secret", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Company",
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/webhooks/agentmail")
      .set("x-agentmail-webhook-secret", "wrong-secret")
      .send({
        event_type: "message.received",
        message: {
          messageId: "msg-123",
          subject: "Test",
          from: { email: "sender@example.com" },
          to: ["recipient@example.com"],
          text: "Test message",
        },
      });

    expect(res.status).toBe(401);
  });

  it("processes webhook with valid secret", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Company",
    });
    mockAgentmailService.processWebhook.mockResolvedValue({
      status: "processed",
      issueId: "issue-1",
      subIssueCount: 0,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/webhooks/agentmail")
      .set("x-agentmail-webhook-secret", "test-secret-123")
      .send({
        event_type: "message.received",
        message: {
          messageId: "msg-123",
          subject: "Test",
          from: { email: "sender@example.com" },
          to: ["recipient@example.com"],
          text: "Test message",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe("processed");
    expect(mockAgentmailService.processWebhook).toHaveBeenCalled();
  });

  it("does not wake CEO or CTO when no Product Analyzer exists", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Company",
    });
    mockAgentmailService.processWebhook.mockResolvedValue({
      status: "processed",
      issueId: "issue-1",
      subIssueCount: 0,
    });
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "ceo-1",
    });
    mockAgentService.list.mockResolvedValue([
      { id: "ceo-1", name: "CEO", role: "ceo", status: "active" },
      { id: "cto-1", name: "CTO", role: "cto", status: "active" },
    ]);

    const res = await request(createApp())
      .post("/api/companies/company-1/webhooks/agentmail")
      .set("x-agentmail-webhook-secret", "test-secret-123")
      .send({
        event_type: "message.received",
        message: {
          messageId: "msg-no-analyzer",
          subject: "Need gated requirement review",
          from: { email: "sender@example.com" },
          to: ["recipient@example.com"],
          text: "Please review first",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.analysisAgentId).toBeNull();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", {
      assigneeAgentId: null,
      status: "backlog",
    });
  });

  it("wakes only the Product Analyzer and blocks the issue until approval", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Company",
    });
    mockAgentmailService.processWebhook.mockResolvedValue({
      status: "processed",
      issueId: "issue-1",
      subIssueCount: 0,
    });
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "backlog",
      assigneeAgentId: null,
    });
    mockAgentService.list.mockResolvedValue([
      { id: "ceo-1", name: "CEO", role: "ceo", status: "active" },
      { id: "pa-1", name: "Product Analyzer", role: "product_analyzer", status: "idle" },
    ]);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });

    const res = await request(createApp())
      .post("/api/companies/company-1/webhooks/agentmail")
      .set("x-agentmail-webhook-secret", "test-secret-123")
      .send({
        event_type: "message.received",
        message: {
          messageId: "msg-analyzer",
          subject: "Need requirement review",
          from: { email: "sender@example.com" },
          to: ["recipient@example.com"],
          text: "Analyze this before implementation",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.analysisAgentId).toBe("pa-1");
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", {
      assigneeAgentId: "pa-1",
      status: "blocked",
    });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "pa-1",
      expect.objectContaining({
        reason: "agentmail_requirement_analysis",
      }),
    );
  });

  it("rejects webhook for non-existent company", async () => {
    mockCompanyService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .post("/api/companies/company-missing/webhooks/agentmail")
      .set("x-agentmail-webhook-secret", "test-secret-123")
      .send({
        event_type: "message.received",
        message: {
          messageId: "msg-123",
          subject: "Test",
          from: { email: "sender@example.com" },
          to: ["recipient@example.com"],
          text: "Test message",
        },
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Company not found");
  });

  it("handles real-world message.received payload with all fields", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Company",
    });
    mockAgentmailService.processWebhook.mockResolvedValue({
      status: "processed",
      issueId: "issue-1",
      subIssueCount: 0,
    });

    // Exact payload structure from AgentMail message.received event
    const agentmailPayload = {
      event_id: "evt_3C1hqrqmSX8h3AHtMxim6svy",
      event_type: "message.received",
      message: {
        attachments: [
          {
            attachment_id: "att_3C1hqrqmSX8h3AHtMxim6svy",
            content_disposition: "attachment",
            content_id: "content-id",
            content_type: "application/pdf",
            filename: "document.pdf",
            size: 42,
          },
        ],
        bcc: ["bcc@example.com"],
        cc: ["cc@example.com"],
        created_at: "2026-03-20T21:45:00.635654189",
        extracted_html: "<p>Message body in HTML</p>",
        extracted_text: "Message body in plain text",
        from: "Sender Name <sender@example.com>",
        headers: {
          "x-custom-header": "value",
        },
        html: "<p>Message body in HTML</p>",
        in_reply_to: "msg_prev_id",
        inbox_id: "inb_3C1hqrqmSX8h3AHtMxim6svy",
        labels: ["inbox"],
        message_id: "msg_3C1hqrqmSX8h3AHtMxim6svy",
        preview: "Message preview text",
        references: ["msg_ref_1", "msg_ref_2"],
        reply_to: ["reply-to@example.com"],
        size: 1024,
        subject: "[Project: HR] New requirements",
        text: "Message body in plain text",
        thread_id: "thr_3C1hqrqmSX8h3AHtMxim6svy",
        timestamp: "2026-03-20T21:45:00.635661864",
        to: ["recipient@example.com"],
        updated_at: "2026-03-20T21:45:00.635663189",
      },
      thread: {
        attachments: [],
        created_at: "2026-03-20T21:45:00.635686385",
        inbox_id: "inb_3C1hqrqmSX8h3AHtMxim6svy",
        labels: ["inbox"],
        last_message_id: "msg_3C1hqrqmSX8h3AHtMxim6svy",
        message_count: 1,
        preview: "Message preview text",
        received_timestamp: "2026-03-20T21:45:00.635688860",
        recipients: ["recipient@example.com"],
        senders: ["sender@example.com"],
        sent_timestamp: "2026-03-20T21:45:00.635690624",
        size: 1024,
        subject: "[Project: HR] New requirements",
        thread_id: "thr_3C1hqrqmSX8h3AHtMxim6svy",
        timestamp: "2026-03-20T21:45:00.635691988",
        updated_at: "2026-03-20T21:45:00.635692531",
      },
      type: "event",
    };

    const res = await request(createApp())
      .post("/api/companies/company-1/webhooks/agentmail")
      .set("x-agentmail-webhook-secret", "test-secret-123")
      .send(agentmailPayload);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockAgentmailService.processWebhook).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        event_type: "message.received",
        message: expect.objectContaining({
          message_id: "msg_3C1hqrqmSX8h3AHtMxim6svy",
          subject: "[Project: HR] New requirements",
        }),
      }),
    );
  });

  it("handles payload with message nested at envelope level", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Company",
    });
    mockAgentmailService.processWebhook.mockResolvedValue({
      status: "processed",
      issueId: "issue-1",
      subIssueCount: 0,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/webhooks/agentmail")
      .set("x-agentmail-webhook-secret", "test-secret-123")
      .send({
        event_type: "message.received",
        message: {
          message_id: "msg-123",
          subject: "Test with [Project: HR] tag",
          from: "user@example.com",
          to: ["recipient@example.com"],
          text: "Test message body",
          extracted_text: "Test message body",
          created_at: "2026-03-20T21:45:00Z",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockAgentmailService.processWebhook).toHaveBeenCalled();
  });

  it("handles payload with snake_case fields", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Company",
    });
    mockAgentmailService.processWebhook.mockResolvedValue({
      status: "processed",
      issueId: "issue-1",
      subIssueCount: 0,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/webhooks/agentmail")
      .set("x-agentmail-webhook-secret", "test-secret-123")
      .send({
        event_type: "message.received",
        message: {
          message_id: "msg-456",
          from_email: "sender@example.com",
          text_body: "Snake case plain text",
          html_body: "<p>Snake case HTML</p>",
          received_at: "2026-03-20T21:45:00Z",
          subject: "Snake case test",
          to: ["recipient@example.com"],
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("skips webhook when secret is not configured (dev mode)", async () => {
    delete process.env.PAPERCLIP_AGENTMAIL_WEBHOOK_SECRET;

    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Company",
    });
    mockAgentmailService.processWebhook.mockResolvedValue({
      status: "processed",
      issueId: "issue-1",
      subIssueCount: 0,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/webhooks/agentmail")
      .send({
        event_type: "message.received",
        message: {
          messageId: "msg-dev",
          subject: "Dev mode test",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          text: "Dev test",
        },
      });

    expect(res.status).toBe(200);
    expect(mockAgentmailService.processWebhook).toHaveBeenCalled();
  });
});
