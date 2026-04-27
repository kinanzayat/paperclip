# AgentMail NotebookLM

Paperclip can optionally link AgentMail intake issues to NotebookLM notebooks. This keeps long email bodies, transcripts, extracted requirements, and supported document/text attachments out of issue descriptions while preserving source context for agents.

## Endpoints

- `GET /api/issues/:issueId/agentmail-notebook`
- `POST /api/issues/:issueId/agentmail-notebook/query`
- `GET /api/companies/:companyId/agentmail/notebooks/:messageId/status`
- `POST /api/companies/:companyId/agentmail/notebooks/:messageId/resync`

Query body:

```json
{
  "question": "What acceptance criteria did the sender specify?"
}
```

## Agent Rules

- Prefer the Paperclip API over direct NotebookLM CLI use.
- Query only when the AgentMail issue needs original source context.
- Do not paste full transcript or attachment text back into Paperclip unless requested.
- NotebookLM context does not bypass product-owner, CEO, or CTO approval gates.
- If the status is `disabled`, `failed`, or `missing`, continue from the issue and comment context.

Direct CLI fallback:

```bash
nlm login --check
nlm notebook query <notebookId> "Focused question" --json
```
