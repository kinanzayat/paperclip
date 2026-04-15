# Make AgentMail Intake Repo-Aware with `CEO (Codex Plan) -> PM -> CEO -> CTO`

## Summary

Use the parent issue as the single source of truth and make the initial AgentMail intake repo-aware before PM sees it.

Chosen workflow:
1. AgentMail creates or updates one parent issue.
2. `CEO` is assigned first.
3. `CEO` runs Codex in planning-only mode, scans the repo, rewrites the parent issue description to match the actual codebase, and posts the structured CEO intake comment.
4. `PM` (Product Owner EVA) is assigned next and handles stakeholder clarification on the same parent issue.
5. `CEO` is assigned again for approval on the same parent issue.
6. `CTO` is assigned only after CEO approval, first in planning/review mode for technical review, then later for implementation after approval gates clear.

No clarification child issue like `B-45`. No queue-empty blocker issue like `B-44`.

## Key Changes

### 1. Make Codex AgentMail wakes explicitly planning-only
- Add wake-reason-specific prompt augmentation for Codex local runs in [execute.ts](/c:/Users/AboodKh/Documents/Projects/paperclip/packages/adapters/codex-local/src/server/execute.ts).
- For these wake reasons, inject a planning-only directive into the stdin prompt:
  - `agentmail_requirement_analysis`
  - `agentmail_ceo_approval_requested`
  - `agentmail_tech_review_requested`
- The directive should explicitly say:
  - inspect the codebase first
  - do not implement
  - do not create execution tasks
  - rewrite the parent issue requirement to match the current codebase
  - comment with the required structured marker only
- Keep normal execution behavior unchanged for implementation wakes like `agentmail_implementation_authorized`.

### 2. Lock the AgentMail flow to one parent issue
- Keep the parent issue as the only requirement card throughout `CEO -> PM -> CEO -> CTO`.
- Forbid CEO and CTO AgentMail review wakes from creating clarification child issues.
- PM clarification also stays on the parent issue; Product Owner EVA updates the parent description and comments there.
- Remove the old Product Analyzer fallback from the active managed CEO instructions and from any AgentMail flow selection.
- PM selection should resolve to the `pm` role only for this flow.

### 3. Ensure the parent issue description always contains the requirement packet
- Preserve the initial AgentMail requirement packet in `issues.description` on the parent issue.
- CEO planning pass should refine that same description rather than replacing it with a blank or unrelated summary.
- The refined description should still include:
  - the original email intent
  - repo-aware constraints
  - clarified requirement
  - acceptance boundaries
- Verify `GET /api/issues/:id` and the issue detail page both surface the stored parent description consistently.

### 4. Fix the CEO instruction contract and stale managed bundles
- Stop telling agents that heartbeat docs live under `$AGENT_HOME/...` when runtime `AGENT_HOME` is actually the workspace/personal home.
- Introduce a separate managed-instructions directory env, and update CEO/CTO onboarding docs to reference that location.
- Auto-sync managed agent instruction bundles when source onboarding assets change and before managed local-agent wakes.
- Invalidate or rotate resumed Codex sessions when the managed instruction bundle version changes so stale CEO instructions cannot survive.

### 5. Remove blocker noise from empty CTO queues
- Do not auto-create top-level blocker issues when CTO has no execution-ready work.
- Replace that with activity logging and optional comments on the relevant issue only.
- Also fix automation-authored markdown/newline handling so literal PowerShell escape sequences cannot be stored into issue descriptions.

## Test Plan

- AgentMail intake acceptance with [requriment_email.md](/c:/Users/AboodKh/Documents/Projects/paperclip/requriment_email.md):
  - one parent issue only
  - project resolves to `HR`
  - parent description contains the raw/refined requirement
  - first assignee is `CEO`
- CEO planning wake:
  - Codex receives planning-only instructions for `agentmail_requirement_analysis`
  - scans the repo
  - rewrites the parent issue description
  - posts only the structured CEO intake comment
  - creates no child clarification issue
- PM clarification:
  - Product Owner EVA is assigned on the parent issue
  - no Product Analyzer fallback
- CEO approval:
  - CEO receives planning-only approval wake on the same parent issue
- CTO review:
  - CTO receives planning-only technical review wake first
  - CTO does not implement until implementation authorization
- Regression:
  - no `B-45`-style clarification child issue
  - no `B-44`-style queue-empty blocker issue
  - no malformed `Statusn...nn-` descriptions

## Assumptions

- Initial repo-aware requirement shaping belongs to `CEO`, not `CTO`.
- `CTO` stays repo-aware and planning-only during technical review, then becomes executable only after approval.
- Product Owner EVA is the PM agent for AgentMail clarification.
- Parent issue only; no clarification sub-issue workflow.
