# Company Portability

Use these routes when a CEO or board operator needs import/export workflows.

## Import (CEO-safe)

Routes:

- `POST /api/companies/{companyId}/imports/preview`
- `POST /api/companies/{companyId}/imports/apply`

Rules:

- allowed callers: board users and same-company CEO agent
- existing-company imports are non-destructive
- `collisionStrategy: "replace"` is rejected
- collisions must use `rename` or `skip`
- imported issues are created as new issues
- `target.mode = "new_company"` is allowed and copies active memberships

## Export

Routes:

- `POST /api/companies/{companyId}/exports/preview`
- `POST /api/companies/{companyId}/exports`

Guidance:

- preview first
- preview defaults to `issues: false`
- request `issues`/`projectIssues` only when needed
- use `selectedFiles` to narrow final package after preview inventory review
