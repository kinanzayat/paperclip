import { describe, expect, it, vi } from "vitest";
import {
  agentmailService,
  buildRequirementPacket,
  canonicalizeAgentmailSubject,
  parseCeoApprovalComment,
  parseCtoIntakeComment,
  getWebhookEventType,
  normalizeAgentmailMessagePayload,
  parsePmClarificationComment,
  parseRequirementReviewComment,
  parseTechReviewComment,
} from "../services/agentmail.js";

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
        rawSubject: "[Project: HR] Build the approval loop",
        canonicalSubject: "[Project: HR] Build the approval loop",
        targetIssueId: null,
        targetIssueIdentifier: "PAP-17",
      },
      resolvedProject: { id: "project-1", name: "HR" },
      createdSubIssueTitles: [],
      updatedSubIssueTitles: [],
    });

    expect(packet).toContain("# Email Intake");
    expect(packet).toContain("## Summary");
    expect(packet).toContain("Analyze the email and update the issue tree.");
    expect(packet).toContain("## Requirements");
    expect(packet).toContain("1. add approval reply");
    expect(packet).toContain("2. update issue description");
    expect(packet).toContain("PAP-17");
    expect(packet).toContain("CEO intake, PM clarification, CEO approval, and CTO technical review are required");
    expect(packet).toContain("CTO implementation begins only after CEO approval and CTO technical review are complete.");
  });

  it("canonicalizes forwarded email subjects before intake routing", () => {
    expect(canonicalizeAgentmailSubject("Fwd: [Project: HR] Feature Import Custody for HR"))
      .toBe("[Project: HR] Feature Import Custody for HR");
    expect(canonicalizeAgentmailSubject("FW: Re: Fwd: [Project: HR] Feature Import Custody for HR"))
      .toBe("[Project: HR] Feature Import Custody for HR");
  });

  it("normalizes websocket message payloads into the shared AgentMail message shape", () => {
    const normalized = normalizeAgentmailMessagePayload({
      message: {
        inboxId: "inbox-1",
        threadId: "thread-1",
        messageId: "msg-1",
        labels: ["inbox"],
        timestamp: "2026-04-14T09:00:00.000Z",
        from: "Sender Name <sender@example.com>",
        to: ["recipient@example.com"],
        subject: "Realtime message",
        text: "Plain text body",
        html: "<p>Plain text body</p>",
        attachments: [
          {
            file_name: "requirements.pdf",
            content_type: "application/pdf",
            size: "1200",
            url: "https://files.example/requirements.pdf",
          },
          {
            name: "notes.txt",
            mime_type: "text/plain",
            text: "Attachment notes",
          },
        ],
        size: 42,
        updatedAt: "2026-04-14T09:00:00.000Z",
        createdAt: "2026-04-14T09:00:00.000Z",
      },
    });

    expect(normalized).toEqual(expect.objectContaining({
      messageId: "msg-1",
      threadId: "thread-1",
      subject: "Realtime message",
      textBody: "Plain text body",
      htmlBody: "<p>Plain text body</p>",
      from: {
        email: "sender@example.com",
        name: "Sender Name",
      },
      attachments: [
        expect.objectContaining({
          filename: "requirements.pdf",
          mimeType: "application/pdf",
          byteSize: 1200,
          downloadUrl: "https://files.example/requirements.pdf",
        }),
        expect.objectContaining({
          filename: "notes.txt",
          mimeType: "text/plain",
          textContent: "Attachment notes",
        }),
      ],
    }));
  });

  it("parses the PM clarification template", () => {
    const parsed = parsePmClarificationComment(`
<!-- paperclip:agentmail-pm-review -->
## Owner Summary
Clarify the feature in a simpler way for the product owner.

## Follow-up Questions
1. Should this apply to all projects?

## Recommended Requirement
Refine the issue in Paperclip first, then request product-owner confirmation.

## Notes For Tech
The CTO should review the clarified requirement against the repo before implementation.
`);

    expect(parsed).toEqual({
      ownerSummary: "Clarify the feature in a simpler way for the product owner.",
      followUpQuestions: "1. Should this apply to all projects?",
      recommendedRequirement: "Refine the issue in Paperclip first, then request product-owner confirmation.",
      notesForTech: "The CTO should review the clarified requirement against the repo before implementation.",
    });
  });

  it("parses the CTO intake handoff template", () => {
    const parsed = parseCtoIntakeComment(`
<!-- paperclip:agentmail-cto-intake -->
## Repo Summary
The repo already has approval primitives and issue comments we can reuse.

## Implementation Constraints
Do not commit to stakeholder wording that ignores the current access-control model.

## PM Follow Up
Confirm whether phone data access is needed for every HR role or only managers.

## Recommended Requirement
Clarify the target roles first, then ask for explicit product-owner approval on the narrowed scope.
`);

    expect(parsed).toEqual({
      repoSummary: "The repo already has approval primitives and issue comments we can reuse.",
      implementationConstraints:
        "Do not commit to stakeholder wording that ignores the current access-control model.",
      pmFollowUp: "Confirm whether phone data access is needed for every HR role or only managers.",
      recommendedRequirement:
        "Clarify the target roles first, then ask for explicit product-owner approval on the narrowed scope.",
    });
  });

  it("parses the CEO approval template", () => {
    const parsed = parseCeoApprovalComment(`
<!-- paperclip:agentmail-ceo-approval -->
## Decision
Approved

## Rationale
The requirement is now clear enough for technical review.

## Notes For CTO
Preserve the narrowed HR scope and keep implementation incremental.
`);

    expect(parsed).toEqual({
      decision: "Approved",
      rationale: "The requirement is now clear enough for technical review.",
      notesForCto: "Preserve the narrowed HR scope and keep implementation incremental.",
    });
  });

  it("parses the CTO tech review template", () => {
    const parsed = parseTechReviewComment(`
<!-- paperclip:agentmail-tech-review -->
## Fits Current Code
The issue can reuse the existing approval and comment pipeline.

## Open Questions
Should PM review always notify the configured product-owner email?

## Red Flags
There is no existing Mattermost integration in this repo.

## Implementation Notes
Keep replies as plain issue comments and do not auto-approve from email.
`);

    expect(parsed).toEqual({
      fitsCurrentCode: "The issue can reuse the existing approval and comment pipeline.",
      openQuestions: "Should PM review always notify the configured product-owner email?",
      redFlags: "There is no existing Mattermost integration in this repo.",
      implementationNotes: "Keep replies as plain issue comments and do not auto-approve from email.",
    });
  });

  it("still parses the legacy analyzer template for historical approvals", () => {
    const parsed = parseRequirementReviewComment(`
<!-- paperclip:agentmail-requirement-review -->
## Requested Change
Refine the raw email into an implementation-ready requirement.

## Feasible Now
We can inspect the current routing and approval plumbing.

## Hard Or Risky Parts
The current flow wakes CEO and CTO too early.

## Scope Cuts And Tradeoffs
Use approvals and blocked/todo instead of inventing new statuses.

## Recommended Requirement
Require PM review and manual confirmation before implementation.

## Proposed Issue Breakdown
1. PM gate
2. Product-owner confirmation
3. Approved handoff
`);

    expect(parsed).toEqual({
      requestedChange: "Refine the raw email into an implementation-ready requirement.",
      feasibleNow: "We can inspect the current routing and approval plumbing.",
      hardOrRiskyParts: "The current flow wakes CEO and CTO too early.",
      scopeCutsAndTradeoffs: "Use approvals and blocked/todo instead of inventing new statuses.",
      recommendedRequirement: "Require PM review and manual confirmation before implementation.",
      proposedIssueBreakdown: "1. PM gate\n2. Product-owner confirmation\n3. Approved handoff",
    });
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
