# Start Here: Push This Repo To GitHub And Deploy It On Your Server

This section gives you the exact order to:

1. push this local repo to your GitHub repo
2. clone that repo on your Linux server
3. run Paperclip there with Docker Compose

Important notes for this working copy:

- `origin` already exists in this repo and currently points somewhere else, so `git remote add origin ...` will fail here
- the current branch is `agentMail`, and `git branch -M main` will rename it to `main`
- your local changes must be committed before they can be pushed

## 1. Create the GitHub repo

Create this empty repository on GitHub first:

```text
https://github.com/abdulrahman-kharzoum/paperclip-agentmail-openclaw.git
```

When creating it on GitHub:

- do not add a README
- do not add a `.gitignore`
- do not add a license

## 2. Push this local repo to your GitHub

Run these commands from the repo root on your local machine:

```powershell
git status --short
git add -A
git commit -m "Prepare Paperclip fork for deployment"
git remote set-url origin https://github.com/abdulrahman-kharzoum/paperclip-agentmail-openclaw.git
git remote -v
git branch -M main
git push -u origin main
```

Notes:

- if `git commit` says there is nothing to commit, that is fine; continue with the next command
- if GitHub asks for authentication, use your GitHub username and a Personal Access Token, or use GitHub CLI login first
- after the push, your code will be available at your GitHub repo URL

## 3. Prepare the Linux server

These steps assume Ubuntu or Debian.

SSH into your server, then run:

```bash
sudo apt update
sudo apt install -y git docker.io docker-compose-plugin openssl
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Then log out of the server and log back in so the Docker group change takes effect.

Check Docker:

```bash
docker --version
docker compose version
```

## 4. Clone your repo on the server

```bash
mkdir -p ~/apps
cd ~/apps
git clone https://github.com/abdulrahman-kharzoum/paperclip-agentmail-openclaw.git
cd paperclip-agentmail-openclaw
git checkout main
```

## 5. Create the deployment `.env`

Create a `.env` file in the repo root on the server with these values:

```dotenv
BETTER_AUTH_SECRET=replace-with-openssl-output
PAPERCLIP_PUBLIC_URL=http://YOUR_SERVER_IP:3100
PAPERCLIP_PORT=3100
PAPERCLIP_DATA_DIR=../data/docker-paperclip
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=...
```

Generate the secret with:

```bash
openssl rand -hex 32
```

If you already have a real domain for this server, set:

```dotenv
PAPERCLIP_PUBLIC_URL=https://your-domain.example
```

instead of the IP-based URL.

## 6. Build and start Paperclip on the server

From the repo root on the server:

```bash
docker compose -f docker/docker-compose.quickstart.yml up -d --build
```

This uses the repo's quickstart deployment:

- Paperclip runs in Docker
- data is persisted under `data/docker-paperclip`
- the app is exposed on port `3100` by default

## 7. Check that it started correctly

```bash
docker compose -f docker/docker-compose.quickstart.yml ps
docker compose -f docker/docker-compose.quickstart.yml logs -f
```

Open this in your browser:

```text
http://YOUR_SERVER_IP:3100
```

Or, if you configured a domain:

```text
https://your-domain.example
```

## 8. Open the firewall if needed

If you use `ufw`, allow the Paperclip port:

```bash
sudo ufw allow 3100/tcp
sudo ufw status
```

If you are putting Paperclip behind Nginx or Apache with HTTPS, expose only `80` and `443` publicly and proxy to the Paperclip container port.

## 9. Update later after new pushes

Whenever you push new code to GitHub, update the server with:

```bash
cd ~/apps/paperclip-agentmail-openclaw
git pull origin main
docker compose -f docker/docker-compose.quickstart.yml up -d --build
```

## 10. If `git remote add origin ...` fails

In this repo, the correct command is:

```powershell
git remote set-url origin https://github.com/abdulrahman-kharzoum/paperclip-agentmail-openclaw.git
```

because `origin` already exists.

---

# Paperclip + AgentMail Setup (Windows + Linux)

This guide sets up AgentMail intake for a local Paperclip instance and exposes Paperclip through a Cloudflare quick tunnel when needed. The recommended inbound mode is now the server-side AgentMail websocket listener, which removes the public inbound webhook dependency entirely. It also documents the recommended stable public `wss://` path for a remote OpenClaw gateway using a cPanel-managed subdomain plus Apache reverse proxy.

## Prerequisites

- Paperclip repository is available locally.
- cloudflared is installed and available in PATH.
- You are using either:
	- Windows PowerShell 5.1 (Windows section commands)
	- Bash-compatible shell (Linux section commands)

## 1. Start Paperclip

### Windows (PowerShell)

```powershell
cd paperclip
pnpm install
pnpm dev
```

### Linux (Bash)

```bash
cd ~/Projects/paperclip
pnpm install
pnpm dev
```

Expected:

- API reachable at `http://localhost:3100`.

## 2. Generate webhook secret

### Windows (PowerShell 5.1)

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::Create()
$rng.GetBytes($bytes)
$secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$secret
```

### Linux (Bash)

```bash
secret="$(openssl rand -hex 32)"
echo "$secret"
```

Save the generated value.

## 3. Set env values (real runtime env file)

Edit your real runtime env file and set:

- Windows default path: `C:\Users\<you>\.paperclip\instances\default\.env`
- Linux default path: `~/.paperclip/instances/default/.env`

```dotenv
PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT=websocket
PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX=meetings@your-company.example
PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID=<paste_company_id_after_step_5>
PAPERCLIP_AGENTMAIL_API_KEY=am_live_replace_this
PAPERCLIP_AGENTMAIL_API_BASE_URL=https://api.agentmail.to/v1
PAPERCLIP_AGENTMAIL_SEND_PATH=/messages
```

Notes:

- Product owner email and tech team email are configured per company in Paperclip UI (Company Settings), not in env.
- `PAPERCLIP_AGENTMAIL_WEBHOOK_SECRET` is only needed for legacy webhook mode. Do not set it when using `PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT=websocket`.
- Do not put secrets in `.env.example`.

## 4. Restart Paperclip after env change

In the Paperclip terminal:

1. Stop with Ctrl+C.
2. Start again:

### Windows (PowerShell)

```powershell
pnpm dev
```

### Linux (Bash)

```bash
pnpm dev
```

## 5. Get company id

### Windows (PowerShell)

```powershell
Invoke-RestMethod http://localhost:3100/api/companies | Select-Object id,name
```

### Linux (Bash)

```bash
curl -s http://localhost:3100/api/companies
```

Copy the target company id and paste it into `PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID`.

## 6. Restart Paperclip after setting the company id

Restart once after `PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID` is filled in.

## 7. Check AgentMail inbound listener status

With websocket mode enabled, AgentMail no longer needs a public inbound webhook URL. Paperclip opens an outbound websocket to AgentMail on startup and listens for `message.received` events directly.

Check listener status:

### Windows (PowerShell)

```powershell
Invoke-RestMethod http://localhost:3100/api/companies/<YOUR_COMPANY_ID>/agentmail/status
```

### Linux (Bash)

```bash
curl -s http://localhost:3100/api/companies/<YOUR_COMPANY_ID>/agentmail/status
```

Expected in websocket mode:

- `transportMode = websocket`
- `enabled = true`
- `configuredInbox` matches your AgentMail inbox
- `configuredCompanyId` matches your Paperclip company id
- `connected = true`
- `subscribed = true`

### AgentMail workflow note

Inbound email no longer creates Product Owner or Tech Review approvals immediately.

The intended flow is now:

1. AgentMail email creates or updates a blocked issue.
2. Paperclip wakes the `cto` agent first for codebase-aware intake shaping.
3. The CTO must post a structured handoff comment using `<!-- paperclip:agentmail-cto-intake -->`.
4. Paperclip then assigns and wakes the PM or Product Analyzer for stakeholder clarification.
5. The PM or Product Analyzer posts `<!-- paperclip:agentmail-pm-review -->` to request Product Owner confirmation.
6. Only after Product Owner confirmation and Tech Review approval does implementation wake back up.

## 8. Start Cloudflared quick tunnel

Run in a separate terminal and keep it running:

### Windows (PowerShell)

```powershell
cloudflared tunnel --url http://localhost:3100
```
powershell -ExecutionPolicy Bypass -File .\scripts\agentmail-webhook-url.ps1 -CompanyId "1ec0b6dd-9e1d-4fd5-9b0d-37324447b928" -UpdateEnv


Invoke-RestMethod http://localhost:3100/api/companies/1ec0b6dd-9e1d-4fd5-9b0d-37324447b928/agentmail/status

### Linux (Bash)

```bash
cloudflared tunnel --url http://localhost:3100
```

### If URL is not obvious in terminal output

### Windows fallback command

```powershell
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:20241/metrics).Content |
	Select-String 'userHostname="https://[^"]+"' |
	ForEach-Object { $_.Matches[0].Value -replace 'userHostname="|"$','' }
```

### Linux fallback command

```bash
curl -s http://127.0.0.1:20241/metrics | grep -oE 'https://[^\"]+\.trycloudflare\.com' | head -n1
```

This prints the active `https://*.trycloudflare.com` URL.

## 9. Legacy only: Build the final webhook URL

Format:

```text
https://YOUR-TRYCLOUDFLARE-URL/api/companies/YOUR-COMPANY-ID/webhooks/agentmail
```

Example:

```text
https://example.trycloudflare.com/api/companies/123e4567-e89b-12d3-a456-426614174000/webhooks/agentmail
```

## 10. Legacy only: Configure AgentMail webhook

Skip this section when `PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT=websocket`.

In AgentMail webhook settings:

- Method: `POST`
- URL: webhook URL from step 7
- Header name: `x-agentmail-webhook-secret`
- Header value: secret from step 2

## 11. Configure Product Owner and Tech Team emails in UI

In Paperclip UI:

1. Open Company Settings.
2. Set Product owner email.
3. Set Tech team email.
4. Save changes.

## 12. Expose OpenClaw through `openclaw.<your-domain>` via cPanel + Apache

Use this path when OpenClaw runs on a Linux VPS that already serves your domain through cPanel/Apache. Do not use the cPanel Redirects page for this. A redirect changes the browser URL, but it does not proxy WebSocket traffic to the local OpenClaw gateway.

### cPanel domain setup

Create a dedicated subdomain such as:

```text
openclaw.zentraid.com
```

Rules:

- create it as a normal domain/subdomain in cPanel
- do not share the document root with the parent site
- do not add a cPanel redirect for this domain
- make sure the DNS `A` record for the subdomain points to the same VPS that runs OpenClaw

### Linux OpenClaw host

The OpenClaw gateway should stay bound locally on the Linux machine:

```bash
ss -ltnp | grep 18789
```

Expected:

- `127.0.0.1:18789` (or equivalent loopback listener)

Set OpenClaw to advertise the final public gateway URL:

```bash
openclaw config set gateway.bind "loopback"
openclaw config set gateway.remote.url "wss://openclaw.zentraid.com"
openclaw gateway restart
openclaw status
```

Do not expose `18789` directly in the firewall.

### Apache reverse proxy

On the VPS, add an Apache SSL userdata include for the subdomain and proxy it to the local OpenClaw gateway:

```bash
sudo mkdir -p /etc/apache2/conf.d/userdata/ssl/2_4/zentraid/openclaw.zentraid.com
```

Create:

```text
/etc/apache2/conf.d/userdata/ssl/2_4/zentraid/openclaw.zentraid.com/openclaw-proxy.conf
```

with:

```apache
ProxyPreserveHost On
ProxyRequests Off
SSLProxyEngine On

RequestHeader set X-Forwarded-Proto "https"
RequestHeader set X-Forwarded-Port "443"

RewriteEngine On
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteCond %{HTTP:Connection} upgrade [NC]
RewriteRule ^/(.*) ws://127.0.0.1:18789/$1 [P,L]

ProxyPass / http://127.0.0.1:18789/
ProxyPassReverse / http://127.0.0.1:18789/
```

Then rebuild and restart Apache:

```bash
sudo /scripts/ensure_vhost_includes --user=zentraid
sudo /scripts/rebuildhttpdconf
sudo systemctl restart httpd
```

The Apache host must have these modules available:

- `proxy`
- `proxy_http`
- `proxy_wstunnel`
- `rewrite`
- `headers`
- `ssl`

### SSL

Issue a valid certificate for the subdomain using AutoSSL or your existing Let's Encrypt integration. The target is:

```text
https://openclaw.zentraid.com
```

If cPanel exposes a “Force HTTPS Redirect” toggle for the subdomain, enable it only after SSL is working.

### Paperclip agent update

In the `EVA PM` agent configuration, only after the HTTPS endpoint responds successfully:

- keep `adapterType: openclaw_gateway`
- update `adapterConfig.url` to `wss://openclaw.zentraid.com/`
- keep `adapterConfig.headers["x-openclaw-token"]` unchanged
- keep the existing `devicePrivateKeyPem` unchanged so pairing identity stays stable
- keep `paperclipApiUrl` unchanged unless you intentionally move Paperclip itself

### Verification

On the VPS:

```bash
curl -vk http://127.0.0.1:18789/
curl -vk https://openclaw.zentraid.com/
openclaw qr --remote --json
```

On the Windows Paperclip machine:

```powershell
curl.exe -vk https://openclaw.zentraid.com/
```

If an older OpenClaw build rejects the richer Paperclip payload with `invalid agent params ... unexpected property 'paperclip'`, Paperclip now retries once automatically without the root `paperclip` field while keeping the same wake text/session/idempotency context.

## 11. Optional local webhook test

### Windows (PowerShell)

```powershell
$companyId = "<your-company-id>"
$secret = "<your-webhook-secret>"

$body = @{
	messageId = "test-msg-001"
	subject = "Meeting notes follow-up"
	from = @{ email = "meetings@your-company.example" }
	textBody = "- requirement one`n- requirement two"
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
	-Method Post `
	-Uri "http://localhost:3100/api/companies/$companyId/webhooks/agentmail" `
	-Headers @{ "x-agentmail-webhook-secret" = $secret } `
	-ContentType "application/json" `
	-Body $body
```

### Linux (Bash)

```bash
company_id="<your-company-id>"
secret="<your-webhook-secret>"

curl -X POST "http://localhost:3100/api/companies/$company_id/webhooks/agentmail" \
	-H "Content-Type: application/json" \
	-H "x-agentmail-webhook-secret: $secret" \
	-d '{
		"messageId": "test-msg-001",
		"subject": "Meeting notes follow-up",
		"from": { "email": "meetings@your-company.example" },
		"textBody": "- requirement one\n- requirement two"
	}'
```

Expected:

- Response contains `ok: true`.
- AgentMail delivery appears processed (or duplicate if same `messageId` reused).

## 12. One-command update when tunnel URL changes

Use the helper script to update auth env values and copy the latest AgentMail webhook URL to clipboard.

Get company id quickly first:

### Windows (PowerShell)

```powershell
Invoke-RestMethod http://localhost:3100/api/companies | Select-Object id,name
```

### Browser console (dashboard)

```javascript
fetch('/api/companies').then(r => r.json()).then(console.table)
```

### Windows (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agentmail-webhook-url.ps1 -CompanyId "<YOUR_COMPANY_ID>" -UpdateEnv

powershell -ExecutionPolicy Bypass -File .\scripts\agentmail-webhook-url.ps1 -CompanyId "1ec0b6dd-9e1d-4fd5-9b0d-37324447b928" -UpdateEnv
```

### Linux (PowerShell Core)

```bash
pwsh -ExecutionPolicy Bypass -File ./scripts/agentmail-webhook-url.ps1 -CompanyId "<YOUR_COMPANY_ID>" -UpdateEnv
```

What this command does:

- Reads current Cloudflare quick-tunnel URL from cloudflared metrics.
- Updates `~/.paperclip/instances/default/.env` auth origin settings.
- In websocket mode, copies the current public Paperclip URL to clipboard and prints the AgentMail listener status URL.
- In legacy webhook mode, builds the full AgentMail webhook URL for your company and copies it to clipboard.

After running it, restart Paperclip:

### Windows

```powershell
pnpm dev
```

### Linux

```bash
pnpm dev
```

## Troubleshooting

- `RandomNumberGenerator.Fill` not found:
	- You are on PowerShell 5.1. Use the `RNGCryptoServiceProvider` command from step 2.
- `openssl: command not found` on Linux:
	- Install OpenSSL (`sudo apt install openssl` on Debian/Ubuntu) or use another secure random generator.
- Cloudflared URL changes:
	- Quick tunnel URL changes on each restart. Re-run the helper so `PAPERCLIP_AUTH_PUBLIC_BASE_URL` and trusted origins stay current.
- AgentMail webhook route returns `410 Gone`:
	- Expected when `PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT=websocket`. Inbound mail is being handled by the server websocket listener instead.
- OpenClaw public WSS URL changes:
	- Quick tunnel URL changes on each restart. Update the OpenClaw agent `adapterConfig.url` every time.
- 401 from webhook:
	- Header name/value mismatch. Recheck `x-agentmail-webhook-secret`.
- 404 company not found:
	- Wrong company id in URL.

---

# Server `.env` And Config Based On Current Local Setup

Use this section when deploying the same current local AgentMail setup to a Linux server.

Your current local Paperclip instance has these important non-secret values:

```dotenv
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
HOST=0.0.0.0
PORT=3100

PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT=websocket
PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX=codex32@agentmail.to
PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID=1ec0b6dd-9e1d-4fd5-9b0d-37324447b928
PAPERCLIP_AGENTMAIL_API_BASE_URL=https://api.agentmail.to/v0
PAPERCLIP_AGENTMAIL_SEND_PATH=/messages
```

The values below must be copied from your local machine or generated fresh:

```dotenv
PAPERCLIP_AGENT_JWT_SECRET=<copy-existing-or-generate-new>
BETTER_AUTH_SECRET=<generate-new-with-openssl>
PAPERCLIP_AGENTMAIL_API_KEY=<copy-existing-AgentMail-key>
PAPERCLIP_AGENTMAIL_WEBHOOK_SECRET=<optional-legacy-only>
OPENAI_API_KEY=<optional>
ANTHROPIC_API_KEY=<optional>
```

## Server Env File Path

For the systemd deployment in this guide, use:

```text
/etc/paperclip/paperclip.env
```

For the normal Paperclip instance env file, use:

```text
/var/lib/paperclip/instances/default/.env
```

Recommended approach:

- Put the main systemd runtime env in `/etc/paperclip/paperclip.env`.
- Let the quick-tunnel script write the current public URL into `/var/lib/paperclip/instances/default/.env` if you want the Paperclip instance env file to mirror the current tunnel URL.
- Env vars exported by systemd and the start script override stale values in `config.json`.

## Exact Server Env Template

Create:

```bash
sudo mkdir -p /etc/paperclip
sudo nano /etc/paperclip/paperclip.env
```

Use this template:

```dotenv
NODE_ENV=production
SERVE_UI=true
HOST=0.0.0.0
PORT=3100

PAPERCLIP_HOME=/var/lib/paperclip
PAPERCLIP_INSTANCE_ID=default
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
PAPERCLIP_MIGRATION_AUTO_APPLY=true
PAPERCLIP_MIGRATION_PROMPT=never

# Auth. Generate or copy these securely.
BETTER_AUTH_SECRET=<replace-with-openssl-rand-hex-32>
PAPERCLIP_AGENT_JWT_SECRET=<copy-from-local-or-replace-with-openssl-rand-hex-32>

# These URL values are overwritten dynamically by the quick-tunnel start script.
# Keep localhost defaults here so first boot is still valid before cloudflared prints a URL.
PAPERCLIP_PUBLIC_URL=http://localhost:3100
PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=http://localhost:3100
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3100,http://127.0.0.1:3100
PAPERCLIP_ALLOWED_HOSTNAMES=localhost,127.0.0.1

# Match your current local sign-up behavior.
PAPERCLIP_AUTH_DISABLE_SIGN_UP=true

# AgentMail websocket intake. This avoids changing AgentMail webhooks every time
# the trycloudflare URL changes.
PAPERCLIP_AGENTMAIL_INBOUND_TRANSPORT=websocket
PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX=codex32@agentmail.to
PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID=1ec0b6dd-9e1d-4fd5-9b0d-37324447b928

# AgentMail API settings.
PAPERCLIP_AGENTMAIL_API_KEY=<copy-your-current-agentmail-api-key>
PAPERCLIP_AGENTMAIL_API_BASE_URL=https://api.agentmail.to/v0
PAPERCLIP_AGENTMAIL_SEND_PATH=/messages

# Legacy only. Safe to keep if you later switch to webhook mode.
PAPERCLIP_AGENTMAIL_WEBHOOK_SECRET=<copy-existing-or-generate-new>

# NotebookLM ingestion.
PAPERCLIP_NOTEBOOKLM_ENABLED=true
PAPERCLIP_NOTEBOOKLM_ATTACHMENT_MAX_BYTES=10485760
PAPERCLIP_NOTEBOOKLM_ALLOWED_MIME_TYPES=text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document

# Optional local agent keys.
OPENAI_API_KEY=<optional>
ANTHROPIC_API_KEY=<optional>
```

Important: your current company id is:

```text
1ec0b6dd-9e1d-4fd5-9b0d-37324447b928
```

If you import/create a different company on the server, replace `PAPERCLIP_AGENTMAIL_INBOUND_COMPANY_ID` with the new server company id.

Secure the env file:

```bash
sudo chown root:paperclip /etc/paperclip/paperclip.env
sudo chmod 640 /etc/paperclip/paperclip.env
```

Generate new secrets if needed:

```bash
openssl rand -hex 32
```

## Server `config.json`

For the systemd deployment, keep `config.json` static and let env vars handle the current quick-tunnel URL.

If you need to create a server config manually, use:

```json
{
  "$meta": {
    "version": 1,
    "source": "server-deploy"
  },
  "database": {
    "mode": "embedded-postgres",
    "embeddedPostgresDataDir": "/var/lib/paperclip/instances/default/db",
    "embeddedPostgresPort": 54329,
    "backup": {
      "enabled": true,
      "intervalMinutes": 60,
      "retentionDays": 30,
      "dir": "/var/lib/paperclip/instances/default/data/backups"
    }
  },
  "logging": {
    "mode": "file",
    "logDir": "/var/lib/paperclip/instances/default/logs"
  },
  "server": {
    "deploymentMode": "authenticated",
    "exposure": "public",
    "host": "0.0.0.0",
    "port": 3100,
    "allowedHostnames": ["localhost", "127.0.0.1"],
    "serveUi": true
  },
  "telemetry": {
    "enabled": true
  },
  "auth": {
    "baseUrlMode": "explicit",
    "publicBaseUrl": "http://localhost:3100",
    "disableSignUp": true
  },
  "storage": {
    "provider": "local_disk",
    "localDisk": {
      "baseDir": "/var/lib/paperclip/instances/default/data/storage"
    }
  },
  "secrets": {
    "provider": "local_encrypted",
    "strictMode": false,
    "localEncrypted": {
      "keyFilePath": "/var/lib/paperclip/instances/default/secrets/master.key"
    }
  }
}
```

Create it only if Paperclip has not already created one:

```bash
sudo -u paperclip mkdir -p /var/lib/paperclip/instances/default
sudo -u paperclip nano /var/lib/paperclip/instances/default/config.json
```

Do not put the temporary `trycloudflare.com` URL permanently in `config.json`. The quick-tunnel start script should export the current URL at each boot.

## Use `scripts/agentmail-webhook-url.ps1` With The Current Company ID

The helper script reads the active Cloudflare quick-tunnel URL from the local cloudflared metrics endpoint:

```text
http://127.0.0.1:20241/metrics
```

It then updates env auth URL values:

```dotenv
PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=<current-trycloudflare-url>
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3100,http://127.0.0.1:3100,<current-trycloudflare-url>
```

With your current websocket AgentMail mode, it prints the AgentMail status URL and does not require an AgentMail webhook URL.

### Windows Local Command

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agentmail-webhook-url.ps1 `
  -CompanyId "1ec0b6dd-9e1d-4fd5-9b0d-37324447b928" `
  -UpdateEnv `
  -EnvFile "$HOME\.paperclip\instances\default\.env"
```

### Linux Server Command With PowerShell Core

Install PowerShell Core if you want to reuse the same script on the Linux server:

```bash
sudo apt update
sudo apt install -y wget apt-transport-https software-properties-common
wget -q https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
sudo apt update
sudo apt install -y powershell
```

Then run:

```bash
cd /opt/paperclip/app
pwsh -ExecutionPolicy Bypass -File ./scripts/agentmail-webhook-url.ps1 \
  -CompanyId "1ec0b6dd-9e1d-4fd5-9b0d-37324447b928" \
  -UpdateEnv \
  -EnvFile "/var/lib/paperclip/instances/default/.env"
```

The script updates the instance `.env`. If you are running through systemd with `/etc/paperclip/paperclip.env`, the start wrapper still needs to export the active URL before launching Paperclip.

## Update The Quick-Tunnel Start Script To Also Write Instance `.env`

In `/opt/paperclip/run-with-quick-tunnel.sh`, after this line:

```bash
echo "$URL" > "$URL_FILE"
```

add:

```bash
INSTANCE_ENV="/var/lib/paperclip/instances/default/.env"
mkdir -p "$(dirname "$INSTANCE_ENV")"
touch "$INSTANCE_ENV"

set_env_line() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" "$INSTANCE_ENV"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$INSTANCE_ENV"
  else
    printf "%s=%s\n" "$key" "$value" >> "$INSTANCE_ENV"
  fi
}

set_env_line "PAPERCLIP_AUTH_BASE_URL_MODE" "explicit"
set_env_line "PAPERCLIP_AUTH_PUBLIC_BASE_URL" "$URL"
set_env_line "PAPERCLIP_PUBLIC_URL" "$URL"
set_env_line "BETTER_AUTH_TRUSTED_ORIGINS" "http://localhost:3100,http://127.0.0.1:3100,$URL"
set_env_line "PAPERCLIP_ALLOWED_HOSTNAMES" "localhost,127.0.0.1,${URL#https://}"
```

The same script should still export these values before starting Paperclip:

```bash
export PAPERCLIP_PUBLIC_URL="$URL"
export PAPERCLIP_AUTH_BASE_URL_MODE=explicit
export PAPERCLIP_AUTH_PUBLIC_BASE_URL="$URL"
export BETTER_AUTH_TRUSTED_ORIGINS="http://localhost:3100,http://127.0.0.1:3100,$URL"
export PAPERCLIP_ALLOWED_HOSTNAMES="localhost,127.0.0.1,${URL#https://}"
```

This gives you both:

- current runtime env for the running server
- persisted instance `.env` showing the latest quick-tunnel URL

## Verify Server Env After Start

```bash
sudo systemctl restart paperclip
sudo journalctl -u paperclip -f
```

Current URL:

```bash
sudo cat /var/lib/paperclip/current-trycloudflare-url.txt
```

AgentMail listener:

```bash
curl http://127.0.0.1:3100/api/companies/1ec0b6dd-9e1d-4fd5-9b0d-37324447b928/agentmail/status
```

NotebookLM:

```bash
sudo -u paperclip -H bash -lc '
export PATH="$HOME/.local/bin:$PATH"
nlm login --check
'
```

If the company id changes on the server, update every command and env value that contains:

```text
1ec0b6dd-9e1d-4fd5-9b0d-37324447b928
```

## Quick Command: Run `scripts/agentmail-webhook-url.ps1`

Use this helper after `cloudflared tunnel --url http://localhost:3100` is running.

The helper reads the current `trycloudflare.com` URL from:

```text
http://127.0.0.1:20241/metrics
```

Then it updates Paperclip auth URL env values for the current tunnel.

Because your current AgentMail inbound mode is `websocket`, the helper does not create or register an AgentMail webhook. It prints the Paperclip public URL and the AgentMail listener status URL instead.

### Windows

Terminal 1:

```powershell
cloudflared tunnel --url http://localhost:3100
```

Keep Terminal 1 open.

Terminal 2, from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agentmail-webhook-url.ps1 `
  -CompanyId "1ec0b6dd-9e1d-4fd5-9b0d-37324447b928" `
  -UpdateEnv
```

By default, this updates:

```text
C:\Users\<you>\.paperclip\instances\default\.env
```

To specify the env file explicitly:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agentmail-webhook-url.ps1 `
  -CompanyId "1ec0b6dd-9e1d-4fd5-9b0d-37324447b928" `
  -UpdateEnv `
  -EnvFile "$HOME\.paperclip\instances\default\.env"
```

Then restart Paperclip:

```powershell
pnpm dev
```

### Linux

Install PowerShell Core once:

```bash
sudo apt update
sudo apt install -y wget apt-transport-https software-properties-common
wget -q https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
sudo apt update
sudo apt install -y powershell
```

Terminal 1:

```bash
cloudflared tunnel --url http://localhost:3100
```

Keep Terminal 1 open.

Terminal 2, from the repo root:

```bash
pwsh -ExecutionPolicy Bypass -File ./scripts/agentmail-webhook-url.ps1 \
  -CompanyId "1ec0b6dd-9e1d-4fd5-9b0d-37324447b928" \
  -UpdateEnv \
  -EnvFile "$HOME/.paperclip/instances/default/.env"
```

For the systemd server deployment from this guide:

```bash
cd /opt/paperclip/app
pwsh -ExecutionPolicy Bypass -File ./scripts/agentmail-webhook-url.ps1 \
  -CompanyId "1ec0b6dd-9e1d-4fd5-9b0d-37324447b928" \
  -UpdateEnv \
  -EnvFile "/var/lib/paperclip/instances/default/.env"
```

Then restart Paperclip:

```bash
sudo systemctl restart paperclip
```

Check AgentMail listener status:

```bash
curl http://127.0.0.1:3100/api/companies/1ec0b6dd-9e1d-4fd5-9b0d-37324447b928/agentmail/status
```
