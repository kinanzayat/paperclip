import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { ShieldCheck } from "lucide-react";
import { ApprovalCard } from "../components/ApprovalCard";
import { PageSkeleton } from "../components/PageSkeleton";

type StatusFilter = "pending" | "all";

function normalizeRequiredRoles(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((role): role is string => typeof role === "string" && role.trim().length > 0);
}

function roleLabel(role: string): string {
  if (role === "product_owner_head") return "Product Owner Head";
  if (role === "tech_team") return "Tech Team";
  if (role === "admin") return "Admin";
  if (role === "member") return "Member";
  return role.replace(/_/g, " ");
}

function approvalStageLabel(type: string): string | null {
  if (type === "requirement_product_owner_review" || type === "agentmail_product_owner_confirmation") {
    return "Stage 1 of 2";
  }
  if (type === "requirement_tech_review" || type === "agentmail_tech_review") {
    return "Stage 2 of 2";
  }
  return null;
}

export function Approvals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Approvals" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: members } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.members(selectedCompanyId) : ["access", "members", "__disabled__"],
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const currentMembershipRole = (members ?? [])
    .find((member) => member.principalType === "user" && member.principalId === currentUserId && member.status === "active")
    ?.membershipRole ?? null;
  const isInstanceAdmin = session?.user?.isInstanceAdmin === true;

  const canResolveApproval = (approval: { requiredRoles: string[] | null }) => {
    const roles = normalizeRequiredRoles(approval.requiredRoles);
    if (roles.length === 0) return true;
    if (isInstanceAdmin) return true;
    if (!currentMembershipRole) return false;
    return roles.includes(currentMembershipRole);
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const filtered = (data ?? [])
    .filter(
      (a) => statusFilter === "all" || a.status === "pending" || a.status === "revision_requested",
    )
    .filter((approval) => statusFilter === "all" || canResolveApproval(approval))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const pendingCount = (data ?? []).filter(
    (a) => (a.status === "pending" || a.status === "revision_requested") && canResolveApproval(a),
  ).length;

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Tabs value={statusFilter} onValueChange={(v) => navigate(`/approvals/${v}`)}>
          <PageTabBar items={[
            { value: "pending", label: <>Pending{pendingCount > 0 && (
              <span className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                "bg-yellow-500/20 text-yellow-500"
              )}>
                {pendingCount}
              </span>
            )}</> },
            { value: "all", label: "All" },
          ]} />
        </Tabs>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {statusFilter === "pending" && currentMembershipRole && (
        <p className="text-xs text-muted-foreground">
          Showing approvals for your role: {roleLabel(currentMembershipRole)}
        </p>
      )}

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {statusFilter === "pending" ? "No pending approvals for your current role." : "No approvals yet."}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((approval) => {
            const requiredRoles = normalizeRequiredRoles(approval.requiredRoles);
            const requiredRole = requiredRoles[0] ?? null;
            return (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                onApprove={() => approveMutation.mutate(approval.id)}
                onReject={() => rejectMutation.mutate(approval.id)}
                detailLink={`/approvals/${approval.id}`}
                canResolve={canResolveApproval(approval)}
                stageLabel={approvalStageLabel(approval.type)}
                requiredRoleLabel={requiredRole ? roleLabel(requiredRole) : null}
                isPending={approveMutation.isPending || rejectMutation.isPending}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
