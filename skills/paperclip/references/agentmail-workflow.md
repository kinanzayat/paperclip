# AgentMail Workflow

Use this reference when implementing or debugging the email-to-issue loop.

## Source Of Truth

- Treat `message.received` as the production signal
- Treat `message.received.blocked` as diagnostics only
- Keep intake event data, issue tree, comments, and outbound replies consistent

## Scope

Use for:

- webhook intake and signature validation
- inbox and thread handling
- delivery/reply updates
- requirement extraction from inbound email

## CLI Quick Reference

Use `AGENTMAIL_API_KEY` with AgentMail CLI:

```bash
agentmail inboxes list
agentmail webhooks list
agentmail webhooks create --event-type message.received --url https://example.com/webhook
agentmail inboxes:messages send --inbox-id <inbox_id> --to user@example.com --subject "Hello" --text "Hi there"
agentmail inboxes:messages reply --inbox-id <inbox_id> --message-id <message_id> --text "Thanks, I will look into it."
```

Prefer plain text + markdown emphasis/bullets/links in outbound replies unless HTML is explicitly required.

## Verification Contract

Follow close-the-loop validation before marking done:

1. Write/update implementation and tests
2. Run targeted tests and typecheck
3. Fix failures and rerun
4. Confirm issue/comments reflect final behavior

Suggested AgentMail checks:

1. Simulate `message.received`; verify issue creation/update
2. Simulate `message.received.blocked`; verify diagnostics-only handling
3. Send a real inbox message; verify issue/comment/reply alignment
4. Validate UI visibility for intake/analysis data
5. Run tests before final status update
