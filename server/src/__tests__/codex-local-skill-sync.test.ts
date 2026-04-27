import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCodexSkills,
  syncCodexSkills,
} from "@paperclipai/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const paraMemoryKey = "paperclipai/paperclip/para-memory-files";
  const createAgentKey = "paperclipai/paperclip/paperclip-create-agent";
  const createPluginKey = "paperclipai/paperclip/paperclip-create-plugin";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Paperclip skills for workspace injection on the next run", async () => {
    const codexHome = await makeTempDir("paperclip-codex-skill-sync-");
    cleanupDirs.add(codexHome);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        paperclipSkillSync: {
          desiredSkills: [paperclipKey],
        },
      },
    } as const;

    const before = await listCodexSkills(ctx);
    expect(before.mode).toBe("ephemeral");
    expect(before.desiredSkills).toContain(paperclipKey);
    expect(before.entries.find((entry) => entry.key === paperclipKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === paperclipKey)?.detail).toContain("CODEX_HOME/skills/");
  });

  it("does not persist Paperclip skills into CODEX_HOME during sync", async () => {
    const codexHome = await makeTempDir("paperclip-codex-skill-prune-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        paperclipSkillSync: {
          desiredSkills: [paperclipKey],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, [paperclipKey]);
    expect(after.mode).toBe("ephemeral");
    expect(after.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("configured");
    await expect(fs.lstat(path.join(codexHome, "skills", "paperclip"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps required bundled Paperclip skills configured even when the desired set is emptied", async () => {
    const codexHome = await makeTempDir("paperclip-codex-skill-required-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        paperclipSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, []);
    expect(after.desiredSkills).toContain(paperclipKey);
    expect(after.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("configured");
  });

  it("normalizes legacy flat Paperclip skill refs before reporting configured state", async () => {
    const codexHome = await makeTempDir("paperclip-codex-legacy-skill-sync-");
    cleanupDirs.add(codexHome);

    const snapshot = await listCodexSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(paperclipKey);
    expect(snapshot.desiredSkills).not.toContain("paperclip");
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === "paperclip")).toBeUndefined();
  });

  it("limits bundled Codex skills by agent role when role context is provided", async () => {
    const codexHome = await makeTempDir("paperclip-codex-role-skill-sync-");
    cleanupDirs.add(codexHome);

    const engineerSnapshot = await listCodexSkills({
      agentId: "agent-4",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        paperclipAgentRole: "engineer",
      },
    });

    expect(engineerSnapshot.desiredSkills).toContain(paperclipKey);
    expect(engineerSnapshot.desiredSkills).not.toContain(paraMemoryKey);
    expect(engineerSnapshot.desiredSkills).not.toContain(createAgentKey);
    expect(engineerSnapshot.desiredSkills).not.toContain(createPluginKey);

    const ceoSnapshot = await listCodexSkills({
      agentId: "agent-5",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        paperclipAgentRole: "ceo",
      },
    });

    expect(ceoSnapshot.desiredSkills).toContain(paperclipKey);
    expect(ceoSnapshot.desiredSkills).toContain(paraMemoryKey);
    expect(ceoSnapshot.desiredSkills).toContain(createAgentKey);
    expect(ceoSnapshot.desiredSkills).not.toContain(createPluginKey);
  });
});
