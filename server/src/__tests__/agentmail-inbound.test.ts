import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentmailInboundListener } from "../services/agentmail-inbound.js";

function createFakeSocket() {
  const handlers: {
    open?: () => void;
    message?: (event: unknown) => void;
    close?: (event: { code?: number; reason?: string }) => void;
    error?: (error: Error) => void;
  } = {};

  return {
    socket: {
      on(event: "open" | "message" | "close" | "error", callback: (...args: any[]) => void) {
        handlers[event] = callback as never;
      },
      sendSubscribe: vi.fn(),
      close: vi.fn(),
    },
    emitOpen() {
      handlers.open?.();
    },
    emitMessage(event: unknown) {
      handlers.message?.(event);
    },
    emitClose(event: { code?: number; reason?: string } = {}) {
      handlers.close?.(event);
    },
    emitError(error: Error) {
      handlers.error?.(error);
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AgentMail inbound websocket listener", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("disables websocket mode cleanly when required env vars are missing", async () => {
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT = "websocket";
    delete process.env.PAPERCLIP_AGENTMAIL_API_KEY;
    delete process.env.PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX;
    delete process.env.PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID;

    const listener = createAgentmailInboundListener({
      createSocket: vi.fn(),
    });

    await listener.start({} as any);

    expect(listener.getStatus("company-1")).toMatchObject({
      transportMode: "websocket",
      enabled: false,
      connected: false,
      subscribed: false,
    });
    expect(listener.getStatus("company-1").lastError).toContain("PAPERCLIP_AGENTMAIL_API_KEY");
  });

  it("connects, subscribes, and exposes status for the configured company", async () => {
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT = "websocket";
    process.env.PAPERCLIP_AGENTMAIL_API_KEY = "am_test_123";
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX = "cto@agentmail.to";
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID = "company-1";

    const fakeSocket = createFakeSocket();
    const listener = createAgentmailInboundListener({
      createSocket: vi.fn().mockResolvedValue(fakeSocket.socket),
    });

    await listener.start({} as any);

    expect(fakeSocket.socket.sendSubscribe).toHaveBeenCalledWith({
      type: "subscribe",
      inboxIds: ["cto@agentmail.to"],
      eventTypes: ["message.received"],
    });

    fakeSocket.emitMessage({ type: "subscribed", inboxIds: ["cto@agentmail.to"] });

    expect(listener.getStatus("company-1")).toMatchObject({
      transportMode: "websocket",
      enabled: true,
      configuredInbox: "cto@agentmail.to",
      configuredCompanyId: "company-1",
      connected: true,
      subscribed: true,
    });
  });

  it("processes message.received events through the shared inbound service and queues CTO analysis", async () => {
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT = "websocket";
    process.env.PAPERCLIP_AGENTMAIL_API_KEY = "am_test_123";
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX = "cto@agentmail.to";
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID = "company-1";

    const fakeSocket = createFakeSocket();
    const processInboundMessage = vi.fn().mockResolvedValue({
      status: "processed",
      issueId: "issue-1",
    });
    const queueAnalysis = vi.fn().mockResolvedValue({
      analysisAgentId: "cto-1",
      analysisRunId: "run-1",
      analysisWakeupError: null,
    });
    const listener = createAgentmailInboundListener({
      createSocket: vi.fn().mockResolvedValue(fakeSocket.socket),
      createService: () => ({ processInboundMessage }),
      queueAnalysis,
    });

    await listener.start({} as any);
    fakeSocket.emitMessage({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "cto@agentmail.to",
        threadId: "thread-1",
        messageId: "msg-1",
        labels: ["inbox"],
        timestamp: "2026-04-14T09:00:00.000Z",
        from: "Sender Name <sender@example.com>",
        to: ["recipient@example.com"],
        subject: "Realtime message",
        text: "Plain text body",
        html: "<p>Plain text body</p>",
        size: 42,
        updatedAt: "2026-04-14T09:00:00.000Z",
        createdAt: "2026-04-14T09:00:00.000Z",
      },
    });
    await flushAsyncWork();

    expect(processInboundMessage).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        messageId: "msg-1",
        subject: "Realtime message",
      }),
      expect.objectContaining({
        transport: "websocket",
        eventType: "message.received",
      }),
    );
    expect(queueAnalysis).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        issueId: "issue-1",
        messageId: "msg-1",
        source: "agentmail.websocket",
      }),
    );
    expect(listener.getStatus("company-1")).toMatchObject({
      lastMessageId: "msg-1",
    });
    expect(listener.getStatus("company-1").lastEventAt).not.toBeNull();
  });

  it("ignores duplicate and unsupported websocket events without crashing", async () => {
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT = "websocket";
    process.env.PAPERCLIP_AGENTMAIL_API_KEY = "am_test_123";
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX = "cto@agentmail.to";
    process.env.PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID = "company-1";

    const fakeSocket = createFakeSocket();
    const processInboundMessage = vi.fn().mockResolvedValue({
      status: "duplicate",
    });
    const queueAnalysis = vi.fn();
    const listener = createAgentmailInboundListener({
      createSocket: vi.fn().mockResolvedValue(fakeSocket.socket),
      createService: () => ({ processInboundMessage }),
      queueAnalysis,
    });

    await listener.start({} as any);
    fakeSocket.emitMessage({ type: "subscribed", inboxIds: ["cto@agentmail.to"] });
    fakeSocket.emitMessage({ type: "message_sent", messageId: "ignored" });
    fakeSocket.emitMessage({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "cto@agentmail.to",
        threadId: "thread-1",
        messageId: "msg-dup",
        labels: ["inbox"],
        timestamp: "2026-04-14T09:00:00.000Z",
        from: "sender@example.com",
        to: ["recipient@example.com"],
        subject: "Duplicate",
        text: "Plain text body",
        size: 42,
        updatedAt: "2026-04-14T09:00:00.000Z",
        createdAt: "2026-04-14T09:00:00.000Z",
      },
    });
    await flushAsyncWork();

    expect(processInboundMessage).toHaveBeenCalledTimes(1);
    expect(queueAnalysis).not.toHaveBeenCalled();
    expect(listener.getStatus("company-1").subscribed).toBe(true);
  });
});
