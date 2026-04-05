# Quiet-Mountain End-to-End Validation Runbook

## Summary

Use this runbook after automated checks are green to validate the Quiet-Mountain rollout from a fresh start through roles, invites, profiles, statuses, labels, comments, mentions, and portability.

Recommended actors:

- `U1`: creator and instance admin
- `U2`: invited human, promoted to company admin
- `U3`: invited human, kept as company member
- `A1`: one active agent used for assignee and mention smoke tests

This runbook is written against the current implementation shape:

- profile page: `/profile`
- company settings: `/company/settings`
- invite landing: `/invite/:token`
- inbox approval flow: `/inbox/new`
- issue detail: `/issues/:issueId`
- export/import: `/company/export`, `/company/import`

## Preconditions

Before starting the manual pass, verify:

- `pnpm -r typecheck` passes
- `pnpm test:run` passes
- `pnpm build` passes
- the app is running in authenticated mode
- you can sign in from at least three separate browser profiles or browser containers

Test data and environment assumptions:

- start with a fresh authenticated Paperclip instance for the main validation pass
- use a new company named `Quiet Mountain E2E`
- use fresh invite tokens for each acceptance flow
- if an old pre-Quiet-Mountain company exists, run the upgrade smoke at the end; otherwise treat it as optional follow-up

## Interfaces To Exercise

- Profile APIs: `GET /api/auth/profile`, `PATCH /api/auth/profile`, `POST /api/auth/profile/avatar`, `DELETE /api/auth/profile/avatar`
- Human invite creation API: `POST /api/companies/:companyId/invites`
- Agent invite creation API: `POST /api/companies/:companyId/openclaw/invite-prompt`
- Invite acceptance page: `/invite/:token`
- Company statuses API: `GET/POST/PATCH/DELETE /api/companies/:companyId/statuses`, `POST /api/companies/:companyId/statuses/reorder`
- Export/import surfaces: `/company/export`, `/company/import`

Human invites are currently easiest to create from an authenticated browser session with the current UI/API surface:

```js
// Run in the browser console while signed in as a company admin.
const companies = await fetch("/api/companies").then((r) => r.json());
const companyId = companies.find((c) => c.name === "Quiet Mountain E2E").id;
const invite = await fetch(`/api/companies/${companyId}/invites`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ allowedJoinTypes: "human" }),
}).then((r) => r.json());

console.log(`${location.origin}${invite.inviteUrl}`);
```

## Validation Steps

### 1. Fresh bootstrap and company creation

1. Start from a fresh authenticated Paperclip instance.
2. Complete first-admin bootstrap as `U1`.
3. Create a company named `Quiet Mountain E2E`.
4. Open `/company/settings` as `U1`.

Expected:

- `U1` is instance admin
- `U1` has an active company membership with role `admin`
- `U1` can access `/company/settings`
- the seeded issue statuses are present:
  - `backlog`
  - `todo`
  - `in_progress`
  - `in_review`
  - `blocked`
  - `done`
  - `cancelled`

### 2. Agent baseline

1. Create one active agent `A1` if the company does not already have one.
2. Confirm `A1` appears in agent lists.

Expected:

- `A1` is selectable in issue assignee controls
- `A1` appears in mention autocomplete later in the run

### 3. Invite and promote `U2`

1. Generate a human invite for `U2` using the console snippet above.
2. Open the invite in a separate browser profile.
3. Sign in as `U2` and accept as a human.
4. Back in `U1`, approve the join request from `/company/settings`.
5. In the Members section, change `U2` from `member` to `admin`.

Expected:

- `U2` appears in the member list
- the member row shows resolved name/email data
- membership status is active
- membership role can be changed to `admin`
- `U2` can now open `/company/settings`

### 4. Invite and keep `U3` as member

1. Generate a second human invite for `U3`.
2. Open it in a third browser profile.
3. Sign in as `U3` and accept as a human.
4. Approve the join request from `/inbox/new` instead of Company Settings.
5. Keep `U3` as `member`.

Expected:

- the inbox approval path works, not just Company Settings
- the join-request badge clears after approval
- `U3` appears in the member list
- `U3` remains `member`

### 5. Role guard validation

1. As `U3`, open `/company/settings`.
2. As `U1` and `U2`, test role changes in the Members section.

Expected:

- `U3` sees the company-admin-only access message
- `U3` cannot use status-management, invite, join-request, or member-role admin actions
- one admin can be demoted only while another admin still exists
- the final remaining active admin cannot be demoted to `member`
- no UI surface still refers to `owner`

### 6. Profile propagation

1. As `U1`, open `/profile`, update the display name, upload an avatar, and save.
2. As `U3`, do the same, then remove the avatar again.
3. Revisit sidebar, issue views, and member displays.

Expected:

- profile edits persist through the profile APIs
- names update in sidebar identity and collaboration surfaces
- avatar upload and removal work cleanly
- issue comments and user-assignee labels resolve the new names/images
- no stale `owner` terminology appears in user-facing UI

### 7. Company status administration

1. As `U1` or `U2`, open `/company/settings`.
2. Create `triage` in category `unstarted` and mark it as the default.
3. Create `needs_review` in category `started` with a distinct color.
4. Reorder statuses.
5. Edit one status label, color, and slug.

Expected:

- status creation works from Company Settings
- defaults are reflected correctly per category
- ordering changes persist
- edits are visible immediately in the status list

### 8. Default status on issue creation

1. Create issue `I1` from the new-issue flow.
2. Do not manually override the status.

Expected:

- `I1` starts in `triage`
- the same label/color appears consistently in:
  - issue list
  - issue detail
  - kanban
  - inbox
  - dashboard/activity charts

### 9. Reopen behavior uses company default

1. Move `I1` to `needs_review`.
2. Move `I1` to `done`.
3. Add a comment with reopen enabled.

Expected:

- reopening returns the issue to the default `unstarted` status
- the reopened status is `triage`
- the reopen flow does not hardcode `todo`

### 10. Delete-with-replacement behavior

1. Put at least one issue in `needs_review`.
2. Delete `needs_review` from `/company/settings`.
3. Provide `in_progress` as the replacement slug.

Expected:

- deletion requires a same-category replacement when the deleted status is in use
- affected issues are migrated to `in_progress`
- the deleted status no longer appears in status pickers

### 11. Label editing from issue detail

1. Open `I1`.
2. In Issue Properties, create a new label.
3. Assign it to `I1`.
4. Unassign it.
5. Reassign it.
6. Delete it.

Expected:

- label creation works from issue detail
- assignment changes appear immediately
- deleting the label removes it from all affected views

### 12. Member visibility for non-admin collaboration

1. As `U3`, open an issue.
2. Check assignee chips, creator labels, and mention suggestions.

Expected:

- active member identities resolve correctly for collaboration features
- `U3` can see enough member data for mentions and author mapping
- `U3` still cannot access admin-only settings actions

### 13. Human and agent mentions

1. In an issue comment composer, type `@`.
2. Verify autocomplete includes `U1`, `U2`, `U3`, and agent `A1`.
3. Submit a comment that mentions at least one human and one agent.
4. Use `Ctrl+Enter` or `Cmd+Enter` to submit.

Expected:

- mention autocomplete contains both users and agents
- submitted mentions render as the correct chips
- author names are resolved in the thread
- the thread layout remains visually correct after mention rendering

### 14. Discussion and activity coherence

1. Add second and third comments from different users.
2. Include at least one reopened or updated issue event in the same discussion.
3. Check the issue thread and inbox/live activity surfaces.

Expected:

- comment and timeline ordering stays correct
- comment authors are fully resolved
- comment-driven issue updates are treated as one coherent activity flow in inbox/live updates

### 15. Agent invite smoke

1. From `/company/settings`, generate the OpenClaw invite prompt.
2. Open the resulting `/invite/:token`.
3. Switch to "Join as agent".
4. Submit the request.
5. Approve it as admin.

Expected:

- the agent join request resolves cleanly
- onboarding text/snippet is generated
- the approved agent appears in company surfaces

### 16. Portability regression

1. Export the company from `/company/export`.
2. Import it into a new company using `/company/import` or the CLI preview/apply flow.
3. Open the imported company and inspect statuses, issues, labels, and memberships.

Expected:

- custom statuses survive round-trip
- default status choices survive round-trip
- issue status assignments survive round-trip
- labels survive round-trip
- `admin/member` memberships survive round-trip
- no `owner` role leakage appears in imported data

### 17. Upgrade smoke for older data

1. If an older pre-Quiet-Mountain company exists, open it and inspect membership and status behavior.
2. Validate at least one collaboration and one admin flow on that company.

Expected:

- legacy `owner` memberships behave as `admin`
- no surface still emits `owner`
- status behavior resolves through company statuses rather than hardcoded defaults

## Acceptance Checklist

- creator auto-membership is `admin`
- `member` users cannot use admin-only settings or status-management actions
- the final active company admin cannot be demoted or removed
- active members remain visible for mentions, user labels, and collaboration mapping
- profile name/avatar changes propagate across board UI
- custom statuses work for creation, editing, default selection, reorder, replacement delete, reopen, inbox, charts, and routines-backed flows
- labels can be created, assigned, unassigned, and deleted from issue detail
- human and agent mentions autocomplete and render correctly
- export/import preserves statuses and `admin/member` roles
- no remaining surface shows or depends on `owner`

## Notes

- Run the main pass in authenticated deployment mode so human invite acceptance is realistic.
- Human invites are created through the API snippet because the current admin UI exposes the OpenClaw invite prompt, not a dedicated human-invite button.
- Invite acceptance is single-use, so always mint a fresh invite URL per user.
- If there is no older migrated company available, the upgrade smoke can be deferred, but the fresh-start pass is still required.
