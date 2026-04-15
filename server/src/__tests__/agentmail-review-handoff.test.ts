import { agentmailWebhookDeliveries, companies } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentmailService } from "../services/agentmail.js";

const mockApprovalsService = vi.hoisted(() => ({
  getById: vi.fn(),
  updatePayload: vi.fn(),
  resubmit: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  getActiveRunForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
  listIssuesForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/approvals.js", () => ({
  approvalService: () => mockApprovalsService,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => mockProjectService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

function createDb() {
  let latestDeliveryPatch: Record<string, unknown> | null = null;

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          if (table === companies) {
            return {
              where: vi.fn().mockResolvedValue([
                {
                  productOwnerEmail: "owner@example.com",
                  techTeamEmail: "tech@example.com",
                },
              ]),
            };
          }

          if (table === agentmailWebhookDeliveries) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([
                  {
                    id: "delivery-1",
                    companyId: "company-1",
                    messageId: "msg-1",
                    threadId: "thread-1",
                    sourceMailbox: "sender@example.com",
                    payload: {
                      messageId: "msg-1",
                      threadId: "thread-1",
                      subject: "Need role-based data access",
                      from: { email: "sender@example.com" },
                      to: ["codex32@agentmail.to"],
                      cc: [],
                      textBody: "Please tighten access rules.",
                      htmlBody: null,
                      receivedAt: null,
                      fireflies: null,
                      requirements: null,
                    },
                  },
                ]),
              })),
            };
          }

          throw new Error("Unexpected select table in agentmail-review-handoff test");
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((patch: Record<string, unknown>) => {
          if (table === agentmailWebhookDeliveries) {
            latestDeliveryPatch = patch;
          }
          return {
            where: vi.fn().mockResolvedValue(undefined),
          };
        }),
      })),
    },
    getLatestDeliveryPatch() {
      return latestDeliveryPatch;
    },
  };
}

describe("AgentMail review handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-pm-1" });
    mockIssueService.addComment.mockResolvedValue(null);
    mockIssueService.update.mockResolvedValue(null);
  });

  it("hands a structured CEO intake comment to PM clarification", async () => {
    const { db, getLatestDeliveryPatch } = createDb();
    const service = agentmailService(db as any);

    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "B-42",
      title: "Need role-based data access",
      description: "Initial intake",
      status: "blocked",
      assigneeAgentId: "ceo-1",
    });

    mockAgentService.getById.mockResolvedValue({
      id: "ceo-1",
      companyId: "company-1",
      name: "CEO",
      role: "ceo",
      status: "active",
    });

    mockAgentService.list.mockResolvedValue([
      { id: "ceo-1", name: "CEO", role: "ceo", status: "active" },
      { id: "analyzer-1", name: "Product Analyzer", role: "product_analyzer", status: "active" },
      { id: "pm-1", name: "EVA PM", role: "pm", status: "active" },
    ]);

    const result = await service.handleRequirementReviewComment({
      issueId: "issue-1",
      commentId: "comment-1",
      authorAgentId: "ceo-1",
      commentBody: `
<!-- paperclip:agentmail-ceo-intake -->
## Repo Summary
The repo already has issue approvals and access-control checks we can reuse.

## Implementation Constraints
We should narrow the stakeholder request to the roles already modeled in the app.

## PM Follow Up
Clarify exactly which HR roles need phone-data access.

## Recommended Requirement
Ask the stakeholder to approve a narrowed role matrix before implementation starts.
`,
    });

    expect(result).toEqual({
      status: "processed",
      issueId: "issue-1",
      assigneeAgentId: "pm-1",
    });
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", {
      status: "blocked",
      assigneeAgentId: "pm-1",
    });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "pm-1",
      expect.objectContaining({
        reason: "agentmail_pm_clarification_requested",
        payload: expect.objectContaining({
          issueId: "issue-1",
          sourceMessageId: "msg-1",
          ceoReviewCommentId: "comment-1",
        }),
      }),
    );
    expect(getLatestDeliveryPatch()).toEqual(expect.objectContaining({
      outboundStatus: "awaiting_pm_clarification",
      linkedApprovalId: null,
      approvalStatus: null,
    }));
  });

  it("hands a PM clarification comment back to CEO approval", async () => {
    const { db, getLatestDeliveryPatch } = createDb();
    const service = agentmailService(db as any);

    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "B-42",
      title: "Need role-based data access",
      description: "Initial intake",
      status: "blocked",
      assigneeAgentId: "pm-1",
    });

    mockAgentService.getById.mockResolvedValue({
      id: "pm-1",
      companyId: "company-1",
      name: "EVA PM",
      role: "pm",
      status: "active",
    });

    mockAgentService.list.mockResolvedValue([
      { id: "ceo-1", name: "CEO", role: "ceo", status: "active" },
      { id: "cto-1", name: "CTO", role: "cto", status: "active" },
      { id: "pm-1", name: "EVA PM", role: "pm", status: "active" },
    ]);

    const result = await service.handleRequirementReviewComment({
      issueId: "issue-1",
      commentId: "comment-2",
      authorAgentId: "pm-1",
      commentBody: `
<!-- paperclip:agentmail-pm-review -->
## Owner Summary
The feature is narrowed to HR managers and HR admins.

## Follow-up Questions
1. Should export be included in v1?

## Recommended Requirement
Ship read and edit permissions separately, with manager-only defaults first.

## Notes For Tech
Keep the access model aligned with current role permissions.
`,
    });

    expect(result).toEqual({
      status: "processed",
      issueId: "issue-1",
      assigneeAgentId: "ceo-1",
      outboundStatus: "awaiting_ceo_approval",
    });
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", {
      status: "blocked",
      assigneeAgentId: "ceo-1",
    });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "ceo-1",
      expect.objectContaining({
        reason: "agentmail_ceo_approval_requested",
        payload: expect.objectContaining({
          issueId: "issue-1",
          sourceMessageId: "msg-1",
          pmReviewCommentId: "comment-2",
        }),
      }),
    );
    expect(getLatestDeliveryPatch()).toEqual(expect.objectContaining({
      outboundStatus: "awaiting_ceo_approval",
      linkedApprovalId: null,
      approvalStatus: null,
    }));
  });

  it("hands an approved CEO comment to CTO technical review", async () => {
    const { db, getLatestDeliveryPatch } = createDb();
    const service = agentmailService(db as any);

    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "B-42",
      title: "Need role-based data access",
      description: "Initial intake",
      status: "blocked",
      assigneeAgentId: "ceo-1",
    });

    mockAgentService.getById.mockResolvedValue({
      id: "ceo-1",
      companyId: "company-1",
      name: "CEO",
      role: "ceo",
      status: "active",
    });

    mockAgentService.list.mockResolvedValue([
      { id: "ceo-1", name: "CEO", role: "ceo", status: "active" },
      { id: "cto-1", name: "CTO", role: "cto", status: "active" },
      { id: "pm-1", name: "EVA PM", role: "pm", status: "active" },
    ]);

    const result = await service.handleRequirementReviewComment({
      issueId: "issue-1",
      commentId: "comment-3",
      authorAgentId: "ceo-1",
      commentBody: `
<!-- paperclip:agentmail-ceo-approval -->
## Decision
Approved

## Rationale
The requirement is clear enough to send into technical review.

## Notes For CTO
Keep the first iteration limited to HR managers and admins.
`,
    });

    expect(result).toEqual({
      status: "processed",
      issueId: "issue-1",
      assigneeAgentId: "cto-1",
      outboundStatus: "awaiting_tech_review",
    });
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", {
      status: "blocked",
      assigneeAgentId: "cto-1",
    });
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-1",
      "CEO approved the clarified requirement. CTO technical review is now required before implementation.",
      { userId: "system-agentmail" },
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "cto-1",
      expect.objectContaining({
        reason: "agentmail_tech_review_requested",
        payload: expect.objectContaining({
          issueId: "issue-1",
          sourceMessageId: "msg-1",
          ceoApprovalCommentId: "comment-3",
        }),
      }),
    );
    expect(getLatestDeliveryPatch()).toEqual(expect.objectContaining({
      outboundStatus: "awaiting_tech_review",
      linkedApprovalId: null,
      approvalStatus: null,
    }));
  });
});
