import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { agentService } from "./agents.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";

type AnalysisAgentSummary = {
  id: string;
  name: string;
  role: string;
  status: string;
};

export type AgentmailRequirementAnalysisResult = {
  analysisAgentId: string | null;
  analysisRunId: string | null;
  analysisWakeupError: string | null;
};

function isActiveAgentStatus(status: string) {
  return status !== "paused" && status !== "terminated" && status !== "pending_approval";
}

function pickAnalysisAgent(input: {
  assigneeAgentId: string | null;
  availableAgents: AnalysisAgentSummary[];
}) {
  const active = input.availableAgents.filter((agent) => isActiveAgentStatus(agent.status));
  if (input.assigneeAgentId) {
    const assigned = active.find((agent) => agent.id === input.assigneeAgentId && agent.role === "ceo");
    if (assigned) return assigned;
  }
  return active.find((agent) => agent.role === "ceo") ?? null;
}

export async function queueInitialAgentmailAnalysis(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    messageId?: string | null;
    source: "agentmail.webhook" | "agentmail.websocket";
  },
): Promise<AgentmailRequirementAnalysisResult> {
  const issues = issueService(db);
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);

  let analysisRunId: string | null = null;
  let analysisAgentId: string | null = null;
  let analysisWakeupError: string | null = null;

  try {
    const issue = await issues.getById(input.issueId);
    if (!issue || issue.companyId !== input.companyId) {
      return { analysisAgentId, analysisRunId, analysisWakeupError };
    }

    const availableAgents = await agents.list(input.companyId);
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
          source: input.source,
          ...(input.messageId ? { messageId: input.messageId } : {}),
        },
        requestedByActorType: "system",
        requestedByActorId: input.source === "agentmail.websocket" ? "agentmail_websocket" : "agentmail_webhook",
        contextSnapshot: {
          issueId: issue.id,
          source: input.source,
        },
      });

      analysisRunId = (wakeRun as { id?: string } | null)?.id ?? null;
      analysisAgentId = selectedAgent.id;

      if (analysisRunId) {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "system",
          actorId: "agentmail",
          action: "agentmail.analysis_wakeup_queued",
          entityType: "issue",
          entityId: issue.id,
          details: {
            issueId: issue.id,
            agentId: selectedAgent.id,
            runId: analysisRunId,
            transport: input.source === "agentmail.websocket" ? "websocket" : "webhook",
          },
        });
      }

      return { analysisAgentId, analysisRunId, analysisWakeupError };
    }

    const nextPatch: { assigneeAgentId?: string | null; status?: string } = {};
    if (issue.assigneeAgentId) {
      nextPatch.assigneeAgentId = null;
    }
    if (issue.status !== "blocked" && issue.status !== "done" && issue.status !== "cancelled") {
      nextPatch.status = "blocked";
    }
    if (Object.keys(nextPatch).length > 0) {
      await issues.update(issue.id, nextPatch);
    }

    logger.warn(
      { companyId: input.companyId, issueId: input.issueId, source: input.source },
      "AgentMail intake processed but no CEO intake agent is available",
    );
    await issues.addComment(
      issue.id,
      "AgentMail intake is blocked because no active CEO agent is currently available.",
      { userId: "system-agentmail" },
    );
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "agentmail",
      action: "agentmail.awaiting_ceo_agent",
      entityType: "issue",
      entityId: issue.id,
      details: {
        issueId: issue.id,
        messageId: input.messageId ?? null,
        state: "awaiting_ceo_agent",
        transport: input.source === "agentmail.websocket" ? "websocket" : "webhook",
      },
    });
  } catch (err) {
    analysisWakeupError = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, companyId: input.companyId, issueId: input.issueId, source: input.source },
      "AgentMail analysis wakeup failed",
    );
    try {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "agentmail",
        action: "agentmail.analysis_wakeup_failed",
        entityType: "issue",
        entityId: input.issueId,
        details: {
          issueId: input.issueId,
          error: analysisWakeupError,
          transport: input.source === "agentmail.websocket" ? "websocket" : "webhook",
        },
      });
    } catch (activityErr) {
      logger.warn(
        { err: activityErr, companyId: input.companyId, issueId: input.issueId },
        "AgentMail analysis wakeup failure activity logging failed",
      );
    }
  }

  return { analysisAgentId, analysisRunId, analysisWakeupError };
}
