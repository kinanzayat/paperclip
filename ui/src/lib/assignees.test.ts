import { describe, expect, it } from "vitest";
import type { CompanyMembership } from "@paperclipai/shared";
import {
  activeUserMembers,
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  formatAssigneeUserLabel,
  memberAssigneeOptions,
  memberDisplayName,
  parseAssigneeValue,
  suggestedCommentAssigneeValue,
} from "./assignees";

describe("assignee selection helpers", () => {
  it("encodes and parses agent assignees", () => {
    const value = assigneeValueFromSelection({ assigneeAgentId: "agent-123" });

    expect(value).toBe("agent:agent-123");
    expect(parseAssigneeValue(value)).toEqual({
      assigneeAgentId: "agent-123",
      assigneeUserId: null,
    });
  });

  it("encodes and parses current-user assignees", () => {
    const [option] = currentUserAssigneeOption("local-board");

    expect(option).toEqual({
      id: "user:local-board",
      label: "Me",
      searchText: "me board human local-board",
    });
    expect(parseAssigneeValue(option.id)).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });
  });

  it("treats an empty selection as no assignee", () => {
    expect(parseAssigneeValue("")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("keeps backward compatibility for raw agent ids in saved drafts", () => {
    expect(parseAssigneeValue("legacy-agent-id")).toEqual({
      assigneeAgentId: "legacy-agent-id",
      assigneeUserId: null,
    });
  });

  it("formats current and board user labels consistently", () => {
    expect(formatAssigneeUserLabel("user-1", "user-1")).toBe("Me");
    expect(formatAssigneeUserLabel("local-board", "someone-else")).toBe("Board");
    expect(formatAssigneeUserLabel("user-abcdef", "someone-else")).toBe("user-");
  });

  it("filters to active user memberships and formats member labels", () => {
    const members: CompanyMembership[] = [
      {
        id: "m-1",
        companyId: "c-1",
        principalType: "user",
        principalId: "local-board",
        status: "active",
        membershipRole: "admin",
        user: { id: "local-board", name: null, email: null, image: null },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "m-2",
        companyId: "c-1",
        principalType: "agent",
        principalId: "agent-1",
        status: "active",
        membershipRole: "member",
        user: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "m-3",
        companyId: "c-1",
        principalType: "user",
        principalId: "user-2",
        status: "suspended",
        membershipRole: "member",
        user: { id: "user-2", name: "User Two", email: "two@example.com", image: null },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    expect(activeUserMembers(members)).toHaveLength(1);
    expect(memberDisplayName(members[0]!, "user-x")).toBe("Board");
  });

  it("builds member assignee options including Me alias and search text", () => {
    const now = new Date();
    const options = memberAssigneeOptions(
      [
        {
          id: "m-1",
          companyId: "c-1",
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "admin",
          user: { id: "user-1", name: "User One", email: "one@example.com", image: null },
          createdAt: now,
          updatedAt: now,
        },
      ] as CompanyMembership[],
      "user-1",
    );

    expect(options).toEqual([
      {
        id: "user:user-1",
        label: "Me",
        searchText: "User One one@example.com user-1 me you self",
      },
    ]);
  });

  it("suggests the last non-me commenter without changing the actual assignee encoding", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [
          { authorUserId: "board-user" },
          { authorAgentId: "agent-123" },
        ],
        "board-user",
      ),
    ).toBe("agent:agent-123");
  });

  it("falls back to the actual assignee when there is no better commenter hint", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [{ authorUserId: "board-user" }],
        "board-user",
      ),
    ).toBe("user:board-user");
  });

  it("skips the current agent when choosing a suggested commenter assignee", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [
          { authorUserId: "board-user" },
          { authorAgentId: "agent-self" },
          { authorAgentId: "agent-123" },
        ],
        null,
        "agent-self",
      ),
    ).toBe("agent:agent-123");
  });
});
