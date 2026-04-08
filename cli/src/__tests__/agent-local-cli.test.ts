import { describe, expect, it } from "vitest";
import { buildAgentEnvExports } from "../commands/client/agent.js";

describe("agent local-cli helpers", () => {
  const input = {
    apiBase: "http://localhost:3100",
    companyId: "company-1",
    agentId: "agent-1",
    apiKey: "tok'en",
  };

  it("renders POSIX exports for Unix shells", () => {
    expect(buildAgentEnvExports(input, "posix")).toBe([
      "export PAPERCLIP_API_URL='http://localhost:3100'",
      "export PAPERCLIP_COMPANY_ID='company-1'",
      "export PAPERCLIP_AGENT_ID='agent-1'",
      "export PAPERCLIP_API_KEY='tok'\"'\"'en'",
    ].join("\n"));
  });

  it("renders PowerShell exports for Windows shells", () => {
    expect(buildAgentEnvExports(input, "powershell")).toBe([
      "$env:PAPERCLIP_API_URL='http://localhost:3100'",
      "$env:PAPERCLIP_COMPANY_ID='company-1'",
      "$env:PAPERCLIP_AGENT_ID='agent-1'",
      "$env:PAPERCLIP_API_KEY='tok''en'",
    ].join("\n"));
  });

  it("renders cmd.exe exports for Windows shells", () => {
    expect(buildAgentEnvExports(input, "cmd")).toBe([
      'set "PAPERCLIP_API_URL=http://localhost:3100"',
      'set "PAPERCLIP_COMPANY_ID=company-1"',
      'set "PAPERCLIP_AGENT_ID=agent-1"',
      'set "PAPERCLIP_API_KEY=tok\'en"',
    ].join("\n"));
  });
});
