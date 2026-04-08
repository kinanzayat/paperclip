import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentmailWebhookBodySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { companyService } from "../services/companies.js";
import { agentmailService } from "../services/agentmail.js";
import { issueService } from "../services/issues.js";
import { agentService } from "../services/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { logActivity } from "../services/activity-log.js";

function readWebhookMessageId(payload: unknown): string | null {
  const root = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
  if (!root) return null;
  const direct = root.messageId;
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  const nested = typeof root.message === "object" && root.message !== null ? root.message as Record<string, unknown> : null;
  const nestedId = nested?.messageId ?? nested?.message_id;
  return typeof nestedId === "string" && nestedId.trim().length > 0 ? nestedId.trim() : null;
}

function pickAnalysisAgent(input: {
  assigneeAgentId: string | null;
  availableAgents: Array<{ id: string; name: string; role: string; status: string }>;
}) {
  if (input.assigneeAgentId) {
    const assigned = input.availableAgents.find(
      (agent) =>
        agent.id === input.assigneeAgentId
        && agent.role === "product_analyzer"
        && agent.status !== "paused"
        && agent.status !== "terminated"
        && agent.status !== "pending_approval",
    );
    if (assigned) return assigned;
  }

  const active = input.availableAgents.filter(
    (agent) =>
      agent.status !== "paused"
      && agent.status !== "terminated"
      && agent.status !== "pending_approval",
  );
  return active.find((agent) => agent.role === "product_analyzer") ?? null;
}

export function agentmailRoutes(db: Db) {
  const router = Router();
  const companies = companyService(db);
  const svc = agentmailService(db);
  const issues = issueService(db);
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);

  router.post(
    "/companies/:companyId/webhooks/agentmail",
    validate(agentmailWebhookBodySchema),
    async (req, res) => {
      const expectedSecret = process.env.PAPERCLIP_AGENTMAIL_WEBHOOK_SECRET?.trim();
      if (expectedSecret) {
        const providedSecret = req.header("x-agentmail-webhook-secret")?.trim();
        if (!providedSecret || providedSecret !== expectedSecret) {
          res.status(401).json({ error: "Invalid AgentMail webhook secret" });
          return;
        }
      }

      const companyId = req.params.companyId as string;
      const company = await companies.getById(companyId);
      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }

      const result = await svc.processWebhook(companyId, req.body);

      let analysisRunId: string | null = null;
      let analysisAgentId: string | null = null;
      let analysisWakeupError: string | null = null;

      if ((result as { status?: string }).status === "processed") {
        const issueId = (result as { issueId?: string }).issueId;
        if (issueId) {
          try {
            const issue = await issues.getById(issueId);
            if (issue && issue.companyId === companyId) {
              const availableAgents = await agents.list(companyId);
              const selectedAgent = pickAnalysisAgent({
                assigneeAgentId: issue.assigneeAgentId ?? null,
                availableAgents: availableAgents.map((agent) => ({
                  id: agent.id,
                  name: agent.name,
                  role: agent.role,
                  status: agent.status,
                })),
              });

              if (selectedAgent) {
                const nextPatch: { assigneeAgentId?: string; status?: string } = {};
                if (!issue.assigneeAgentId || issue.assigneeAgentId !== selectedAgent.id) {
                  nextPatch.assigneeAgentId = selectedAgent.id;
                }
                if (issue.status !== "blocked" && issue.status !== "done" && issue.status !== "cancelled") {
                  nextPatch.status = "blocked";
                }
                if (Object.keys(nextPatch).length > 0) {
                  await issues.update(issue.id, nextPatch);
                }

                const wakeRun = await heartbeat.wakeup(selectedAgent.id, {
                  source: "automation",
                  triggerDetail: "system",
                  reason: "agentmail_requirement_analysis",
                  payload: {
                    issueId: issue.id,
                    taskId: issue.id,
                    source: "agentmail.webhook",
                    messageId: readWebhookMessageId(req.body),
                  },
                  requestedByActorType: "system",
                  requestedByActorId: "agentmail_webhook",
                  contextSnapshot: {
                    issueId: issue.id,
                    source: "agentmail.webhook",
                  },
                });

                analysisRunId = (wakeRun as { id?: string } | null)?.id ?? null;
                analysisAgentId = selectedAgent.id;

                if (analysisRunId) {
                  await logActivity(db, {
                    companyId,
                    actorType: "system",
                    actorId: "agentmail",
                    action: "agentmail.analysis_wakeup_queued",
                    entityType: "issue",
                    entityId: issue.id,
                    details: {
                      issueId: issue.id,
                      agentId: selectedAgent.id,
                      runId: analysisRunId,
                    },
                  });
                }
              } else {
                const nextPatch: { assigneeAgentId?: string | null; status?: string } = {};
                if (issue.assigneeAgentId) {
                  nextPatch.assigneeAgentId = null;
                }
                if (issue.status !== "backlog" && issue.status !== "done" && issue.status !== "cancelled") {
                  nextPatch.status = "backlog";
                }
                if (Object.keys(nextPatch).length > 0) {
                  await issues.update(issue.id, nextPatch);
                }
                logger.warn({ companyId, issueId }, "AgentMail webhook processed but no Product Analyzer is available");
                await logActivity(db, {
                  companyId,
                  actorType: "system",
                  actorId: "agentmail",
                  action: "agentmail.awaiting_analyzer_agent",
                  entityType: "issue",
                  entityId: issue.id,
                  details: {
                    issueId: issue.id,
                    messageId: readWebhookMessageId(req.body),
                    state: "awaiting_analyzer_agent",
                  },
                });
              }
            }
          } catch (err) {
            analysisWakeupError = err instanceof Error ? err.message : String(err);
            logger.warn({ err, companyId, issueId }, "AgentMail analysis wakeup failed");
            try {
              await logActivity(db, {
                companyId,
                actorType: "system",
                actorId: "agentmail",
                action: "agentmail.analysis_wakeup_failed",
                entityType: "issue",
                entityId: issueId,
                details: {
                  issueId,
                  error: analysisWakeupError,
                },
              });
            } catch (activityErr) {
              logger.warn(
                { err: activityErr, companyId, issueId },
                "AgentMail analysis wakeup failure activity logging failed",
              );
            }
          }
        }
      }

      res.status(200).json({
        ok: true,
        ...result,
        analysisAgentId,
        analysisRunId,
        analysisWakeupError,
      });
    },
  );

  return router;
}
