# Paperclip AgentMail + NotebookLM Deployment With TryCloudflare

Date: 2026-04-27

This guide deploys Paperclip on a Linux server with:

- Paperclip running as a `systemd` service
- AgentMail inbound email intake
- NotebookLM ingestion through the `nlm` CLI
- Cloudflare Quick Tunnel exposing Paperclip through a `trycloudflare.com` URL
- Automatic restart after server reboot or process failure

## Important Caveat

`trycloudflare.com` quick-tunnel URLs are temporary. You can make the service restart automatically and publish a new quick-tunnel URL after reboot, but you cannot rely on the same `trycloudflare.com` hostname surviving restarts.

For a stable production URL, use a named Cloudflare Tunnel with your own domain, for example:

```text
https://paperclip.example.com
```

Use this guide if you are comfortable with the public URL changing after reboot.

## Recommended AgentMail Mode

Use AgentMail WebSocket inbound mode when using `trycloudflare.com`.

Why:

- Webhook mode requires a public callback URL.
- A quick-tunnel URL changes after restart.
- That means every restart would require updating the AgentMail webhook URL.
- WebSocket mode connects outbound from Paperclip to AgentMail and does not need a stable public webhook URL.

Use webhook mode only if you have a stable domain.

## Server Requirements

Recommended minimum:

```text
Ubuntu 22.04 or 24.04
2 vCPU
4 GB RAM
20 GB disk
Outbound internet access
```

Required software:

```text
Node.js 20+
pnpm 9+
git
curl
ripgrep
python3
cloudflared
NotebookLM CLI: nlm
```

Optional but usually needed for local agents:

```text
Codex CLI
Claude Code CLI
OpenCode CLI
OpenAI API key
Anthropic API key
```

Paperclip includes the AgentMail npm SDK in the server package. You do not need a separate AgentMail daemon.

## 1. Install System Packages

```bash
sudo apt update
sudo apt install -y git curl ca-certificates build-essential python3 python3-venv ripgrep
```

## 2. Install Node.js 20 And pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@9.15.4 --activate
```

Verify:

```bash
node --version
pnpm --version
```

## 3. Install cloudflared

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update
sudo apt install -y cloudflared
```

Verify:

```bash
cloudflared --version
```

Quick tunnel command shape:

```bash
cloudflared tunnel --url http://localhost:3100
```

## 4. Install AgentMail CLI For Setup And Debugging

Paperclip uses the AgentMail SDK internally, but the CLI is useful for setup checks.

```bash
sudo npm install -g agentmail-cli
```

Set your AgentMail API key for shell use:

```bash
export AGENTMAIL_API_KEY="am_..."
```

Useful checks:

```bash
agentmail inboxes list
agentmail webhooks list
```

## 5. Create A Dedicated Paperclip User

```bash
sudo useradd --system --create-home --home-dir /var/lib/paperclip --shell /bin/bash paperclip
sudo mkdir -p /opt/paperclip /var/lib/paperclip
sudo chown -R paperclip:paperclip /opt/paperclip /var/lib/paperclip
```

The `paperclip` user must own the Paperclip runtime data and must be the user that logs in to NotebookLM.

## 6. Clone And Build Paperclip

Replace `<repo-url>` with your repo URL.

```bash
sudo -u paperclip -H bash -lc '
cd /opt/paperclip
git clone <repo-url> app
cd app
pnpm install --frozen-lockfile
pnpm build
'
```

If you are deploying from an existing checkout instead of cloning:

```bash
sudo mkdir -p /opt/paperclip/app
sudo rsync -a --delete ./ /opt/paperclip/app/
sudo chown -R paperclip:paperclip /opt/paperclip/app
sudo -u paperclip -H bash -lc '
cd /opt/paperclip/app
pnpm install --frozen-lockfile
pnpm build
'
```

## 7. Install NotebookLM CLI As The Paperclip User

Install `uv` and `nlm` under the `paperclip` user:

```bash
sudo -u paperclip -H bash -lc '
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv tool install notebooklm-mcp-cli
nlm --version
'
```

Log in to NotebookLM:

```bash
sudo -u paperclip -H bash -lc '
export PATH="$HOME/.local/bin:$PATH"
nlm login
nlm login --check
'
```

Important:

- Run `nlm login` as the `paperclip` user.
- NotebookLM sessions can expire.
- If NotebookLM auth fails, Paperclip AgentMail intake still creates issues, but notebook sync status becomes `failed`.

## 8. Create Paperclip Environment File

Create the config directory:

```bash
sudo mkdir -p /etc/paperclip
sudo nano /etc/paperclip/paperclip.env
```

Use this template:

```bash
NODE_ENV=production
SERVE_UI=true
HOST=0.0.0.0
PORT=3100

PAPERCLIP_HOME=/var/lib/paperclip
PAPERCLIP_INSTANCE_ID=default
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_MIGRATION_AUTO_APPLY=true
PAPERCLIP_MIGRATION_PROMPT=never

BETTER_AUTH_SECRET=replace-with-long-random-secret
PAPERCLIP_AGENT_JWT_SECRET=replace-with-long-random-secret-too

# Optional local agent keys.
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-...

# AgentMail.
PAPERCLIP_AGENTMAIL_API_KEY=am_...
PAPERCLIP_AGENTMAIL_OUTBOUND_INBOX_ID=inb_...

# Recommended for trycloudflare deployments.
PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT=websocket
PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX=inb_...
PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID=replace-after-paperclip-company-exists

# NotebookLM.
PAPERCLIP_NOTEBOOKLM_ENABLED=true
PAPERCLIP_NOTEBOOKLM_ATTACHMENT_MAX_BYTES=10485760
PAPERCLIP_NOTEBOOKLM_ALLOWED_MIME_TYPES=text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document
```

Generate secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Secure the env file:

```bash
sudo chown root:paperclip /etc/paperclip/paperclip.env
sudo chmod 640 /etc/paperclip/paperclip.env
```

## 9. Notes On The Company ID

`PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID` must be a real Paperclip company ID.

On a fresh server:

1. Start Paperclip once.
2. Open the UI.
3. Complete onboarding or create/import the company.
4. Copy the company ID from the API/UI.
5. Put it into `/etc/paperclip/paperclip.env`.
6. Restart Paperclip.

You can inspect companies locally after the server is running:

```bash
curl http://127.0.0.1:3100/api/companies
```

## 10. Create Quick-Tunnel Runner Script

Create the runner:

```bash
sudo nano /opt/paperclip/run-with-quick-tunnel.sh
```

Content:

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/paperclip/app"
DATA_DIR="/var/lib/paperclip"
CF_LOG="$DATA_DIR/cloudflared.log"
URL_FILE="$DATA_DIR/current-trycloudflare-url.txt"

cd "$APP_DIR"
rm -f "$CF_LOG"

cloudflared tunnel --no-autoupdate --url http://localhost:3100 2>&1 | tee "$CF_LOG" &
CF_PID=$!

cleanup() {
  kill "$CF_PID" "${PC_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

URL=""
for _ in $(seq 1 90); do
  URL="$(grep -Eo 'https://[-a-zA-Z0-9]+\.trycloudflare\.com' "$CF_LOG" | tail -1 || true)"
  if [ -n "$URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$URL" ]; then
  echo "Failed to discover trycloudflare URL"
  exit 1
fi

echo "$URL" > "$URL_FILE"
echo "Paperclip public URL: $URL"

export PAPERCLIP_PUBLIC_URL="$URL"
export PAPERCLIP_AUTH_BASE_URL_MODE=explicit
export PAPERCLIP_AUTH_PUBLIC_BASE_URL="$URL"
export BETTER_AUTH_TRUSTED_ORIGINS="$URL"
export PAPERCLIP_ALLOWED_HOSTNAMES="${URL#https://}"
export PATH="/var/lib/paperclip/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

pnpm --filter @paperclipai/server start &
PC_PID=$!

wait -n "$CF_PID" "$PC_PID"
exit 1
```

Set permissions:

```bash
sudo chown paperclip:paperclip /opt/paperclip/run-with-quick-tunnel.sh
sudo chmod +x /opt/paperclip/run-with-quick-tunnel.sh
```

## 11. Create systemd Service

Create:

```bash
sudo nano /etc/systemd/system/paperclip.service
```

Content:

```ini
[Unit]
Description=Paperclip with Cloudflare Quick Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paperclip
Group=paperclip
WorkingDirectory=/opt/paperclip/app
EnvironmentFile=/etc/paperclip/paperclip.env
ExecStart=/opt/paperclip/run-with-quick-tunnel.sh
Restart=always
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGINT

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable paperclip
sudo systemctl start paperclip
```

View logs:

```bash
sudo journalctl -u paperclip -f
```

Read the current public URL:

```bash
sudo cat /var/lib/paperclip/current-trycloudflare-url.txt
```

## 12. First Boot Flow

1. Start the service:

   ```bash
   sudo systemctl start paperclip
   ```

2. Get the public URL:

   ```bash
   sudo cat /var/lib/paperclip/current-trycloudflare-url.txt
   ```

3. Open that URL in the browser.

4. Complete Paperclip onboarding.

5. Find the company ID:

   ```bash
   curl http://127.0.0.1:3100/api/companies
   ```

6. Edit env:

   ```bash
   sudo nano /etc/paperclip/paperclip.env
   ```

7. Set:

   ```bash
   PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID=<real-company-id>
   ```

8. Restart:

   ```bash
   sudo systemctl restart paperclip
   ```

## 13. AgentMail WebSocket Verification

Check Paperclip health:

```bash
curl http://127.0.0.1:3100/api/health
```

Check AgentMail inbound status:

```bash
curl http://127.0.0.1:3100/api/companies/<companyId>/agentmail/status
```

Expected fields:

```json
{
  "transportMode": "websocket",
  "enabled": true,
  "configuredInbox": "inb_...",
  "configuredCompanyId": "...",
  "connected": true,
  "subscribed": true,
  "lastError": null
}
```

Send a real email to the AgentMail inbox address.

Then confirm:

- A Paperclip issue is created or updated.
- AgentMail intake comments are visible on the issue.
- Initial AgentMail analysis wake is queued.
- NotebookLM status eventually becomes `synced`.

## 14. NotebookLM Verification

Check the `nlm` auth state as the service user:

```bash
sudo -u paperclip -H bash -lc '
export PATH="$HOME/.local/bin:$PATH"
nlm login --check
'
```

For an issue created from AgentMail:

```bash
curl http://127.0.0.1:3100/api/issues/<issueId>/agentmail-notebook
```

Query the notebook:

```bash
curl -X POST http://127.0.0.1:3100/api/issues/<issueId>/agentmail-notebook/query \
  -H "Content-Type: application/json" \
  -d '{"question":"What are the original requirements from this email?"}'
```

Check status by AgentMail message ID:

```bash
curl http://127.0.0.1:3100/api/companies/<companyId>/agentmail/notebooks/<messageId>/status
```

Resync a notebook:

```bash
curl -X POST http://127.0.0.1:3100/api/companies/<companyId>/agentmail/notebooks/<messageId>/resync
```

## 15. Webhook Mode Alternative

Use this only when you have a stable public URL.

Set:

```bash
PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT=webhook
PAPERCLIP_AGENTMAIL_WEBHOOK_SECRET=replace-with-shared-secret
```

Webhook URL:

```text
https://paperclip.example.com/api/companies/<companyId>/webhooks/agentmail
```

Subscribe AgentMail to:

```text
message.received
```

With `trycloudflare.com`, the equivalent URL is:

```text
https://<current-quick-tunnel>.trycloudflare.com/api/companies/<companyId>/webhooks/agentmail
```

That URL changes after restart, so webhook mode is not recommended for quick tunnels.

## 16. Stable Cloudflare Tunnel Alternative

For a durable setup:

1. Add a domain to Cloudflare.
2. Create a named Cloudflare Tunnel.
3. Route `https://paperclip.example.com` to `http://localhost:3100`.
4. Install `cloudflared` as a system service.
5. Set static Paperclip URL env vars:

   ```bash
   PAPERCLIP_PUBLIC_URL=https://paperclip.example.com
   PAPERCLIP_AUTH_BASE_URL_MODE=explicit
   PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://paperclip.example.com
   BETTER_AUTH_TRUSTED_ORIGINS=https://paperclip.example.com
   PAPERCLIP_ALLOWED_HOSTNAMES=paperclip.example.com
   ```

6. Use AgentMail webhook mode if preferred:

   ```text
   https://paperclip.example.com/api/companies/<companyId>/webhooks/agentmail
   ```

This is the recommended production setup.

## 17. Operational Commands

Restart Paperclip:

```bash
sudo systemctl restart paperclip
```

Stop Paperclip:

```bash
sudo systemctl stop paperclip
```

Watch logs:

```bash
sudo journalctl -u paperclip -f
```

Show service status:

```bash
sudo systemctl status paperclip
```

Show current quick-tunnel URL:

```bash
sudo cat /var/lib/paperclip/current-trycloudflare-url.txt
```

Check local API:

```bash
curl http://127.0.0.1:3100/api/health
```

Check listening port:

```bash
ss -ltnp | grep 3100
```

## 18. Updating Paperclip

```bash
sudo systemctl stop paperclip

sudo -u paperclip -H bash -lc '
cd /opt/paperclip/app
git pull
pnpm install --frozen-lockfile
pnpm build
'

sudo systemctl start paperclip
sudo journalctl -u paperclip -f
```

Because `PAPERCLIP_MIGRATION_AUTO_APPLY=true`, pending migrations are applied on startup.

## 19. Backup Notes

If using embedded PostgreSQL, back up:

```text
/var/lib/paperclip
```

This contains:

- Embedded database data
- Uploaded files
- local agent workspaces
- NotebookLM auth/session files under the service user's home
- current quick-tunnel URL file

At minimum:

```bash
sudo tar -czf paperclip-backup-$(date +%F).tar.gz /var/lib/paperclip
```

For production, prefer external Postgres and regular database backups.

## 20. Troubleshooting

### Paperclip Does Not Start

```bash
sudo journalctl -u paperclip -n 200 --no-pager
```

Common causes:

- Missing `BETTER_AUTH_SECRET`
- Port 3100 already in use
- Bad env file syntax
- Pending migrations refused because auto-apply is disabled
- `pnpm build` was not run

### No trycloudflare URL Appears

```bash
sudo journalctl -u paperclip -f
sudo cat /var/lib/paperclip/cloudflared.log
```

Common causes:

- `cloudflared` not installed
- outbound network blocked
- Cloudflare quick tunnel temporary issue

### AgentMail Inbound Not Receiving

Check env:

```bash
sudo grep PAPERCLIP_AGENTMAIL /etc/paperclip/paperclip.env
```

Check status:

```bash
curl http://127.0.0.1:3100/api/companies/<companyId>/agentmail/status
```

Common causes:

- Wrong `PAPERCLIP_AGENTMAIL_API_KEY`
- Wrong inbox ID
- Wrong company ID
- WebSocket transport disabled

### NotebookLM Sync Fails

Check login:

```bash
sudo -u paperclip -H bash -lc '
export PATH="$HOME/.local/bin:$PATH"
nlm login --check
'
```

Common causes:

- `nlm` not installed for the `paperclip` user
- `nlm` not on `PATH`
- NotebookLM login expired
- Attachment MIME type not allowed
- Attachment too large

### AgentMail Issues Are Created But Notebook Status Is Disabled

Check:

```bash
sudo grep PAPERCLIP_NOTEBOOKLM /etc/paperclip/paperclip.env
```

Required:

```bash
PAPERCLIP_NOTEBOOKLM_ENABLED=true
```

Restart after changing:

```bash
sudo systemctl restart paperclip
```

## 21. Security Notes

- Treat AgentMail email content and attachments as sensitive.
- NotebookLM ingestion sends supported content to Google NotebookLM.
- Keep `PAPERCLIP_NOTEBOOKLM_ENABLED=false` unless you explicitly want that behavior.
- Protect `/etc/paperclip/paperclip.env`.
- Use authenticated Paperclip mode when exposing over the internet.
- Prefer a stable Cloudflare Tunnel with your own domain for production.

## 22. Source References

- Cloudflare Tunnel docs: https://developers.cloudflare.com/tunnel/
- Cloudflare Quick Tunnels: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- TryCloudflare quick tunnel page: https://try.cloudflare.com/
- Cloudflare downloads: https://developers.cloudflare.com/tunnel/downloads/
- AgentMail CLI docs: https://www.agentmail.to/docs/integrations/cli
- AgentMail webhook overview: https://docs.agentmail.to/overview
- AgentMail `message.received` event: https://www.agentmail.to/docs/api-reference/webhooks/events/message-received
