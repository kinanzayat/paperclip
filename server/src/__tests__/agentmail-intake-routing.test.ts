import { agentmailOutboundNotifications, agentmailWebhookDeliveries, companies } from "@paperclipai/db";
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
  cancelRun: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
  listIssuesForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
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

function createDb(input?: {
  priorThreadDeliveries?: Array<Record<string, unknown>>;
}) {
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

          if (table === agentmailOutboundNotifications) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([]),
              })),
            };
          }

          if (table === agentmailWebhookDeliveries) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue(input?.priorThreadDeliveries ?? []),
              })),
            };
          }

          throw new Error("Unexpected select table in agentmail-intake-routing test");
        }),
      })),
      insert: vi.fn((table: unknown) => {
        if (table !== agentmailWebhookDeliveries) {
          throw new Error("Unexpected insert table in agentmail-intake-routing test");
        }
        return {
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "delivery-new-1" }]),
            })),
          })),
        };
      }),
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

describe("AgentMail intake routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue(null);
    mockProjectService.list.mockResolvedValue([
      { id: "project-hr", name: "HR" },
      { id: "project-ops", name: "Ops" },
    ]);
  });

  it("reuses the existing issue for the same email thread and canonicalizes forwarded subjects", async () => {
    const { db, getLatestDeliveryPatch } = createDb({
      priorThreadDeliveries: [
        {
          id: "delivery-old-1",
          companyId: "company-1",
          threadId: "thread-1",
          linkedIssueId: "issue-1",
        },
      ],
    });
    const service = agentmailService(db as any);

    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id !== "issue-1") return null;
      return {
        id: "issue-1",
        companyId: "company-1",
        identifier: "B-10",
        title: "Old forwarded title",
        description: "Old description",
        status: "blocked",
        assigneeAgentId: null,
        projectId: null,
      };
    });

    const result = await service.processInboundMessage("company-1", {
      messageId: "msg-new-1",
      threadId: "thread-1",
      subject: "Fwd: [Project: HR] Feature Import Custody for HR",
      from: { email: "sender@example.com" },
      to: ["codex32@agentmail.to"],
      cc: [],
      textBody: "- add CSV import\n- improve notes columns",
      htmlBody: null,
      receivedAt: null,
      fireflies: null,
      requirements: null,
    } as any, {
      transport: "websocket",
      eventType: "message.received",
    });

    expect(result).toEqual({
      status: "processed",
      issueId: "issue-1",
      issueIdentifier: "B-10",
      subIssueCount: 0,
      outboundStatus: "awaiting_ceo_analysis",
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", expect.objectContaining({
      title: "Feature Import Custody for HR",
      status: "blocked",
      assigneeAgentId: null,
      projectId: "project-hr",
    }));
    expect(mockIssueService.update.mock.calls[0]?.[1]?.description).toContain("- Subject: [Project: HR] Feature Import Custody for HR");
    expect(mockIssueService.update.mock.calls[0]?.[1]?.description).toContain("- Raw subject: Fwd: [Project: HR] Feature Import Custody for HR");
    expect(getLatestDeliveryPatch()).toEqual(expect.objectContaining({
      linkedIssueId: "issue-1",
      outboundStatus: "awaiting_ceo_analysis",
    }));
  });

  it("routes forwarded messages to the requested project from nested Subject headers", async () => {
    const { db } = createDb();
    const service = agentmailService(db as any);

    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue({
      id: "issue-created-1",
      companyId: "company-1",
      identifier: "B-11",
    });

    const result = await service.processInboundMessage("company-1", {
      messageId: "msg-new-2",
      threadId: "thread-2",
      subject: "Fwd: meeting notes",
      from: { email: "sender@example.com" },
      to: ["codex32@agentmail.to"],
      cc: [],
      textBody: [
        "---------- Forwarded message ---------",
        "Subject: [Project: HR] Feature Import Custody for HR",
        "",
        "- add CSV import",
      ].join("\n"),
      htmlBody: null,
      receivedAt: null,
      fireflies: null,
      requirements: null,
    } as any, {
      transport: "websocket",
      eventType: "message.received",
    });

    expect(result).toEqual({
      status: "processed",
      issueId: "issue-created-1",
      issueIdentifier: "B-11",
      subIssueCount: 0,
      outboundStatus: "awaiting_ceo_analysis",
    });
    expect(mockIssueService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      title: "meeting notes",
      projectId: "project-hr",
      status: "blocked",
    }));
  });
});
