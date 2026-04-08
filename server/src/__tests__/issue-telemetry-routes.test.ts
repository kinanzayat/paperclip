import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockTrackAgentTaskCompleted = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

const mockCompanyStatusService = vi.hoisted(() => {
  const resolveCategory = (slug: string) => {
    switch (slug) {
      case "done":
        return "completed";
      case "cancelled":
        return "cancelled";
      case "blocked":
        return "blocked";
      case "in_progress":
      case "in_review":
        return "started";
      default:
        return "unstarted";
    }
  };

  const defaultSlugByCategory: Record<string, string> = {
    unstarted: "todo",
    started: "in_progress",
    blocked: "blocked",
    completed: "done",
    cancelled: "cancelled",
  };

  const makeStatus = (companyId: string, slug: string) => ({
    id: `status-${slug}`,
    companyId,
    slug,
    label: slug,
    category: resolveCategory(slug),
    color: "#64748b",
    position: 0,
    isDefault: slug === "todo" || slug === "in_progress",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  return {
    ensureDefaults: vi.fn(async () => []),
    getDefault: vi.fn(async (companyId: string, category: string) =>
      makeStatus(companyId, defaultSlugByCategory[category] ?? "todo")),
    listSlugsByCategory: vi.fn(async (_companyId: string, category: string) =>
      category === "blocked" ? ["blocked"] : []),
    requireBySlug: vi.fn(async (companyId: string, slug: string) => makeStatus(companyId, slug)),
    getBySlug: vi.fn(async (companyId: string, slug: string) => makeStatus(companyId, slug)),
    listOpenSlugs: vi.fn(async () => ["backlog", "todo", "in_progress", "blocked"]),
    isTerminalCategory: vi.fn((category: string) => category === "completed" || category === "cancelled"),
  };
});

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: mockTrackAgentTaskCompleted,
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentmailService: () => ({
    handleRequirementReviewComment: vi.fn(async () => ({ status: "ignored" })),
  }),
  agentService: () => mockAgentService,
  companyStatusService: () => mockCompanyStatusService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({
    reportRunActivity: vi.fn(async () => undefined),
  }),
  instanceSettingsService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function makeIssue(status: "todo" | "done") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    statusDetails: {
      id: `status-${status}`,
      companyId: "company-1",
      slug: status,
      label: status,
      category: status === "done" ? "completed" : "unstarted",
      color: "#64748b",
      position: 0,
      isDefault: status === "todo",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1018",
    title: "Telemetry test",
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue telemetry routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(patch.status === "done" ? "done" : "todo"),
      ...patch,
    }));
  });

  it("emits task-completed telemetry with the agent role", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      adapterType: "codex_local",
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: null,
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockTrackAgentTaskCompleted).toHaveBeenCalledWith(expect.anything(), {
      agentRole: "engineer",
    });
  });

  it("does not emit agent task-completed telemetry for board-driven completions", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockTrackAgentTaskCompleted).not.toHaveBeenCalled();
    expect(mockAgentService.getById).not.toHaveBeenCalled();
  });
});
