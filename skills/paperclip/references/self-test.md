# Self-Test Playbook

Use this playbook to validate Paperclip assignment and run loop behavior.

## Basic Flow

1. Create throwaway issue assigned to a known local agent:

```bash
npx paperclipai issue create \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --title "Self-test: assignment/watch flow" \
  --description "Temporary validation issue" \
  --status todo \
  --assignee-agent-id "$PAPERCLIP_AGENT_ID"
```

2. Trigger heartbeat:

```bash
npx paperclipai heartbeat run --agent-id "$PAPERCLIP_AGENT_ID"
```

3. Verify status transition and comments:

```bash
npx paperclipai issue get <issue-id-or-identifier>
```

4. Optional reassignment test between local agents:

```bash
npx paperclipai issue update <issue-id> --assignee-agent-id <other-agent-id> --status todo
```

5. Cleanup temporary issues (`done` or `cancelled`) with clear notes.

## Run Header Rule

When using direct `curl` during heartbeat execution, include:

- `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`
