import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentmailWebhookBodySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyService } from "../services/companies.js";
import { agentmailService } from "../services/agentmail.js";
import { queueInitialAgentmailAnalysis } from "../services/agentmail-intake.js";
import { agentmailInboundListener, isAgentmailInboundWebsocketModeEnabled } from "../services/agentmail-inbound.js";

function readWebhookMessageId(payload: unknown): string | null {
  const root = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
  if (!root) return null;
  const direct = root.messageId;
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  const nested = typeof root.message === "object" && root.message !== null ? root.message as Record<string, unknown> : null;
  const nestedId = nested?.messageId ?? nested?.message_id;
  return typeof nestedId === "string" && nestedId.trim().length > 0 ? nestedId.trim() : null;
}

export function agentmailRoutes(db: Db) {
  const router = Router();
  const companies = companyService(db);
  const svc = agentmailService(db);

  router.get("/companies/:companyId/agentmail/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    res.status(200).json(agentmailInboundListener.getStatus(companyId));
  });

  router.post(
    "/companies/:companyId/webhooks/agentmail",
    (req, res, next) => {
      if (isAgentmailInboundWebsocketModeEnabled()) {
        res.status(410).json({
          error: "AgentMail webhook intake is disabled while websocket inbound transport is enabled",
          transportMode: "websocket",
        });
        return;
      }
      next();
    },
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
          const wake = await queueInitialAgentmailAnalysis(db, {
            companyId,
            issueId,
            messageId: readWebhookMessageId(req.body),
            source: "agentmail.webhook",
          });
          analysisAgentId = wake.analysisAgentId;
          analysisRunId = wake.analysisRunId;
          analysisWakeupError = wake.analysisWakeupError;
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
