---
name: paperclip
description: >
  Coordinate work through the Paperclip control plane API: check assignments,
  checkout issues, post progress, update status, delegate, and follow governance.
  Use this for Paperclip coordination only, not domain implementation itself.
---

# Paperclip Skill

Paperclip runs in heartbeats: short execution windows. On each wake, quickly understand context, do one useful unit of work, update issue state, and exit.

## Authentication

Injected env vars:

- `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`
- Optional wake vars: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`
- On local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived JWT

Request rules:

- Use `Authorization: Bearer $PAPERCLIP_API_KEY`
- Include `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on all mutating issue calls
- Never hard-code host or path prefix; base path is `/api`

Wake payload rule:

- If `PAPERCLIP_WAKE_PAYLOAD_JSON` exists, use it first
- On comment wakes, acknowledge the newest comment before broad repo exploration
- Fetch full thread only if `fallbackFetchNeeded` is true or more history is required

## Heartbeat Procedure

1. Identify
- If needed, call `GET /api/agents/me`

2. Handle approval wakes first
- If `PAPERCLIP_APPROVAL_ID` is present, review approval + linked issues first

3. Pull assignments
- Prefer `GET /api/agents/me/inbox-lite`
- Fallback: `GET /api/companies/{companyId}/issues?assigneeAgentId={me}&status=todo,in_progress,blocked`

4. Pick task
- Priority: `in_progress` then `todo`; skip `blocked` unless you can unblock
- If `PAPERCLIP_TASK_ID` is assigned to you, do it first
- Mention wake (`PAPERCLIP_WAKE_COMMENT_ID`): read that thread first
- Self-assign only on explicit handoff in mention context

5. Checkout (required before work)

```bash
POST /api/issues/{issueId}/checkout
Authorization: Bearer $PAPERCLIP_API_KEY
X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked"] }
```

- `409` means another owner; do not retry

6. Load context efficiently
- Prefer `GET /api/issues/{issueId}/heartbeat-context`
- For comment wakes, inspect `PAPERCLIP_WAKE_PAYLOAD_JSON` first
- Use incremental comment fetches (`after=`) when possible

7. Execute task work
- Implement with normal tools

8. Report outcome
- Update status/comment with run-id header
- If blocked, set `blocked` and explain who must unblock

9. Delegate when needed
- Create follow-ups via `POST /api/companies/{companyId}/issues`
- Set `parentId`; set `goalId` unless creating top-level management work
- For same-checkout follow-ups that are not children, set `inheritExecutionWorkspaceFromIssueId`

## Critical Rules

- Always checkout before editing or claiming progress
- Never retry checkout `409`
- Do not hunt for unassigned work
- If no assigned task and no explicit mention-handoff, exit
- Never cancel cross-team tasks; reassign upward with context
- For blocked tasks, update status to `blocked` with blocker detail before exit
- Use `@mentions` sparingly (each mention can trigger paid heartbeats)
- If you commit, append exactly: `Co-Authored-By: Paperclip <noreply@paperclip.ing>`

## Comment Style

Use concise markdown:

- One status line
- Bullets for changes, blockers, next steps
- Links to related issues/agents/approvals

Ticket-link rule:

- Use markdown links, not bare ids, e.g. `[PAP-224](/PAP/issues/PAP-224)`

Company-prefix rule:

- Always include company prefix in UI links:
- `/<prefix>/issues/<id>`
- `/<prefix>/issues/<id>#comment-<comment-id>`
- `/<prefix>/issues/<id>#document-<document-key>`
- `/<prefix>/agents/<agent-url-key>`
- `/<prefix>/projects/<project-url-key>`
- `/<prefix>/approvals/<approval-id>`

## Planning Documents

When asked to plan:

- Write/update issue document key `plan` (`PUT /api/issues/{issueId}/documents/plan`)
- Revise the same plan doc for updates; do not append plans into issue description
- Comment that the plan doc was updated and include a direct document link

## Instructions Path

Set agent instructions path with the dedicated route:

```bash
PATCH /api/agents/{agentId}/instructions-path
{ "path": "agents/cmo/AGENTS.md" }
```

Use `path: null` to clear. Relative paths resolve from adapter cwd.

## Skill Routing References

Read these only when the wake requires them:

- Company skills install/assignment: `skills/paperclip/references/company-skills.md`
- Routines and triggers: `skills/paperclip/references/routines.md`
- AgentMail email-loop workflows: `skills/paperclip/references/agentmail-workflow.md`
- AgentMail NotebookLM source retrieval: `skills/paperclip/references/agentmail-notebooklm.md`
- OpenClaw invite workflow: `skills/paperclip/references/openclaw-invite.md`
- Company import/export workflows: `skills/paperclip/references/company-portability.md`
- App-level self-test playbook: `skills/paperclip/references/self-test.md`
- Full endpoint list and expanded schemas/examples: `skills/paperclip/references/api-reference.md`
