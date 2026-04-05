# Paperclip Public ngrok Auth Setup Plan

## Summary
Use the existing default Paperclip instance, not a repo-local config. Its [config.json](c:/Users/AboodKh/.paperclip/instances/default/config.json) is already aligned with your target: `authenticated`, `public`, `host=0.0.0.0`, `port=3100`, and `auth.publicBaseUrl=https://nondurably-mithridatic-miya.ngrok-free.dev`.

The only runtime config change should be in the instance env file at [`.env`](c:/Users/AboodKh/.paperclip/instances/default/.env): keep the existing `PAPERCLIP_AGENT_JWT_SECRET`, explicitly pin the public-auth settings there, and keep sign-up enabled because this repo’s invite flow requires net-new users to be able to create accounts.

## Runtime Config
Update [`.env`](c:/Users/AboodKh/.paperclip/instances/default/.env) so it contains the existing secret plus these exact settings:

```env
# Preserve the current secret value already in this file
PAPERCLIP_AGENT_JWT_SECRET=<keep-existing-value>

PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
HOST=0.0.0.0
PORT=3100

PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://nondurably-mithridatic-miya.ngrok-free.dev

# Keep enabled so invited new humans can create accounts
PAPERCLIP_AUTH_DISABLE_SIGN_UP=false
```

Do not add a repo-root `.env` for this. The persistent instance env is the correct surface for this setup.

No config.json edits are required unless you want the env file to stop being the source of truth later.

## Startup Sequence
1. Start Paperclip from the repo root with the normal dev flow:
   `pnpm install`
   `pnpm dev`
2. If the repo-level helper is flaky in your shell, fall back to the server package entry:
   `pnpm --filter @paperclipai/server dev`
3. Wait for the server to bind on `3100` and confirm `http://localhost:3100/api/health` responds.
4. In a second terminal, run exactly:
   `ngrok http --url=nondurably-mithridatic-miya.ngrok-free.dev 3100`
5. Use the ngrok URL as the only public entrypoint:
   `https://nondurably-mithridatic-miya.ngrok-free.dev`

If `/api/health` reports `bootstrapStatus=bootstrap_pending`, generate the first-admin invite with:
`pnpm paperclipai auth bootstrap-ceo`
Then open the emitted `/invite/<token>` URL through the ngrok hostname and complete the first admin claim.

## Multi-User Validation
- Open `/auth` from the ngrok URL in a fresh browser profile and verify account creation works.
- Sign in as the first admin and verify the board loads over the ngrok URL without redirect-loop or cookie errors.
- Create or select a company, generate a human invite, and have a second browser profile open `/invite/<token>` through the ngrok domain.
- Confirm the invited user can create an account, submit the join request, and be approved by the admin.
- Verify a second approved user can sign in from a separate machine/browser and see the same company state.
- Confirm mutations work from the public URL: company settings, profile save, issue create, comment post.
- Confirm `/api/health` reflects authenticated mode and that the app is using the ngrok hostname, not `localhost`, for auth flows.

## Important Interfaces
This setup changes only runtime config, not repo code:
- `PAPERCLIP_DEPLOYMENT_MODE`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE`
- `HOST`
- `PORT`
- `PAPERCLIP_AUTH_BASE_URL_MODE`
- `PAPERCLIP_AUTH_PUBLIC_BASE_URL`
- `PAPERCLIP_AUTH_DISABLE_SIGN_UP`
- existing `PAPERCLIP_AGENT_JWT_SECRET`

## Assumptions
- The current secret in [`.env`](c:/Users/AboodKh/.paperclip/instances/default/.env) remains unchanged.
- The ngrok reserved domain `nondurably-mithridatic-miya.ngrok-free.dev` is already owned and valid in your ngrok account.
- Account creation must stay enabled because Paperclip’s current invite flow does not support “invite-only sign-up exemptions” for new humans.
- In this agent shell, `ngrok` resolves to a broken WindowsApps shim and `tsx/esbuild` process startup hits `spawn EPERM`, so execution here is not a trustworthy runtime validator; run the actual start commands from your normal local terminal.
