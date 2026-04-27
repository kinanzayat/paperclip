import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  accessService,
  agentmailService,
  approvalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

const AGENTMAIL_APPROVAL_TYPES = new Set([
  "agentmail_requirement_confirmation",
  "agentmail_product_owner_confirmation",
  "agentmail_tech_review",
]);

export function approvalRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const svc = approvalService(db);
  const agentmail = agentmailService(db);
  const heartbeat = heartbeatService(db);
  const issuesSvc = issueService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  function normalizeRequiredRoles(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    );
  }

  function defaultRequiredRolesForApprovalType(type: string): string[] {
    if (type === "requirement_product_owner_review") return ["product_owner_head"];
    if (type === "requirement_tech_review") return ["tech_team"];
    return [];
  }

  function resolveMemberApprovalRole(
    membership: { approvalRole?: string | null; membershipRole?: string | null } | null | undefined,
  ): string | null {
    if (membership?.approvalRole === "product_owner_head" || membership?.approvalRole === "tech_team") {
      return membership.approvalRole;
    }
    if (membership?.membershipRole === "product_owner_head" || membership?.membershipRole === "tech_team") {
      return membership.membershipRole;
    }
    return null;
  }

  async function sendRoleStageNotifications(input: {
    companyId: string;
    approvalId: string;
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    stage: "product_owner_confirmation_requested" | "tech_review_requested";
    roleType: "product_owner_head" | "tech_team";
    payload?: Record<string, unknown>;
  }) {
    const roleEmails = await svc.listRoleUserEmails(input.companyId, input.roleType);
    return agentmail.sendStageNotifications({
      companyId: input.companyId,
      issueId: input.issueId,
      approvalId: input.approvalId,
      stage: input.stage,
      issueIdentifier: input.issueIdentifier,
      issueTitle: input.issueTitle,
      recipients: roleEmails,
      payload: input.payload ?? {},
    });
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const requestedRequiredRoles = normalizeRequiredRoles(req.body.requiredRoles);
    const requiredRoles =
      requestedRequiredRoles.length > 0
        ? requestedRequiredRoles
        : defaultRequiredRolesForApprovalType(approvalInput.type);
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requiredRoles,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds, requiredRoles },
    });

    if (approval.type === "requirement_product_owner_review") {
      const primaryIssueId = uniqueIssueIds[0]
        ?? (typeof approval.payload?.issueId === "string" ? approval.payload.issueId : null);
      if (primaryIssueId) {
        const linkedIssue = await issuesSvc.getById(primaryIssueId);
        if (linkedIssue) {
          await sendRoleStageNotifications({
            companyId,
            approvalId: approval.id,
            issueId: linkedIssue.id,
            issueIdentifier: linkedIssue.identifier ?? linkedIssue.id,
            issueTitle: linkedIssue.title,
            stage: "product_owner_confirmation_requested",
            roleType: "product_owner_head",
            payload: { summary: "Requirement review required before technical review can start." },
          });
        }
      }
    }

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existingApproval = await svc.getById(id);
    if (!existingApproval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existingApproval.companyId);

    const requiredRoles = normalizeRequiredRoles(existingApproval.requiredRoles);
    let approvedByRoleType: string | null = null;
    if (requiredRoles.length > 0) {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
        approvedByRoleType = requiredRoles[0] ?? null;
      } else {
        const userId = req.actor.userId;
        if (!userId) {
          res.status(403).json({ error: "Only company members can approve this approval" });
          return;
        }
        const membership = await access.getMembership(existingApproval.companyId, "user", userId);
        const approvalRole = resolveMemberApprovalRole(membership);
        if (!approvalRole || !requiredRoles.includes(approvalRole)) {
          res.status(403).json({ error: `Only ${requiredRoles.join(", ")} members can approve this approval` });
          return;
        }
        approvedByRoleType = approvalRole;
      }
    }

    const { approval, applied } = await svc.approve(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
      { approvedByRoleType },
    );

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (AGENTMAIL_APPROVAL_TYPES.has(approval.type)) {
        await agentmail.onApprovalApproved({
          approvalId: approval.id,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          note: req.body.decisionNote ?? null,
        });
      } else if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      if (approval.type === "requirement_product_owner_review") {
        const transition = await svc.onProductOwnerApproved(approval.id);
        if (transition?.nextApproval) {
          if (linkedIssueIds.length > 0) {
            await issueApprovalsSvc.linkManyForApproval(transition.nextApproval.id, linkedIssueIds, {
              userId: req.actor.userId ?? null,
              agentId: req.actor.agentId,
            });
          }

          const issueId = transition.issueId ?? linkedIssueIds[0] ?? null;
          if (issueId) {
            const issue = await issuesSvc.getById(issueId);
            if (issue) {
              await sendRoleStageNotifications({
                companyId: approval.companyId,
                approvalId: transition.nextApproval.id,
                issueId: issue.id,
                issueIdentifier: issue.identifier ?? issue.id,
                issueTitle: issue.title,
                stage: "tech_review_requested",
                roleType: "tech_team",
                payload: { summary: "Product Owner Head approved. Tech team review is now required." },
              });
            }
          }
        }
      }

      if (approval.type === "requirement_tech_review") {
        const assignment = await svc.onTechTeamApprovalResolved(approval.id);
        if (assignment) {
          await issuesSvc.update(assignment.issueId, {
            assigneeAgentId: assignment.agentId,
            status: "todo",
          });
          await issuesSvc.addComment(
            assignment.issueId,
            "Tech team approved this requirement. Assigned to CTO for implementation on the same issue card.",
            { userId: "system" },
          );

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.cto_assigned",
            entityType: "issue",
            entityId: assignment.issueId,
            details: {
              approvalId: approval.id,
              ctoAgentId: assignment.agentId,
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existingApproval = await svc.getById(id);
    if (!existingApproval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existingApproval.companyId);

    const requiredRoles = normalizeRequiredRoles(existingApproval.requiredRoles);
    if (requiredRoles.length > 0 && !(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      const userId = req.actor.userId;
      if (!userId) {
        res.status(403).json({ error: "Only company members can reject this approval" });
        return;
      }
      const membership = await access.getMembership(existingApproval.companyId, "user", userId);
      const approvalRole = resolveMemberApprovalRole(membership);
      if (!approvalRole || !requiredRoles.includes(approvalRole)) {
        res.status(403).json({ error: `Only ${requiredRoles.join(", ")} members can reject this approval` });
        return;
      }
    }

    const { approval, applied } = await svc.reject(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
    );

    if (applied) {
      if (AGENTMAIL_APPROVAL_TYPES.has(approval.type)) {
        await agentmail.onApprovalRejected({
          approvalId: approval.id,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          note: req.body.decisionNote ?? null,
          action: "reject",
        });
      }
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existingApproval = await svc.getById(id);
      if (!existingApproval) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      assertCompanyAccess(req, existingApproval.companyId);

      const requiredRoles = normalizeRequiredRoles(existingApproval.requiredRoles);
      if (requiredRoles.length > 0 && !(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
        const userId = req.actor.userId;
        if (!userId) {
          res.status(403).json({ error: "Only company members can request revision for this approval" });
          return;
        }
        const membership = await access.getMembership(existingApproval.companyId, "user", userId);
        const approvalRole = resolveMemberApprovalRole(membership);
        if (!approvalRole || !requiredRoles.includes(approvalRole)) {
          res.status(403).json({ error: `Only ${requiredRoles.join(", ")} members can request revision` });
          return;
        }
      }

      const approval = await svc.requestRevision(
        id,
        req.body.decidedByUserId ?? "board",
        req.body.decisionNote,
      );

      if (AGENTMAIL_APPROVAL_TYPES.has(approval.type)) {
        await agentmail.onApprovalRejected({
          approvalId: approval.id,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          note: req.body.decisionNote ?? null,
          action: "edit",
        });
      }

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
