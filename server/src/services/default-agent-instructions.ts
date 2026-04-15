import { createHash } from "node:crypto";
import fs from "node:fs/promises";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  pm: ["AGENTS.md"],
  cto: ["AGENTS.md"],
  "product-analyzer": ["AGENTS.md"],
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

export const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "droid_local",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "cursor",
  "pi_local",
]);

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      return [fileName, content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function computeDefaultAgentInstructionsBundleVersion(files: Record<string, string>): string {
  const normalized = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

export async function loadDefaultAgentInstructionsBundleWithVersion(role: DefaultAgentBundleRole) {
  const files = await loadDefaultAgentInstructionsBundle(role);
  return {
    role,
    files,
    version: computeDefaultAgentInstructionsBundleVersion(files),
  };
}

export function isDefaultManagedInstructionsAdapterType(adapterType: string) {
  return DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  if (role === "ceo") return "ceo";
  if (role === "pm") return "pm";
  if (role === "cto") return "cto";
  if (role === "product_analyzer") return "product-analyzer";
  return "default";
}
