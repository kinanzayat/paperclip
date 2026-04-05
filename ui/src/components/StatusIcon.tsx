import { useState } from "react";
import { DEFAULT_ISSUE_STATUSES, type CompanyIssueStatus } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { useOptionalCompany } from "../context/CompanyContext";
import { useCompanyStatuses } from "../hooks/useCompanyStatuses";
import {
  issueStatusCategory,
  issueStatusColor,
  issueStatusIcon,
  issueStatusIconDefault,
  issueStatusLabel,
} from "../lib/status-colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const allStatuses = DEFAULT_ISSUE_STATUSES.map((status) => status.slug);

interface StatusIconProps {
  status: string;
  onChange?: (status: string) => void;
  className?: string;
  showLabel?: boolean;
  statusDetails?: CompanyIssueStatus | null;
  statuses?: CompanyIssueStatus[] | null;
}

export function StatusIcon({
  status,
  onChange,
  className,
  showLabel,
  statusDetails,
  statuses,
}: StatusIconProps) {
  const [open, setOpen] = useState(false);
  const company = useOptionalCompany();
  const { statuses: companyStatuses } = useCompanyStatuses(company?.selectedCompanyId);
  const resolvedStatuses = statuses ?? companyStatuses;
  const options = { statusDetails, statuses: resolvedStatuses };
  const colorClass = issueStatusIcon[status] ?? issueStatusIconDefault;
  const color = issueStatusColor(status, options);
  const label = issueStatusLabel(status, options);
  const isDone = issueStatusCategory(status, options) === "completed";
  const availableStatuses = resolvedStatuses && resolvedStatuses.length > 0
    ? resolvedStatuses
    : allStatuses.map((slug) => ({ slug })) as Array<Pick<CompanyIssueStatus, "slug">>;

  const circle = (
    <span
      className={cn(
        "relative inline-flex h-4 w-4 rounded-full border-2 shrink-0",
        colorClass,
        onChange && !showLabel && "cursor-pointer",
        className,
      )}
      style={color ? { color, borderColor: color } : undefined}
    >
      {isDone && (
        <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-current" />
      )}
    </span>
  );

  if (!onChange) return showLabel ? <span className="inline-flex items-center gap-1.5">{circle}<span className="text-sm">{label}</span></span> : circle;

  const trigger = showLabel ? (
    <button className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
      {circle}
      <span className="text-sm">{label}</span>
    </button>
  ) : circle;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="start">
        {availableStatuses.map((statusOption) => (
          <Button
            key={statusOption.slug}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", statusOption.slug === status && "bg-accent")}
            onClick={() => {
              onChange(statusOption.slug);
              setOpen(false);
            }}
          >
            <StatusIcon
              status={statusOption.slug}
              statusDetails={"label" in statusOption ? statusOption as CompanyIssueStatus : null}
            />
            {issueStatusLabel(
              statusOption.slug,
              "label" in statusOption ? { statusDetails: statusOption as CompanyIssueStatus } : undefined,
            )}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
