import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const SYNCHRONIZED_SHARED_FILES = [
  "auth.json",
  "config.json",
  "config.toml",
  "instructions.md",
] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveUserHome(env: NodeJS.ProcessEnv = process.env): string {
  const directHome = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE);
  if (directHome) return directHome;

  const homeDrive = nonEmpty(env.HOMEDRIVE);
  const homePath = nonEmpty(env.HOMEPATH);
  if (homeDrive && homePath) {
    return path.resolve(`${homeDrive}${homePath}`);
  }

  return os.homedir();
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(resolveUserHome(env), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const paperclipHome =
    nonEmpty(env.PAPERCLIP_HOME) ?? path.resolve(resolveUserHome(env), ".paperclip");
  const instanceId = nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  return companyId
    ? path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "codex-home")
    : path.resolve(paperclipHome, "instances", instanceId, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && Buffer.compare(left, right) === 0;
}

async function replaceFileAtomically(target: string, contents: Buffer): Promise<void> {
  await ensureParentDir(target);
  const tempPath = `${target}.paperclip-sync-${process.pid}-${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, contents);
  try {
    await fs.rename(tempPath, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") {
      throw err;
    }
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(tempPath, target);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function ensureSynchronizedFile(target: string, source: string): Promise<void> {
  const sourceContents = await fs.readFile(source);
  const existing = await fs.lstat(target).catch(() => null);

  if (existing?.isFile()) {
    const targetContents = await fs.readFile(target).catch(() => null);
    if (targetContents && buffersEqual(targetContents, sourceContents)) {
      return;
    }
  }

  await replaceFileAtomically(target, sourceContents);
}

function parseTomlStringLiteral(value: string): string | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
  if (!match) return null;
  return match[2] ?? null;
}

export async function readSharedCodexDefaultModel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const configPath = path.join(resolveSharedCodexHomeDir(env), "config.toml");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return null;
  }

  let inSection = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inSection = true;
      continue;
    }
    if (inSection) continue;
    const match = trimmed.match(/^model\s*=\s*(.+)$/);
    if (!match) continue;
    return parseTomlStringLiteral(match[1] ?? "");
  }

  return null;
}

export async function detectCodexModel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ model: string; provider: string; source: string }> {
  const detected = await readSharedCodexDefaultModel(env);
  if (detected) {
    return {
      model: detected,
      provider: "openai",
      source: path.join(resolveSharedCodexHomeDir(env), "config.toml"),
    };
  }
  return {
    model: DEFAULT_CODEX_LOCAL_MODEL,
    provider: "openai",
    source: "paperclip_default",
  };
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);

  const sourceHome = resolveSharedCodexHomeDir(env);
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });

  for (const name of SYNCHRONIZED_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) continue;
    await ensureSynchronizedFile(path.join(targetHome, name), source);
  }

  await onLog(
    "stdout",
    `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (synced from "${sourceHome}").\n`,
  );
  return targetHome;
}
