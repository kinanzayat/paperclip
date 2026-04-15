import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueInitialAgentmailAnalysis } from "../services/agentmail-intake.js";

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

describe("queueInitialAgentmailAnalysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.update.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue(null);
  });

  it("assigns an active CEO and queues the first analysis wakeup", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      assigneeAgentId: null,
      status: "blocked",
    });
    mockAgentService.list.mockResolvedValue([
      { id: "ceo-1", name: "CEO", role: "ceo", status: "idle" },
      { id: "pm-1", name: "EVA PM", role: "pm", status: "idle" },
    ]);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-1" });

    const result = await queueInitialAgentmailAnalysis({} as any, {
      companyId: "company-1",
      issueId: "issue-1",
      messageId: "msg-1",
      source: "agentmail.websocket",
    });

    expect(result).toEqual({
      analysisAgentId: "ceo-1",
      analysisRunId: "run-1",
      analysisWakeupError: null,
    });
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", {
      assigneeAgentId: "ceo-1",
    });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("ceo-1", expect.objectContaining({
      reason: "agentmail_requirement_analysis",
      payload: expect.objectContaining({
        issueId: "issue-1",
        messageId: "msg-1",
      }),
    }));
  });

  it("adds a visible issue comment when no active CEO is available", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-2",
      companyId: "company-1",
      assigneeAgentId: "old-ceo",
      status: "todo",
    });
    mockAgentService.list.mockResolvedValue([
      { id: "ceo-paused", name: "CEO", role: "ceo", status: "paused" },
      { id: "pm-1", name: "EVA PM", role: "pm", status: "idle" },
    ]);

    const result = await queueInitialAgentmailAnalysis({} as any, {
      companyId: "company-1",
      issueId: "issue-2",
      messageId: "msg-2",
      source: "agentmail.websocket",
    });

    expect(result).toEqual({
      analysisAgentId: null,
      analysisRunId: null,
      analysisWakeupError: null,
    });
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-2", {
      assigneeAgentId: null,
      status: "blocked",
    });
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-2",
      "AgentMail intake is blocked because no active CEO agent is currently available.",
      { userId: "system-agentmail" },
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
