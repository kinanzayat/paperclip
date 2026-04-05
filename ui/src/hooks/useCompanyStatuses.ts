import { useContext, useMemo } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import {
  DEFAULT_ISSUE_STATUSES,
  type CompanyIssueStatus,
  type IssueStatusCategory,
} from "@paperclipai/shared";
import { statusesApi } from "../api/statuses";
import { queryKeys } from "../lib/queryKeys";

const FALLBACK_STATUSES: CompanyIssueStatus[] = DEFAULT_ISSUE_STATUSES.map((status, index) => ({
  id: `default-${status.slug}`,
  companyId: "__default__",
  slug: status.slug,
  label: status.label,
  category: status.category,
  color: status.color,
  position: status.position ?? index,
  isDefault: status.isDefault,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}));

const fallbackQueryClient = new QueryClient();

function isTerminalCategory(category: IssueStatusCategory) {
  return category === "completed" || category === "cancelled";
}

export function useCompanyStatuses(companyId: string | null | undefined) {
  const queryClient = useContext(QueryClientContext) ?? fallbackQueryClient;
  const query = useQuery({
    queryKey: companyId ? queryKeys.statuses.list(companyId) : ["statuses", "__disabled__"],
    queryFn: () => statusesApi.list(companyId!),
    enabled: !!companyId,
  }, queryClient);

  const statuses = useMemo(() => {
    const source = query.data && query.data.length > 0 ? query.data : FALLBACK_STATUSES;
    return [...source].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
  }, [query.data]);

  const statusBySlug = useMemo(() => {
    const map = new Map<string, CompanyIssueStatus>();
    for (const status of statuses) {
      map.set(status.slug, status);
    }
    return map;
  }, [statuses]);

  const statusesByCategory = useMemo(() => {
    const map = new Map<IssueStatusCategory, CompanyIssueStatus[]>();
    for (const status of statuses) {
      const group = map.get(status.category) ?? [];
      group.push(status);
      map.set(status.category, group);
    }
    return map;
  }, [statuses]);

  const defaultStatusByCategory = useMemo(() => {
    const map = new Map<IssueStatusCategory, CompanyIssueStatus>();
    for (const status of statuses) {
      if (!status.isDefault) continue;
      if (!map.has(status.category)) {
        map.set(status.category, status);
      }
    }
    return map;
  }, [statuses]);

  const openStatuses = useMemo(
    () => statuses.filter((status) => !isTerminalCategory(status.category)),
    [statuses],
  );

  return {
    ...query,
    statuses,
    openStatuses,
    statusBySlug,
    statusesByCategory,
    defaultStatusByCategory,
    defaultUnstartedStatus:
      defaultStatusByCategory.get("unstarted")
      ?? statusesByCategory.get("unstarted")?.[0]
      ?? statuses[0]
      ?? null,
    defaultStartedStatus:
      defaultStatusByCategory.get("started")
      ?? statusesByCategory.get("started")?.[0]
      ?? null,
  };
}

export function getFallbackCompanyStatuses() {
  return FALLBACK_STATUSES;
}
