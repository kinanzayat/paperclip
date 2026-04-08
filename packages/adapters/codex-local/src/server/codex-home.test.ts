import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js";
import {
  detectCodexModel,
  prepareManagedCodexHome,
  readSharedCodexDefaultModel,
  resolveManagedCodexHomeDir,
  resolveSharedCodexHomeDir,
} from "./codex-home.js";

const noopLog = async () => {};

function makeEnv(root: string): NodeJS.ProcessEnv {
  return {
    HOME: root,
    PAPERCLIP_HOME: path.join(root, "paperclip-home"),
    CODEX_HOME: path.join(root, "shared-codex-home"),
  };
}

async function replaceFile(target: string, contents: string): Promise<void> {
  const temp = `${target}.replacement`;
  await fs.writeFile(temp, contents, "utf8");
  await fs.rm(target, { force: true });
  await fs.rename(temp, target);
}

describe("codex home sync", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("repairs a stale hard-linked managed auth file when shared auth.json is replaced", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-link-"));
    cleanupRoots.push(root);
    const env = makeEnv(root);
    const sharedHome = env.CODEX_HOME!;
    const managedHome = resolveManagedCodexHomeDir(env, "company-1");
    const sharedAuth = path.join(sharedHome, "auth.json");
    const managedAuth = path.join(managedHome, "auth.json");

    await fs.mkdir(sharedHome, { recursive: true });
    await fs.mkdir(managedHome, { recursive: true });
    await fs.writeFile(sharedAuth, JSON.stringify({ account: "old@example.com" }), "utf8");
    await fs.link(sharedAuth, managedAuth);

    await replaceFile(sharedAuth, JSON.stringify({ account: "new@example.com" }));

    await prepareManagedCodexHome(env, noopLog, "company-1");

    expect(await fs.readFile(managedAuth, "utf8")).toBe(
      JSON.stringify({ account: "new@example.com" }),
    );

    await fs.writeFile(sharedAuth, JSON.stringify({ account: "mutated@example.com" }), "utf8");
    expect(await fs.readFile(managedAuth, "utf8")).toBe(
      JSON.stringify({ account: "new@example.com" }),
    );
  });

  it("refreshes synchronized shared config files on subsequent prepare calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-config-"));
    cleanupRoots.push(root);
    const env = makeEnv(root);
    const sharedHome = env.CODEX_HOME!;
    const managedHome = resolveManagedCodexHomeDir(env, "company-1");
    const sharedConfig = path.join(sharedHome, "config.toml");
    const managedConfig = path.join(managedHome, "config.toml");

    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(sharedConfig, 'model = "gpt-5.4"\n', "utf8");

    await prepareManagedCodexHome(env, noopLog, "company-1");
    expect(await fs.readFile(managedConfig, "utf8")).toBe('model = "gpt-5.4"\n');

    await fs.writeFile(sharedConfig, 'model = "gpt-5.5"\n', "utf8");

    await prepareManagedCodexHome(env, noopLog, "company-1");
    expect(await fs.readFile(managedConfig, "utf8")).toBe('model = "gpt-5.5"\n');
  });

  it("reads the top-level shared Codex model from config.toml", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-detect-"));
    cleanupRoots.push(root);
    const env = makeEnv(root);
    const sharedHome = env.CODEX_HOME!;
    const configPath = path.join(sharedHome, "config.toml");

    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(
      configPath,
      [
        'model = "gpt-5.4" # shared default',
        "",
        "[profiles.fast]",
        'model = "gpt-5.3-codex"',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(readSharedCodexDefaultModel(env)).resolves.toBe("gpt-5.4");
    await expect(detectCodexModel(env)).resolves.toEqual({
      model: "gpt-5.4",
      provider: "openai",
      source: configPath,
    });
  });

  it("falls back to the Paperclip default model when shared config is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-fallback-"));
    cleanupRoots.push(root);
    const env = makeEnv(root);

    await expect(readSharedCodexDefaultModel(env)).resolves.toBeNull();
    await expect(detectCodexModel(env)).resolves.toEqual({
      model: DEFAULT_CODEX_LOCAL_MODEL,
      provider: "openai",
      source: "paperclip_default",
    });
  });

  it("resolves managed and shared homes from HOMEDRIVE and HOMEPATH when HOME and USERPROFILE are absent", async () => {
    const env = {
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\Paperclip",
      PAPERCLIP_INSTANCE_ID: "instance-1",
    } as NodeJS.ProcessEnv;

    expect(resolveManagedCodexHomeDir(env, "company-1")).toBe(
      path.resolve("C:\\Users\\Paperclip", ".paperclip", "instances", "instance-1", "companies", "company-1", "codex-home"),
    );
    expect(resolveSharedCodexHomeDir(env)).toBe(
      path.resolve("C:\\Users\\Paperclip", ".codex"),
    );
  });
});
