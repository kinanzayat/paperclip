# AgentMail Requirement Approval Gate

## Summary

- Immediate containment: cancel any live implementation runs started from unapproved AgentMail issues, preserve their notes, and reset those issues to a non-executing state before resuming work.
- Fix the three current failure points in [agentmail routing](C:/Users/AboodKh/Documents/Projects/paperclip/server/src/routes/agentmail.ts#L23), [AgentMail delivery/sending](C:/Users/AboodKh/Documents/Projects/paperclip/server/src/services/agentmail.ts#L430), and the default [CEO delegation prompt](C:/Users/AboodKh/Documents/Projects/paperclip/server/src/onboarding-assets/ceo/AGENTS.md#L7).
- Replace the current flow with: inbound email -> issue extraction -> Product Analyzer checks requirement against code -> refined requirement email sent for approve/reject/edit -> only after approval does normal implementation routing begin.

## Implementation Changes

- Intake and routing
  - Restrict `agentmail_requirement_analysis` wakes to a dedicated Product Analyzer only; remove CEO/CTO/engineer fallback for this wake type.
  - If no Product Analyzer exists, still create or update the issue tree, but leave the issue unassigned in `backlog`, record `awaiting_analyzer_agent`, and queue no implementation wake.
  - Stop auto-moving AgentMail intake issues to `todo` during webhook processing.

- Product Analyzer workflow
  - Add a dedicated Product Analyzer managed instructions bundle and sync it into existing managed agent homes as well as future hires.
  - Require this agent to inspect the repo and current code before replying, then produce a refined requirement packet containing:
    - requested change
    - feasible now
    - hard or risky parts
    - scope cuts or tradeoffs
    - recommended implementation-ready requirement
    - proposed issue/sub-issue breakdown
  - Update the outbound AgentMail summary email to send that refined packet instead of a raw extracted summary.
  - Support reply actions `approve`, `reject`, and `edit`, with `clarify` accepted as a backward-compatible alias.
  - Explicitly forbid Product Analyzer, CEO, and CTO from starting implementation while the linked requirement approval is unresolved.

- Approval gate
  - Add a new approval type for AgentMail requirement confirmation and link it to the intake issue.
  - When the refined requirement email is sent, create a pending approval and move the issue to `blocked`.
  - On `approve`, mark the approval `approved`, move the issue to `todo`, and then hand it into the normal implementation routing/wakeup path.
  - On `reject` or `edit`, keep the issue `blocked`, update the issue/comments/approval payload, and re-wake only the Product Analyzer.

- Email correlation and reply handling
  - Extend AgentMail delivery tracking to persist reply-correlation data for the outbound analyzer email, including linked approval id and outbound message/thread identifiers or equivalent token.
  - Detect replies to pending requirement approvals before normal requirement extraction, so reply emails are treated as approval actions rather than new implementation requests.
  - Surface the email/approval state in the issue intake UI, including `awaiting_analyzer_agent`, `awaiting_reply`, `approved`, `rejected`, and `revision_requested`.

## Test Plan

- Webhook with only CEO/CTO present creates or updates the issue tree but does not assign or wake CEO/CTO and does not start implementation.
- Webhook with a Product Analyzer present wakes only that agent and keeps the issue non-executable until approval exists.
- Analyzer outbound review creates a linked pending approval, blocks the issue, and stores reply-correlation data.
- Reply `approve` resolves the approval, moves the issue to `todo`, and only then queues implementation routing.
- Reply `reject` or `edit` keeps the issue blocked, re-wakes the analyzer, and queues no implementation wake.
- Regression test that a misrouted `agentmail_requirement_analysis` wake no longer causes CEO prompt-driven CTO delegation.

## Assumptions

- Use approval entities for confirmation instead of adding new issue statuses.
- `blocked` is the default issue status while waiting for analyzer review or email approval; `todo` is the default post-approval handoff status.
- A dedicated Product Analyzer agent is required; if absent, the system waits rather than falling back to CEO or CTO.
- Confirmation is driven by email replies, not by board UI, for this workflow.
- Existing managed instruction bundles must be resynced so the fix applies to the current company, not only future hires.
