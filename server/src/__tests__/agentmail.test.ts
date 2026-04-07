import { describe, expect, it, vi } from "vitest";
import { agentmailService, buildAnalyzerBody, buildRequirementPacket, getWebhookEventType } from "../services/agentmail.js";

describe("agentmail helpers", () => {
  it("identifies blocked webhook events", () => {
    expect(
      getWebhookEventType({
        event_id: "evt-1",
        event_type: "message.received.blocked",
        message: {
          message_id: "msg-1",
          subject: "Blocked test",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          text: "Hello",
        },
        thread: {
          thread_id: "thread-1",
          subject: "Blocked test",
        },
        type: "event",
      } as any),
    ).toBe("message.received.blocked");
  });

  it("builds a markdown requirement packet", () => {
    const packet = buildRequirementPacket({
      issue: {
        id: "issue-1",
        identifier: "PAP-17",
        title: "Initial title",
        description: null,
      },
      message: {
        messageId: "msg-1",
        subject: "[Project: HR] Build the approval loop",
        threadId: "thread-1",
        from: { email: "sender@example.com", name: "Sender" },
        to: ["recipient@example.com"],
        cc: [],
        textBody: "- add approval reply\n- update issue description",
        htmlBody: null,
        receivedAt: null,
        fireflies: null,
        requirements: null,
      } as any,
      extraction: {
        title: "Build the approval loop",
        summary: "Analyze the email and update the issue tree.",
        items: [
          { title: "add approval reply", priority: "medium" },
          { title: "update issue description", priority: "high" },
        ],
        projectReference: "HR",
        targetIssueId: null,
        targetIssueIdentifier: "PAP-17",
      },
      resolvedProject: { id: "project-1", name: "HR" },
      createdSubIssueTitles: ["add approval reply"],
      updatedSubIssueTitles: ["update issue description"],
    });

    expect(packet).toContain("# Email Intake");
    expect(packet).toContain("## Summary");
    expect(packet).toContain("Analyze the email and update the issue tree.");
    expect(packet).toContain("## Requirements");
    expect(packet).toContain("1. add approval reply");
    expect(packet).toContain("2. update issue description");
    expect(packet).toContain("## Created sub-issues");
    expect(packet).toContain("## Updated sub-issues");
    expect(packet).toContain("PAP-17");
  });

  it("builds a plain-text markdown approval reply", () => {
    const body = buildAnalyzerBody({
      issueIdentifier: "PAP-17",
      issueTitle: "Build the approval loop",
      summary: "Analyze the email and update the issue tree.",
      subIssueTitles: ["add approval reply", "update issue description"],
      createdSubIssueTitles: ["add approval reply"],
      updatedSubIssueTitles: ["update issue description"],
      sourceMessageId: "msg-1",
      projectName: "HR",
      senderEmail: "sender@example.com",
    });

    expect(body).toContain("**AgentMail analysis for PAP-17**");
    expect(body).toContain("## Reply with one of the following");
    expect(body).toContain("- approve");
    expect(body).toContain("- reject");
    expect(body).toContain("- clarify");
    expect(body).toContain("## Created this round");
    expect(body).toContain("## Updated this round");
  });
});

describe("agentmail service", () => {
  it("ignores blocked events before touching the database", async () => {
    const db = {
      insert: vi.fn(),
      update: vi.fn(),
      select: vi.fn(),
    } as any;
    const service = agentmailService(db);

    const result = await service.processWebhook("company-1", {
      event_id: "evt-1",
      event_type: "message.received.blocked",
      message: {
        message_id: "msg-1",
        subject: "Blocked test",
        from: "sender@example.com",
        to: ["recipient@example.com"],
        text: "Hello",
      },
      thread: {
        thread_id: "thread-1",
        subject: "Blocked test",
      },
      type: "event",
    } as any);

    expect(result).toEqual({ status: "ignored", reason: "message.received.blocked" });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
