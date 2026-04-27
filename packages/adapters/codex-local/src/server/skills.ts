import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const PAPERCLIP_SKILL_NAMESPACE = "paperclipai/paperclip/";
const PAPERCLIP_CORE_SKILL_KEY = "paperclipai/paperclip/paperclip";
const PAPERCLIP_CREATE_AGENT_SKILL_KEY = "paperclipai/paperclip/paperclip-create-agent";
const PAPERCLIP_CREATE_PLUGIN_SKILL_KEY = "paperclipai/paperclip/paperclip-create-plugin";
const PAPERCLIP_PARA_MEMORY_SKILL_KEY = "paperclipai/paperclip/para-memory-files";

const ROLE_SKILL_POLICY = {
  default: [PAPERCLIP_CORE_SKILL_KEY],
  ceo: [PAPERCLIP_CORE_SKILL_KEY, PAPERCLIP_PARA_MEMORY_SKILL_KEY, PAPERCLIP_CREATE_AGENT_SKILL_KEY],
  manager: [PAPERCLIP_CORE_SKILL_KEY, PAPERCLIP_PARA_MEMORY_SKILL_KEY, PAPERCLIP_CREATE_AGENT_SKILL_KEY],
  cto: [PAPERCLIP_CORE_SKILL_KEY, PAPERCLIP_CREATE_PLUGIN_SKILL_KEY],
} as const;

function isPaperclipBundledSkillKey(key: string): boolean {
  return key.startsWith(PAPERCLIP_SKILL_NAMESPACE);
}

export function normalizeCodexAgentRole(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveRolePolicySkillSet(agentRole: string | null): Set<string> | null {
  if (!agentRole) return null;
  if (agentRole === "ceo") {
    return new Set(ROLE_SKILL_POLICY.ceo);
  }
  if (agentRole === "cto") {
    return new Set(ROLE_SKILL_POLICY.cto);
  }
  if (agentRole === "pm" || agentRole === "product_analyzer" || agentRole === "manager") {
    return new Set(ROLE_SKILL_POLICY.manager);
  }
  if (
    agentRole === "engineer" ||
    agentRole === "designer" ||
    agentRole === "qa" ||
    agentRole === "devops" ||
    agentRole === "researcher" ||
    agentRole === "general" ||
    agentRole === "cmo" ||
    agentRole === "cfo"
  ) {
    return new Set(ROLE_SKILL_POLICY.default);
  }
  // Unknown roles keep full availability to avoid accidental regressions.
  return null;
}

function applyRoleBasedSkillFiltering<T extends { key: string }>(
  entries: T[],
  agentRole: string | null,
): T[] {
  const allowedSkillKeys = resolveRolePolicySkillSet(agentRole);
  if (!allowedSkillKeys) return entries;
  return entries.filter((entry) =>
    !isPaperclipBundledSkillKey(entry.key) || allowedSkillKeys.has(entry.key),
  );
}

function filterDesiredSkillsForRolePolicy(
  desiredSkills: string[],
  agentRole: string | null,
): string[] {
  const allowedSkillKeys = resolveRolePolicySkillSet(agentRole);
  if (!allowedSkillKeys) return desiredSkills;
  return desiredSkills.filter((key) =>
    !isPaperclipBundledSkillKey(key) || allowedSkillKeys.has(key),
  );
}

async function buildCodexSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const agentRole = normalizeCodexAgentRole(config.paperclipAgentRole);
  const availableEntries = applyRoleBasedSkillFiltering(
    await readPaperclipRuntimeSkillEntries(config, __moduleDir),
    agentRole,
  );
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolveCodexDesiredSkillNames(config, availableEntries, {
    agentRole,
  });
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: entry.required ? "paperclip_required" : "company_managed",
    originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be linked into the effective CODEX_HOME/skills/ directory on the next run."
      : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));
  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "codex_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listCodexSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildCodexSkillSnapshot(ctx.config);
}

export async function syncCodexSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildCodexSkillSnapshot(ctx.config);
}

export function resolveCodexDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
  options: { agentRole?: string | null } = {},
) {
  const agentRole = normalizeCodexAgentRole(options.agentRole ?? config.paperclipAgentRole);
  const filteredEntries = applyRoleBasedSkillFiltering(availableEntries, agentRole);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, filteredEntries);
  return filterDesiredSkillsForRolePolicy(desiredSkills, agentRole);
}
