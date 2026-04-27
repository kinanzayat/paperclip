---
name: paperclip-agentmail-notebooklm
description: >
  Retrieve original AgentMail requirements, transcripts, and supported attachments
  from the NotebookLM notebook linked to a Paperclip issue.
---

# AgentMail NotebookLM Retrieval

Use this skill when a Paperclip issue comes from AgentMail and you need original email context, transcripts, or attachment-derived requirements without expanding the issue description.

## Preferred API Flow

1. Check the linked notebook:

```bash
GET /api/issues/{issueId}/agentmail-notebook
Authorization: Bearer $PAPERCLIP_API_KEY
```

2. If `status` is `synced`, ask focused questions:

```bash
POST /api/issues/{issueId}/agentmail-notebook/query
Authorization: Bearer $PAPERCLIP_API_KEY
{
  "question": "What exact acceptance criteria did the sender request?"
}
```

3. Use concise answers in your issue comment or plan. Do not paste full transcripts or attachment text unless the task specifically requires an excerpt.

## Direct NotebookLM Fallback

If the Paperclip API is unavailable but the status payload already gave you a `notebookId`, you may fallback to:

```bash
nlm notebook query <notebookId> "What source context matters for this issue?" --json
```

Run `nlm login --check` first if using the CLI directly. If authentication is missing, report that the NotebookLM source is unavailable and continue from Paperclip issue context.

## Rules

- Use Paperclip API first; direct `nlm` is only a fallback.
- Ask narrow questions tied to the current issue.
- Treat NotebookLM as source context, not approval. Follow the AgentMail approval gates in the issue.
- If status is `disabled`, `failed`, or `missing`, continue with issue comments and documents and mention the missing context.
