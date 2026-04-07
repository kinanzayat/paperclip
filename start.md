# Paperclip + Cloudflared + AgentMail Setup (Windows + Linux)

This guide sets up AgentMail webhook intake for a local Paperclip instance and exposes it through a Cloudflare quick tunnel.

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
PAPERCLIP_AGENTMAIL_WEBHOOK_SECRET=<paste_generated_secret_here>
PAPERCLIP_AGENTMAIL_INBOUND_MAILBOX=meetings@your-company.example
PAPERCLIP_AGENTMAIL_API_KEY=am_live_replace_this
PAPERCLIP_AGENTMAIL_API_BASE_URL=https://api.agentmail.to/v1
PAPERCLIP_AGENTMAIL_SEND_PATH=/messages
```

Notes:

- Product analyzer email is now configured per company in Paperclip UI (Company Settings), not in env.
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

Copy the target company id.

## 6. Start Cloudflared quick tunnel

Run in a separate terminal and keep it running:

### Windows (PowerShell)

```powershell
cloudflared tunnel --url http://localhost:3100
```

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

## 7. Build the final webhook URL

Format:

```text
https://YOUR-TRYCLOUDFLARE-URL/api/companies/YOUR-COMPANY-ID/webhooks/agentmail
```

Example:

```text
https://example.trycloudflare.com/api/companies/123e4567-e89b-12d3-a456-426614174000/webhooks/agentmail
```

## 8. Configure AgentMail webhook

In AgentMail webhook settings:

- Method: `POST`
- URL: webhook URL from step 7
- Header name: `x-agentmail-webhook-secret`
- Header value: secret from step 2

## 9. Configure Product Analyzer email in UI

In Paperclip UI:

1. Open Company Settings.
2. Set Product analyzer email.
3. Save changes.

## 10. Optional local webhook test

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

## 11. One-command update when tunnel URL changes

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
```

### Linux (PowerShell Core)

```bash
pwsh -ExecutionPolicy Bypass -File ./scripts/agentmail-webhook-url.ps1 -CompanyId "<YOUR_COMPANY_ID>" -UpdateEnv
```

What this command does:

- Reads current Cloudflare quick-tunnel URL from cloudflared metrics.
- Updates `~/.paperclip/instances/default/.env` auth origin settings.
- Builds the full AgentMail webhook URL for your company.
- Copies webhook URL to clipboard.

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
	- Quick tunnel URL changes on each restart. Update AgentMail webhook URL every time.
- 401 from webhook:
	- Header name/value mismatch. Recheck `x-agentmail-webhook-secret`.
- 404 company not found:
	- Wrong company id in URL.