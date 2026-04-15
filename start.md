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
