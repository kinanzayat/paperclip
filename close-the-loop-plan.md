# Close the Loop Plan

## Goal
Make coding agents verify their own work end-to-end before declaring a task done.

## Recommendation: Which repo to use
Use **henrino3/ctrl** as the conceptual source for the methodology and agent-facing rules.
Use **openclaw/openclaw** as the implementation target for integrating the workflow into OpenClaw itself.

### Why
- `ctrl` is purpose-built for the close-the-loop methodology.
- OpenClaw already has agent orchestration, browser tools, sessions, and channel delivery.
- The best result is not copying one repo wholesale, but **porting the methodology from ctrl into OpenClaw’s agent workflow**.

## Short answer
- If your goal is to **reuse the methodology**: pick **ctrl**.
- If your goal is to **ship the feature inside OpenClaw**: implement it in **openclaw/openclaw**.
- Best practice: **study ctrl, implement in openclaw**.

## Working Model
1. Understand the current behavior and user-facing intent.
2. Implement the smallest viable change.
3. Add or update tests for the changed behavior.
4. Run verification immediately.
5. Inspect failures and fix forward.
6. Re-run checks until the loop is closed.

## Verification Rules
- User-facing changes must be exercised in a real browser before completion.
- Prefer executable verification over assumptions.
- Add automated tests when a behavior can be expressed reliably in code.
- Use Chrome DevTools or Playwright for landing page, onboarding, admin, and deployment smoke checks.
- Call out any gaps if something cannot be verified locally.

## Done Criteria
- The changed behavior works.
- Relevant tests pass.
- A browser smoke check has been run for affected user flows.
- Any remaining risk is explicit.

## How to implement this in any project

### 1) Add a project-level agent contract
Create a file like:
- `AGENTS.md`
- `TESTING.md`
- optionally `.clauderc`, `.cursorrules`, `copilot-instructions.md`

This should tell agents:
- what commands to run
- what counts as verification
- when browser checks are mandatory
- when DB checks are mandatory

### 2) Define the verification ladder
Use a layered model:
- Unit tests for pure logic
- Integration tests for routes / DB / services
- Browser smoke checks for user-facing flows
- Live API checks only when needed
- Docker cold-start smoke for release confidence

### 3) Make completion evidence explicit
The agent should return a structured completion note:
- files changed
- tests run
- browser flows exercised
- DB checks run
- failures found
- fixes applied
- remaining risk

### 4) Tie completion to actual proof
Do not allow “done” until the agent shows evidence.
If the browser or tests fail, the agent must fix and rerun.

### 5) Keep the loop short
The feedback loop should be fast enough that the agent can actually use it.
If verification is too slow, the agent will skip it.

## OpenClaw-specific gaps to close
If you want this inside OpenClaw, I would add:
- a close-the-loop instruction file for coding agents
- browser verification hooks for UI-changing tasks
- DB verification guidance for Supabase-backed flows
- a completion summary format that the agent must fill out
- optional CI enforcement so the loop is not just advisory

## Suggested repo structure for OpenClaw
- `AGENTS.md` — agent operating rules
- `TESTING.md` — testing and verification conventions
- `docs/close-the-loop.md` — human-readable methodology
- `scripts/` — helper scripts for test/browser/DB verification
- `.github/workflows/` — CI enforcement of gates

## Recommended rollout
### Phase 1
Document the workflow and add the instructions.

### Phase 2
Enforce unit/integration test gates.

### Phase 3
Add browser smoke verification requirements for UI flows.

### Phase 4
Add DB verification patterns for Supabase or other stateful flows.

### Phase 5
Make the completion report mandatory for coding-agent tasks.

## Final recommendation
Use **ctrl** as the blueprint and **OpenClaw** as the place to implement it.
That gives you the methodology and the platform together.
