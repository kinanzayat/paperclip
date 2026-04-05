import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { statusRoutes } from "../routes/statuses.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";

const sampleStatus = {
  id: "status-1",
  companyId,
  slug: "ready_for_qa",
  label: "Ready for QA",
  category: "started",
  color: "#2563eb",
  position: 3,
  isDefault: false,
  createdAt: new Date("2026-04-05T00:00:00.000Z"),
  updatedAt: new Date("2026-04-05T00:00:00.000Z"),
};

const mockStatusService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  reorder: vi.fn(),
  remove: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  isCompanyAdmin: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  companyStatusService: () => mockStatusService,
  accessService: () => mockAccessService,
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", statusRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("status routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusService.list.mockResolvedValue([sampleStatus]);
    mockStatusService.create.mockResolvedValue(sampleStatus);
    mockStatusService.update.mockResolvedValue(sampleStatus);
    mockStatusService.reorder.mockResolvedValue([sampleStatus]);
    mockStatusService.remove.mockResolvedValue(sampleStatus);
    mockAccessService.isCompanyAdmin.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("allows company members to list statuses", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/companies/${companyId}/statuses`);

    expect(res.status).toBe(200);
    expect(mockStatusService.list).toHaveBeenCalledWith(companyId);
    expect(res.body).toHaveLength(1);
  });

  it("rejects status creation for non-admin company members", async () => {
    mockAccessService.isCompanyAdmin.mockResolvedValue(false);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/statuses`)
      .send({
        slug: "ready_for_qa",
        label: "Ready for QA",
        category: "started",
        color: "#2563eb",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/company admin required/i);
    expect(mockStatusService.create).not.toHaveBeenCalled();
  });

  it("allows status creation for company admins", async () => {
    mockAccessService.isCompanyAdmin.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/statuses`)
      .send({
        slug: "ready_for_qa",
        label: "Ready for QA",
        category: "started",
        color: "#2563eb",
      });

    expect(res.status).toBe(201);
    expect(mockStatusService.create).toHaveBeenCalledWith(companyId, {
      slug: "ready_for_qa",
      label: "Ready for QA",
      category: "started",
      color: "#2563eb",
    });
  });
});
