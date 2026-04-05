import type { CompanyIssueStatus } from "@paperclipai/shared";
import { useOptionalCompany } from "../context/CompanyContext";
import { useCompanyStatuses } from "../hooks/useCompanyStatuses";
import { cn } from "../lib/utils";
import {
  issueStatusBadgeStyle,
  issueStatusLabel,
  statusBadge,
  statusBadgeDefault,
} from "../lib/status-colors";

export function StatusBadge({
  status,
  statusDetails,
  statuses,
}: {
  status: string;
  statusDetails?: CompanyIssueStatus | null;
  statuses?: CompanyIssueStatus[] | null;
}) {
  const company = useOptionalCompany();
  const { statuses: companyStatuses } = useCompanyStatuses(company?.selectedCompanyId);
  const resolvedStatuses = statuses ?? companyStatuses;
  const style = issueStatusBadgeStyle(status, { statusDetails, statuses: resolvedStatuses });
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        style ? "border" : undefined,
        style ? undefined : (statusBadge[status] ?? statusBadgeDefault),
      )}
      style={style}
    >
      {issueStatusLabel(status, { statusDetails, statuses: resolvedStatuses })}
    </span>
  );
}
