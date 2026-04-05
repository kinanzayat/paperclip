import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createCompanyIssueStatusSchema,
  deleteCompanyIssueStatusSchema,
  reorderCompanyIssueStatusesSchema,
  updateCompanyIssueStatusSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, companyStatusService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function statusRoutes(db: Db) {
  const router = Router();
  const statuses = companyStatusService(db);
  const access = accessService(db);

  async function assertCompanyAdmin(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      return;
    }
    const allowed = await access.isCompanyAdmin(companyId, req.actor.userId);
    if (!allowed) {
      throw forbidden("Company admin required");
    }
  }

  router.get("/companies/:companyId/statuses", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await statuses.list(companyId));
  });

  router.post("/companies/:companyId/statuses", validate(createCompanyIssueStatusSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAdmin(req, companyId);
    const created = await statuses.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company_status.created",
      entityType: "company_status",
      entityId: created.id,
      details: {
        slug: created.slug,
        label: created.label,
        category: created.category,
      },
    });
    res.status(201).json(created);
  });

  router.patch("/companies/:companyId/statuses/:statusId", validate(updateCompanyIssueStatusSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const statusId = req.params.statusId as string;
    await assertCompanyAdmin(req, companyId);
    const updated = await statuses.update(companyId, statusId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Status not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company_status.updated",
      entityType: "company_status",
      entityId: updated.id,
      details: {
        slug: updated.slug,
        label: updated.label,
        category: updated.category,
      },
    });
    res.json(updated);
  });

  router.post("/companies/:companyId/statuses/reorder", validate(reorderCompanyIssueStatusesSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAdmin(req, companyId);
    const reordered = await statuses.reorder(companyId, req.body.statusIds);
    res.json(reordered);
  });

  router.delete("/companies/:companyId/statuses/:statusId", validate(deleteCompanyIssueStatusSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const statusId = req.params.statusId as string;
    await assertCompanyAdmin(req, companyId);
    const removed = await statuses.remove(companyId, statusId, req.body.replacementSlug);
    if (!removed) {
      res.status(404).json({ error: "Status not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company_status.deleted",
      entityType: "company_status",
      entityId: removed.id,
      details: {
        slug: removed.slug,
        label: removed.label,
        category: removed.category,
        replacementSlug: req.body.replacementSlug ?? null,
      },
    });
    res.json(removed);
  });

  return router;
}
