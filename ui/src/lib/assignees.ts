import type { CompanyMembership } from "@paperclipai/shared";

export interface AssigneeSelection {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface AssigneeOption {
  id: string;
  label: string;
  searchText?: string;
}

interface CommentAssigneeSuggestionInput {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}

interface CommentAssigneeSuggestionComment {
  authorAgentId?: string | null;
  authorUserId?: string | null;
}

export function assigneeValueFromSelection(selection: Partial<AssigneeSelection>): string {
  if (selection.assigneeAgentId) return `agent:${selection.assigneeAgentId}`;
  if (selection.assigneeUserId) return `user:${selection.assigneeUserId}`;
  return "";
}

export function suggestedCommentAssigneeValue(
  issue: CommentAssigneeSuggestionInput,
  comments: CommentAssigneeSuggestionComment[] | null | undefined,
  currentUserId: string | null | undefined,
  currentAgentId?: string | null | undefined,
): string {
  if (comments && comments.length > 0 && (currentUserId || currentAgentId)) {
    for (let i = comments.length - 1; i >= 0; i--) {
      const comment = comments[i];
      if (comment.authorAgentId && comment.authorAgentId !== currentAgentId) {
        return assigneeValueFromSelection({ assigneeAgentId: comment.authorAgentId });
      }
      if (comment.authorUserId && comment.authorUserId !== currentUserId) {
        return assigneeValueFromSelection({ assigneeUserId: comment.authorUserId });
      }
    }
  }

  return assigneeValueFromSelection(issue);
}

export function parseAssigneeValue(value: string): AssigneeSelection {
  if (!value) {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (value.startsWith("agent:")) {
    const assigneeAgentId = value.slice("agent:".length);
    return { assigneeAgentId: assigneeAgentId || null, assigneeUserId: null };
  }
  if (value.startsWith("user:")) {
    const assigneeUserId = value.slice("user:".length);
    return { assigneeAgentId: null, assigneeUserId: assigneeUserId || null };
  }
  // Backward compatibility for older drafts/defaults that stored a raw agent id.
  return { assigneeAgentId: value, assigneeUserId: null };
}

export function currentUserAssigneeOption(currentUserId: string | null | undefined): AssigneeOption[] {
  if (!currentUserId) return [];
  return [{
    id: assigneeValueFromSelection({ assigneeUserId: currentUserId }),
    label: "Me",
    searchText: currentUserId === "local-board" ? "me board human local-board" : `me human ${currentUserId}`,
  }];
}

export function formatAssigneeUserLabel(
  userId: string | null | undefined,
  currentUserId: string | null | undefined,
): string | null {
  if (!userId) return null;
  if (currentUserId && userId === currentUserId) return "Me";
  if (userId === "local-board") return "Board";
  return userId.slice(0, 5);
}

export function activeUserMembers(members: CompanyMembership[] | undefined): CompanyMembership[] {
  return (members ?? []).filter(
    (member) => member.status === "active" && member.principalType === "user",
  );
}

export function memberDisplayName(member: CompanyMembership, currentUserId: string | null): string {
  return member.user?.name?.trim()
    || member.user?.email?.trim()
    || (member.principalId === "local-board" ? "Board" : null)
    || (currentUserId && member.principalId === currentUserId ? "You" : null)
    || member.principalId.slice(0, 8);
}

export function memberAssigneeSearchText(member: CompanyMembership, currentUserId: string | null): string {
  return [
    memberDisplayName(member, currentUserId),
    member.user?.email ?? "",
    member.principalId,
    currentUserId && member.principalId === currentUserId ? "me you self" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function memberAssigneeOptions(
  members: CompanyMembership[] | undefined,
  currentUserId: string | null,
): AssigneeOption[] {
  return activeUserMembers(members).map((member) => ({
    id: assigneeValueFromSelection({ assigneeUserId: member.principalId }),
    label: currentUserId && member.principalId === currentUserId
      ? "Me"
      : memberDisplayName(member, currentUserId),
    searchText: memberAssigneeSearchText(member, currentUserId),
  }));
}
