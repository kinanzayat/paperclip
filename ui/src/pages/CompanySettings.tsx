import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  ISSUE_STATUS_CATEGORIES,
  type CompanyMembership,
  type CompanyMembershipRole,
  type CompanyIssueStatus,
  type IssueStatusCategory,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { authApi } from "../api/auth";
import { statusesApi } from "../api/statuses";
import { useCompanyStatuses } from "../hooks/useCompanyStatuses";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Settings, Check, ChevronDown, ChevronUp, Download, Upload } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import {
  Field,
  ToggleField,
  HintIcon
} from "../components/agent-config-primitives";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

const STATUS_CATEGORY_LABELS: Record<IssueStatusCategory, string> = {
  unstarted: "Unstarted",
  started: "Started",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
};

const DEFAULT_STATUS_COLORS: Record<IssueStatusCategory, string> = {
  unstarted: "#64748b",
  started: "#2563eb",
  blocked: "#d97706",
  completed: "#16a34a",
  cancelled: "#6b7280",
};

const MEMBERSHIP_ROLE_OPTIONS: Array<{ value: CompanyMembershipRole; label: string }> = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
  { value: "product_owner_head", label: "Product Owner Head" },
  { value: "tech_team", label: "Tech Team" },
];

function slugifyStatus(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function userMemberships(members: CompanyMembership[] | undefined) {
  return (members ?? []).filter((member) => member.principalType === "user");
}

function memberName(member: CompanyMembership) {
  return member.user?.name?.trim()
    || member.user?.email?.trim()
    || (member.principalId === "local-board" ? "Board" : member.principalId.slice(0, 8));
}

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [productOwnerEmail, setProductOwnerEmail] = useState("");
  const [techTeamEmail, setTechTeamEmail] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setProductOwnerEmail(selectedCompany.productOwnerEmail ?? "");
    setTechTeamEmail(selectedCompany.techTeamEmail ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);
  const [newStatusLabel, setNewStatusLabel] = useState("");
  const [newStatusSlug, setNewStatusSlug] = useState("");
  const [newStatusCategory, setNewStatusCategory] = useState<IssueStatusCategory>("unstarted");
  const [newStatusColor, setNewStatusColor] = useState(DEFAULT_STATUS_COLORS.unstarted);
  const [newStatusDefault, setNewStatusDefault] = useState(false);

  const { data: session, isLoading: sessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: members, isLoading: membersLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.members(selectedCompanyId) : ["access", "members", "__disabled__"],
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const {
    statuses,
    statusesByCategory,
    isLoading: statusesLoading,
  } = useCompanyStatuses(selectedCompanyId);
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const currentMembership = userMemberships(members)
    .find((member) => member.principalId === currentUserId && member.status === "active");
  const isCompanyAdmin = session?.user?.isInstanceAdmin === true || currentMembership?.membershipRole === "admin";
  const { data: pendingJoinRequests } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.joinRequests(selectedCompanyId) : ["access", "join-requests", "__disabled__"],
    queryFn: () => accessApi.listJoinRequests(selectedCompanyId!),
    enabled: !!selectedCompanyId && isCompanyAdmin,
  });

  const userMembers = useMemo(
    () => userMemberships(members),
    [members],
  );

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      productOwnerEmail !== (selectedCompany.productOwnerEmail ?? "") ||
      techTeamEmail !== (selectedCompany.techTeamEmail ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const invalidateCompanyStatusViews = async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.statuses.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) }),
    ]);
  };

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      productOwnerEmail: string | null;
      techTeamEmail: string | null;
      brandColor: string | null;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const feedbackSharingMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        feedbackDataSharingEnabled: enabled,
      }),
    onSuccess: (_company, enabled) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      pushToast({
        title: enabled ? "Feedback sharing enabled" : "Feedback sharing disabled",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update feedback sharing",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const createStatusMutation = useMutation({
    mutationFn: (input: {
      label: string;
      slug: string;
      category: IssueStatusCategory;
      color: string;
      isDefault?: boolean;
    }) => statusesApi.create(selectedCompanyId!, input),
    onSuccess: async () => {
      await invalidateCompanyStatusViews();
      setNewStatusLabel("");
      setNewStatusSlug("");
      setNewStatusDefault(false);
      pushToast({ title: "Status created", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to create status",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ statusId, input }: { statusId: string; input: { slug?: string; label?: string; color?: string; isDefault?: boolean } }) =>
      statusesApi.update(selectedCompanyId!, statusId, input),
    onSuccess: async () => {
      await invalidateCompanyStatusViews();
      pushToast({ title: "Status updated", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update status",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const reorderStatusMutation = useMutation({
    mutationFn: (statusIds: string[]) => statusesApi.reorder(selectedCompanyId!, statusIds),
    onSuccess: async () => {
      await invalidateCompanyStatusViews();
    },
    onError: (err) => {
      pushToast({
        title: "Failed to reorder statuses",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const deleteStatusMutation = useMutation({
    mutationFn: ({ statusId, replacementSlug }: { statusId: string; replacementSlug?: string }) =>
      statusesApi.remove(selectedCompanyId!, statusId, replacementSlug),
    onSuccess: async () => {
      await invalidateCompanyStatusViews();
      pushToast({ title: "Status deleted", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to delete status",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const updateMemberRoleMutation = useMutation({
    mutationFn: ({
      memberId,
      membershipRole,
    }: {
      memberId: string;
      membershipRole: CompanyMembershipRole;
    }) => accessApi.updateMemberRole(selectedCompanyId!, memberId, membershipRole),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.members(selectedCompanyId!) });
      pushToast({ title: "Member role updated", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update role",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const approveJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.access.members(selectedCompanyId!) }),
      ]);
      pushToast({ title: "Join request approved", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to approve join request",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const rejectJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) });
      pushToast({ title: "Join request rejected", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to reject join request",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createOpenClawInvitePrompt(selectedCompanyId!),
    onSuccess: async (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const absoluteUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;
      setSnippetCopied(false);
      setSnippetCopyDelightId(0);
      let snippet: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null
        });
      } catch {
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: null,
          testResolutionUrl: null
        });
      }
      setInviteSnippet(snippet);
      try {
        await navigator.clipboard.writeText(snippet);
        setSnippetCopied(true);
        setSnippetCopyDelightId((prev) => prev + 1);
        setTimeout(() => setSnippetCopied(false), 2000);
      } catch {
        /* clipboard may not be available */
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(selectedCompanyId!)
      });
    },
    onError: (err) => {
      setInviteError(
        err instanceof Error ? err.message : "Failed to create invite"
      );
    }
  });

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
  }, [selectedCompanyId]);

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings" }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  function handleCreateStatus() {
    const label = newStatusLabel.trim();
    if (!label) return;
    const slug = slugifyStatus(newStatusSlug || label);
    if (!slug) {
      pushToast({
        title: "Status slug required",
        body: "Enter a valid label or slug for the new status.",
        tone: "error",
      });
      return;
    }
    createStatusMutation.mutate({
      label,
      slug,
      category: newStatusCategory,
      color: newStatusColor,
      isDefault: newStatusDefault || undefined,
    });
  }

  function handleEditStatus(status: CompanyIssueStatus) {
    const nextLabel = window.prompt("Status label", status.label)?.trim();
    if (!nextLabel) return;
    const nextSlugInput = window.prompt("Status slug", status.slug);
    if (nextSlugInput === null) return;
    const nextSlug = slugifyStatus(nextSlugInput || nextLabel);
    if (!nextSlug) return;
    const nextColor = window.prompt("Status color", status.color)?.trim();
    if (!nextColor) return;
    updateStatusMutation.mutate({
      statusId: status.id,
      input: {
        label: nextLabel,
        slug: nextSlug,
        color: nextColor,
      },
    });
  }

  function handleMoveStatus(status: CompanyIssueStatus, direction: -1 | 1) {
    const index = statuses.findIndex((entry) => entry.id === status.id);
    const swapIndex = index + direction;
    if (index < 0 || swapIndex < 0 || swapIndex >= statuses.length) return;
    const next = [...statuses];
    [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
    reorderStatusMutation.mutate(next.map((entry) => entry.id));
  }

  function handleDeleteStatus(status: CompanyIssueStatus) {
    const sameCategoryAlternatives = statuses
      .filter((entry) => entry.category === status.category && entry.id !== status.id);
    let replacementSlug: string | undefined;
    if (sameCategoryAlternatives.length > 0) {
      const suggestion = sameCategoryAlternatives[0]?.slug ?? "";
      const input = window.prompt(
        `Replacement slug for issues using "${status.label}" (${sameCategoryAlternatives.map((entry) => entry.slug).join(", ")})`,
        suggestion,
      );
      if (input === null) return;
      replacementSlug = input.trim() || undefined;
    }
    deleteStatusMutation.mutate({
      statusId: status.id,
      replacementSlug,
    });
  }

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  if (sessionLoading || membersLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        Loading settings...
      </div>
    );
  }

  if (!isCompanyAdmin) {
    return (
      <div className="max-w-2xl space-y-3">
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Company Settings</h1>
        </div>
        <div className="rounded-md border border-border px-4 py-4 text-sm text-muted-foreground">
          You need company admin access to manage settings for this company.
        </div>
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      productOwnerEmail: productOwnerEmail.trim() || null,
      techTeamEmail: techTeamEmail.trim() || null,
      brandColor: brandColor || null
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Company Settings</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          General
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Company name" hint="The display name for your company.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label="Description"
            hint="Optional description shown in the company profile."
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder="Optional company description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field
            label="Product owner email"
            hint="AgentMail milestone notifications for product-side review are sent to this address."
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="email"
              value={productOwnerEmail}
              placeholder="product-owner@your-company.example"
              onChange={(e) => setProductOwnerEmail(e.target.value)}
            />
          </Field>
          <Field
            label="Tech team email"
            hint="AgentMail milestone notifications for technical review are sent to this address."
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="email"
              value={techTeamEmail}
              placeholder="tech-team@your-company.example"
              onChange={(e) => setTechTeamEmail(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Appearance
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label="Logo"
                hint="Upload a PNG, JPEG, WEBP, GIF, or SVG logo image."
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending ? "Removing..." : "Remove logo"}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : "Logo upload failed")}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">Uploading logo...</span>
                  )}
                </div>
              </Field>
              <Field
                label="Brand color"
                hint="Sets the hue for the company icon. Leave empty for auto-generated color."
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder="Auto"
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim()}
          >
            {generalMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : "Failed to save"}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Hiring
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Feedback Sharing
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <ToggleField
            label="Allow sharing voted AI outputs with Paperclip Labs"
            hint="Only AI-generated outputs you explicitly vote on are eligible for feedback sharing."
            checked={!!selectedCompany.feedbackDataSharingEnabled}
            onChange={(enabled) => feedbackSharingMutation.mutate(enabled)}
          />
          <p className="text-sm text-muted-foreground">
            Votes are always saved locally. This setting controls whether voted AI outputs may also be marked for sharing with Paperclip Labs.
          </p>
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>
              Terms version: {selectedCompany.feedbackDataSharingTermsVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION}
            </div>
            {selectedCompany.feedbackDataSharingConsentAt ? (
              <div>
                Enabled {new Date(selectedCompany.feedbackDataSharingConsentAt).toLocaleString()}
                {selectedCompany.feedbackDataSharingConsentByUserId
                  ? ` by ${selectedCompany.feedbackDataSharingConsentByUserId}`
                  : ""}
              </div>
            ) : (
              <div>Sharing is currently disabled.</div>
            )}
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-foreground underline underline-offset-4"
              >
                Read our terms of service
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Statuses
        </div>
        <div className="space-y-4 rounded-md border border-border px-4 py-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Label" hint="Human-readable status name.">
              <input
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                type="text"
                value={newStatusLabel}
                placeholder="Needs review"
                onChange={(e) => {
                  setNewStatusLabel(e.target.value);
                  if (!newStatusSlug) {
                    setNewStatusSlug(slugifyStatus(e.target.value));
                  }
                }}
              />
            </Field>
            <Field label="Slug" hint="Stable identifier used by the API.">
              <input
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                type="text"
                value={newStatusSlug}
                placeholder="needs_review"
                onChange={(e) => setNewStatusSlug(slugifyStatus(e.target.value))}
              />
            </Field>
            <Field label="Category" hint="Determines workflow semantics.">
              <Select
                value={newStatusCategory}
                onValueChange={(nextCategory) => {
                  setNewStatusCategory(nextCategory as IssueStatusCategory);
                  setNewStatusColor(DEFAULT_STATUS_COLORS[nextCategory as IssueStatusCategory]);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_STATUS_CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {STATUS_CATEGORY_LABELS[category]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Color" hint="Hex color used across badges and boards.">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={newStatusColor}
                  onChange={(e) => setNewStatusColor(e.target.value)}
                  className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                />
                <input
                  type="text"
                  value={newStatusColor}
                  onChange={(e) => setNewStatusColor(e.target.value)}
                  className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                />
              </div>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={newStatusDefault}
              onChange={(e) => setNewStatusDefault(e.target.checked)}
              className="rounded border-border"
            />
            Make this the default for its category
          </label>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleCreateStatus}
              disabled={createStatusMutation.isPending || !newStatusLabel.trim()}
            >
              {createStatusMutation.isPending ? "Creating..." : "Add status"}
            </Button>
          </div>

          {statusesLoading ? (
            <p className="text-sm text-muted-foreground">Loading statuses...</p>
          ) : (
            <div className="space-y-4">
              {ISSUE_STATUS_CATEGORIES.map((category) => {
                const categoryStatuses = statusesByCategory.get(category) ?? [];
                return (
                  <div key={category} className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {STATUS_CATEGORY_LABELS[category]}
                    </div>
                    {categoryStatuses.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                        No statuses in this category.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {categoryStatuses.map((status) => (
                          <div
                            key={status.id}
                            className="flex flex-col gap-3 rounded-md border border-border px-3 py-3 md:flex-row md:items-center"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className="inline-block h-3 w-3 rounded-full border border-border"
                                  style={{ backgroundColor: status.color }}
                                />
                                <span className="font-medium">{status.label}</span>
                                <span className="text-xs font-mono text-muted-foreground">{status.slug}</span>
                                {status.isDefault ? (
                                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    Default
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {!status.isDefault ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => updateStatusMutation.mutate({
                                    statusId: status.id,
                                    input: { isDefault: true },
                                  })}
                                  disabled={updateStatusMutation.isPending}
                                >
                                  Set default
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleEditStatus(status)}
                                disabled={updateStatusMutation.isPending}
                              >
                                Edit
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="outline"
                                onClick={() => handleMoveStatus(status, -1)}
                                disabled={reorderStatusMutation.isPending || statuses[0]?.id === status.id}
                                title="Move up"
                              >
                                <ChevronUp className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="outline"
                                onClick={() => handleMoveStatus(status, 1)}
                                disabled={reorderStatusMutation.isPending || statuses[statuses.length - 1]?.id === status.id}
                                title="Move down"
                              >
                                <ChevronDown className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleDeleteStatus(status)}
                                disabled={deleteStatusMutation.isPending}
                              >
                                Delete
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Members
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          {userMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members found.</p>
          ) : (
            userMembers.map((member) => (
              <div
                key={member.id}
                className="flex flex-col gap-2 rounded-md border border-border px-3 py-3 md:flex-row md:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{memberName(member)}</div>
                  <div className="text-xs text-muted-foreground">
                    {member.user?.email ?? member.principalId} · {member.status}
                  </div>
                </div>
                <Select
                  value={member.membershipRole ?? "member"}
                  onValueChange={(role) => updateMemberRoleMutation.mutate({
                    memberId: member.id,
                    membershipRole: role as CompanyMembershipRole,
                  })}
                  disabled={updateMemberRoleMutation.isPending}
                >
                  <SelectTrigger className="w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MEMBERSHIP_ROLE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Join Requests
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          {(pendingJoinRequests ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending join requests.</p>
          ) : (
            (pendingJoinRequests ?? []).map((request) => (
              <div
                key={request.id}
                className="flex flex-col gap-3 rounded-md border border-border px-3 py-3 md:flex-row md:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {request.requestType === "human"
                      ? request.requestingUser?.name ?? request.requestEmailSnapshot ?? "Human request"
                      : request.agentName ?? "Agent request"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {request.requestType === "human"
                      ? request.requestingUser?.email ?? request.requestEmailSnapshot ?? "No email"
                      : request.adapterType ?? "Unknown adapter"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => approveJoinRequestMutation.mutate(request.id)}
                    disabled={approveJoinRequestMutation.isPending}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => rejectJoinRequestMutation.mutate(request.id)}
                    disabled={rejectJoinRequestMutation.isPending}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Invites */}
      <div className="space-y-4" data-testid="company-settings-invites-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Invites
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Generate a PM OpenClaw agent invite snippet.
            </span>
            <HintIcon text="Creates a short-lived OpenClaw agent invite and renders a copy-ready PM onboarding prompt." />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="company-settings-invites-generate-button"
              size="sm"
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending
                ? "Generating..."
                : "Generate PM OpenClaw Invite Prompt"}
            </Button>
          </div>
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}
          {inviteSnippet && (
            <div
              className="rounded-md border border-border bg-muted/30 p-2"
              data-testid="company-settings-invites-snippet"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  PM OpenClaw Invite Prompt
                </div>
                {snippetCopied && (
                  <span
                    key={snippetCopyDelightId}
                    className="flex items-center gap-1 text-xs text-green-600 animate-pulse"
                  >
                    <Check className="h-3 w-3" />
                    Copied
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1.5">
                <textarea
                  data-testid="company-settings-invites-snippet-textarea"
                  className="h-[28rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                  value={inviteSnippet}
                  readOnly
                />
                <div className="flex justify-end">
                  <Button
                    data-testid="company-settings-invites-copy-button"
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteSnippet);
                        setSnippetCopied(true);
                        setSnippetCopyDelightId((prev) => prev + 1);
                        setTimeout(() => setSnippetCopied(false), 2000);
                      } catch {
                        /* clipboard may not be available */
                      }
                    }}
                  >
                    {snippetCopied ? "Copied snippet" : "Copy snippet"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Company Packages
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Import and export have moved to dedicated pages accessible from the{" "}
            <a href="/org" className="underline hover:text-foreground">Org Chart</a> header.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <a href="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Import
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          Danger Zone
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Archive this company to hide it from the sidebar. This persists in
            the database.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                selectedCompany.status === "archived"
              }
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`
                );
                if (!confirmed) return;
                const nextCompanyId =
                  companies.find(
                    (company) =>
                      company.id !== selectedCompanyId &&
                      company.status !== "archived"
                  )?.id ?? null;
                archiveMutation.mutate({
                  companyId: selectedCompanyId,
                  nextCompanyId
                });
              }}
            >
              {archiveMutation.isPending
                ? "Archiving..."
                : selectedCompany.status === "archived"
                ? "Already archived"
                : "Archive company"}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : "Failed to archive company"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function buildAgentSnippet(input: AgentSnippetInput) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((u) => `- ${u}`).join("\n")
      : "- (No candidate URLs available yet.)";

  const connectivityBlock =
    candidateUrls.length === 0
      ? `No candidate URLs are available. Ask your user to configure a reachable hostname in Paperclip, then retry.
Suggested steps:
- choose a hostname that resolves to the Paperclip host from your runtime
- run: pnpm paperclipai allowed-hostname <host>
- restart Paperclip
- verify with: curl -fsS http://<host>:3100/api/health
- regenerate this invite snippet`
      : `If none are reachable, ask your user to add a reachable hostname in Paperclip, restart, and retry.
Suggested command:
- pnpm paperclipai allowed-hostname <host>
Then verify with: curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\nYou MUST test Paperclip-to-gateway reachability, call: ${resolutionTestUrl}?url=<urlencoded-gateway-url> (using the hostname that worked above). Do not assume your 172.x is necessarily reachable from Paperclip. Test it. `
    : "";

  return `You're invited to join a Paperclip organization as the PM / product-owner coordination agent.

The URLs you should try are:
${candidateList}

Connectivity guidance:
If you are running on a different machine than Paperclip, Paperclip must be reachable at one of the hostnames used above.
Verify the hostname works from your runtime with: GET <base-url>/api/health

${connectivityBlock}

For your "agentName", use your own PM agent name and send it directly.
You also need to send a gateway URL that Paperclip can access. Check your config and include that URL.${resolutionLine}
For long-running remote setups, prefer a stable public \`wss://\` hostname such as a domain/subdomain reverse-proxied to the local OpenClaw gateway instead of a temporary quick tunnel.

---

This onboarding flow is for the PM OpenClaw Gateway agent.
When you submit the join request, use:
- \`adapterType: "openclaw_gateway"\`
- \`agentDefaultsPayload.url\` as your \`ws://\` or \`wss://\` gateway URL
- \`agentDefaultsPayload.headers["x-openclaw-token"]\` with your gateway token
- (legacy accepted) \`agentDefaultsPayload.headers["x-openclaw-auth"]\`
- Keep device auth enabled (recommended). If \`devicePrivateKeyPem\` is omitted, Paperclip will generate and persist one during join so pairing approvals remain stable.
- Only use \`disableDeviceAuth=true\` for special environments where pairing cannot be completed.

Do NOT use \`/v1/responses\` or \`/hooks/*\` in this join flow.

Then after you've connected to Paperclip (exchanged keys etc.) you MUST review and follow the onboarding instructions in onboarding.txt they give you.

`;
}

function buildCandidateOnboardingUrls(input: AgentSnippetInput): string[] {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: AgentSnippetInput): string | null {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution"
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}
