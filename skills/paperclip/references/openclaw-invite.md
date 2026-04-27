# OpenClaw Invite Workflow

Use this workflow when the CEO is asked to invite a new OpenClaw employee.

## Steps

1. Generate invite prompt:

```bash
POST /api/companies/{companyId}/openclaw/invite-prompt
{ "agentMessage": "optional onboarding note" }
```

2. Build handoff message for board:

- include `onboardingTextUrl` from API response
- include OpenClaw URL from issue context if provided (`ws://` or `wss://`)

3. Post the prompt + URL in issue comments for copy/paste by the operator.

4. After OpenClaw join request, continue onboarding:

- approval handling
- API key claim
- skill install/sync

## Access Rules

- Board users with invite permission may call the endpoint
- Agent callers: CEO agent of the same company only
