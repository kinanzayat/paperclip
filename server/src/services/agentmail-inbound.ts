import type { Db } from "@paperclipai/db";
import { AgentMailClient } from "agentmail";
import { logger } from "../middleware/logger.js";
import { normalizeAgentmailMessagePayload, agentmailService } from "./agentmail.js";
import { queueInitialAgentmailAnalysis } from "./agentmail-intake.js";

type AgentmailInboundTransportMode = "webhook" | "websocket";

type AgentmailSocketLike = {
  on(event: "open", callback: () => void): void;
  on(event: "message", callback: (event: unknown) => void): void;
  on(event: "close", callback: (event: { code?: number; reason?: string }) => void): void;
  on(event: "error", callback: (error: Error) => void): void;
  sendSubscribe(message: unknown): void;
  close?(): void;
};

type AgentmailInboundConfig = {
  transportMode: AgentmailInboundTransportMode;
  apiKey: string | null;
  mailbox: string | null;
  companyId: string | null;
};

export type AgentmailInboundStatus = {
  transportMode: AgentmailInboundTransportMode;
  enabled: boolean;
  configuredInbox: string | null;
  configuredCompanyId: string | null;
  connected: boolean;
  subscribed: boolean;
  lastEventAt: string | null;
  lastMessageId: string | null;
  lastError: string | null;
  lastDisconnectAt: string | null;
};

type AgentmailInboundListenerDeps = {
  createSocket?: (apiKey: string) => Promise<AgentmailSocketLike>;
  createService?: (db: Db) => Pick<ReturnType<typeof agentmailService>, "processInboundMessage">;
  queueAnalysis?: typeof queueInitialAgentmailAnalysis;
  reconnectDelayMs?: number;
};

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isMessageReceivedEvent(event: unknown) {
  const record = safeRecord(event);
  if (!record) return false;
  return (
    record.type === "message_received"
    || (record.type === "event" && record.eventType === "message.received")
    || record.event_type === "message.received"
  );
}

function isSubscribedEvent(event: unknown) {
  const record = safeRecord(event);
  return record?.type === "subscribed";
}

function readEventMessageId(event: unknown): string | null {
  const record = safeRecord(event);
  const message = safeRecord(record?.message);
  return readText(message?.messageId ?? message?.message_id ?? record?.messageId ?? record?.message_id);
}

function readInboundConfig(): AgentmailInboundConfig {
  const configuredTransport = process.env.PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT?.trim().toLowerCase();
  return {
    transportMode: configuredTransport === "websocket" ? "websocket" : "webhook",
    apiKey: readText(process.env.PAPERCLIP_AGENTMAIL_API_KEY),
    mailbox: readText(process.env.PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX),
    companyId: readText(process.env.PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID),
  };
}

export function isAgentmailInboundWebsocketModeEnabled() {
  return readInboundConfig().transportMode === "websocket";
}

function defaultCreateSocket(apiKey: string) {
  const client = new AgentMailClient({ apiKey });
  return client.websockets.connect({
    waitForOpen: true,
    reconnectAttempts: 30,
    connectionTimeoutInSeconds: 15,
  });
}

export function createAgentmailInboundListener(deps: AgentmailInboundListenerDeps = {}) {
  const createSocket = deps.createSocket ?? defaultCreateSocket;
  const createService = deps.createService ?? ((db: Db) => agentmailService(db));
  const queueAnalysis = deps.queueAnalysis ?? queueInitialAgentmailAnalysis;
  const reconnectDelayMs = deps.reconnectDelayMs ?? 5_000;

  let dbRef: Db | null = null;
  let socket: AgentmailSocketLike | null = null;
  let connectInFlight = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let status: AgentmailInboundStatus = {
    transportMode: "webhook",
    enabled: false,
    configuredInbox: null,
    configuredCompanyId: null,
    connected: false,
    subscribed: false,
    lastEventAt: null,
    lastMessageId: null,
    lastError: null,
    lastDisconnectAt: null,
  };

  function resetRuntimeFields(next: Partial<AgentmailInboundStatus>) {
    status = {
      ...status,
      connected: false,
      subscribed: false,
      lastError: null,
      ...next,
    };
  }

  function scheduleReconnect(reason: string) {
    if (stopped || reconnectTimer || status.transportMode !== "websocket" || !status.enabled) return;
    logger.warn({ reason, delayMs: reconnectDelayMs }, "AgentMail inbound websocket connect failed; scheduling reconnect");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
  }

  function handleOpen() {
    if (!socket) return;
    status = {
      ...status,
      connected: true,
      subscribed: false,
      lastError: null,
    };
    logger.info({ inbox: status.configuredInbox }, "AgentMail inbound websocket connected");
    try {
      socket.sendSubscribe({
        type: "subscribe",
        inboxIds: status.configuredInbox ? [status.configuredInbox] : [],
        eventTypes: ["message.received"],
      });
      logger.info({ inbox: status.configuredInbox }, "AgentMail inbound websocket subscribe sent");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status = { ...status, lastError: message };
      logger.error({ err, inbox: status.configuredInbox }, "AgentMail inbound websocket subscribe failed");
    }
  }

  async function handleMessage(event: unknown) {
    if (isSubscribedEvent(event)) {
      status = { ...status, subscribed: true, lastError: null };
      logger.info({ inbox: status.configuredInbox }, "AgentMail inbound websocket subscribed");
      return;
    }

    if (!isMessageReceivedEvent(event)) {
      logger.debug({ eventType: safeRecord(event)?.type ?? safeRecord(event)?.eventType ?? null }, "AgentMail inbound websocket ignored unsupported event");
      return;
    }

    const eventMessageId = readEventMessageId(event);
    status = {
      ...status,
      lastEventAt: new Date().toISOString(),
      lastMessageId: eventMessageId,
    };
    logger.info({ messageId: eventMessageId, inbox: status.configuredInbox }, "AgentMail inbound websocket message received");

    const normalizedMessage = normalizeAgentmailMessagePayload({
      message: safeRecord(event)?.message ?? event,
    });
    if (!normalizedMessage || !dbRef || !status.configuredCompanyId) {
      status = {
        ...status,
        lastError: !normalizedMessage
          ? "Unable to normalize AgentMail websocket message"
          : "AgentMail websocket listener missing runtime context",
      };
      logger.warn(
        { messageId: eventMessageId, companyId: status.configuredCompanyId },
        "AgentMail inbound websocket ignored malformed message payload",
      );
      return;
    }

    try {
      const svc = createService(dbRef);
      const result = await svc.processInboundMessage(status.configuredCompanyId, normalizedMessage, {
        transport: "websocket",
        eventType: "message.received",
        rawPayload: event,
      });

      if (result.status === "duplicate") {
        logger.info({ messageId: normalizedMessage.messageId }, "AgentMail inbound websocket duplicate message ignored");
        return;
      }

      if (result.status === "processed" && result.issueId) {
        await queueAnalysis(dbRef, {
          companyId: status.configuredCompanyId,
          issueId: result.issueId,
          messageId: normalizedMessage.messageId,
          source: "agentmail.websocket",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status = { ...status, lastError: message };
      logger.error({ err, messageId: normalizedMessage.messageId }, "AgentMail inbound websocket processing failed");
    }
  }

  function attachHandlers(nextSocket: AgentmailSocketLike) {
    nextSocket.on("open", () => {
      handleOpen();
    });
    nextSocket.on("message", (event) => {
      void handleMessage(event);
    });
    nextSocket.on("close", (event) => {
      status = {
        ...status,
        connected: false,
        subscribed: false,
        lastDisconnectAt: new Date().toISOString(),
      };
      logger.warn(
        { code: event?.code ?? null, reason: event?.reason ?? null },
        "AgentMail inbound websocket closed; waiting for SDK reconnect",
      );
    });
    nextSocket.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      status = { ...status, lastError: message };
      logger.warn({ err: error }, "AgentMail inbound websocket error");
    });
  }

  async function connect() {
    const config = readInboundConfig();
    status = {
      ...status,
      transportMode: config.transportMode,
      configuredInbox: config.mailbox,
      configuredCompanyId: config.companyId,
    };

    if (config.transportMode !== "websocket") {
      resetRuntimeFields({ enabled: false });
      return;
    }

    if (!config.apiKey || !config.mailbox || !config.companyId) {
      const missing = [
        !config.apiKey ? "PAPERCLIP_AGENTMAIL_API_KEY" : null,
        !config.mailbox ? "PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX" : null,
        !config.companyId ? "PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID" : null,
      ].filter(Boolean);
      status = {
        ...status,
        enabled: false,
        connected: false,
        subscribed: false,
        lastError: `AgentMail inbound websocket disabled; missing ${missing.join(", ")}`,
      };
      logger.error({ missing }, "AgentMail inbound websocket listener disabled due to missing configuration");
      return;
    }

    if (connectInFlight) return;
    connectInFlight = true;
    status = {
      ...status,
      enabled: true,
    };

    logger.info(
      { inbox: config.mailbox, companyId: config.companyId },
      "Starting AgentMail inbound websocket listener",
    );

    try {
      const nextSocket = await createSocket(config.apiKey);
      if (stopped) {
        nextSocket.close?.();
        return;
      }
      socket = nextSocket;
      attachHandlers(nextSocket);
      handleOpen();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status = {
        ...status,
        enabled: true,
        connected: false,
        subscribed: false,
        lastError: message,
      };
      logger.error({ err }, "Failed to connect AgentMail inbound websocket listener");
      scheduleReconnect(message);
    } finally {
      connectInFlight = false;
    }
  }

  return {
    async start(db: Db) {
      dbRef = db;
      stopped = false;
      await connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close?.();
      socket = null;
      status = {
        ...status,
        connected: false,
        subscribed: false,
      };
    },
    getStatus(companyId?: string): AgentmailInboundStatus {
      const scopedEnabled =
        !companyId
        || !status.configuredCompanyId
        || status.configuredCompanyId === companyId
          ? status.enabled
          : false;
      return {
        ...status,
        enabled: scopedEnabled,
      };
    },
  };
}

export const agentmailInboundListener = createAgentmailInboundListener();
