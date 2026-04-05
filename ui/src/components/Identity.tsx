import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

type IdentitySize = "xs" | "sm" | "default" | "lg";

export interface IdentityProps {
  name: string;
  avatarUrl?: string | null;
  initials?: string;
  size?: IdentitySize;
  detail?: string | null;
  stacked?: boolean;
  className?: string;
}

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const textSize: Record<IdentitySize, string> = {
  xs: "text-sm",
  sm: "text-xs",
  default: "text-sm",
  lg: "text-sm",
};

export function Identity({
  name,
  avatarUrl,
  initials,
  size = "default",
  detail,
  stacked = false,
  className,
}: IdentityProps) {
  const displayInitials = initials ?? deriveInitials(name);

  return (
    <span
      className={cn(
        "inline-flex gap-1.5",
        stacked ? "items-start gap-2" : size === "xs" ? "items-baseline gap-1" : "items-center",
        size === "lg" && !stacked && "gap-2",
        className,
      )}
    >
      <Avatar size={size} className={size === "xs" ? "relative -top-px" : undefined}>
        {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
        <AvatarFallback>{displayInitials}</AvatarFallback>
      </Avatar>
      <span className={cn("min-w-0", stacked ? "flex flex-col gap-0.5" : "truncate")}>
        <span className={cn("truncate", textSize[size])}>{name}</span>
        {stacked && detail ? (
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </span>
  );
}
