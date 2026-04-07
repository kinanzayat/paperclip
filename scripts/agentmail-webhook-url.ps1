param(
  [Parameter(Mandatory = $false)]
  [string]$CompanyId,

  [Parameter(Mandatory = $false)]
  [string]$CompanyName,

  [Parameter(Mandatory = $false)]
  [string]$ApiBase = "http://localhost:3100",

  [Parameter(Mandatory = $false)]
  [string]$MetricsUrl = "http://127.0.0.1:20241/metrics",

  [Parameter(Mandatory = $false)]
  [switch]$UpdateEnv,

  [Parameter(Mandatory = $false)]
  [string]$EnvFile = "$HOME\\.paperclip\\instances\\default\\.env"
)

$ErrorActionPreference = "Stop"

function Get-TunnelUrl {
  param([string]$Url)

  $content = (Invoke-WebRequest -UseBasicParsing $Url).Content
  $match = [regex]::Match($content, 'userHostname="(https://[^"]+\.trycloudflare\.com)"')
  if (-not $match.Success) {
    throw "No Cloudflare quick tunnel URL found. Make sure cloudflared is running."
  }
  return $match.Groups[1].Value
}

function Get-Company {
  param(
    [string]$Base,
    [string]$Name
  )

  $companies = Invoke-RestMethod "$Base/api/companies"
  if (-not $companies) {
    throw "No companies returned from $Base/api/companies"
  }

  if ($Name -and $Name.Trim().Length -gt 0) {
    $company = $companies | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $company) {
      $available = ($companies | ForEach-Object { $_.name }) -join ", "
      throw "Company '$Name' not found. Available: $available"
    }
    return $company
  }

  if ($companies.Count -eq 1) {
    return $companies[0]
  }

  Write-Host "Multiple companies found. Select one:"
  for ($i = 0; $i -lt $companies.Count; $i++) {
    Write-Host ("[{0}] {1} ({2})" -f ($i + 1), $companies[$i].name, $companies[$i].id)
  }

  $selection = Read-Host "Enter number"
  $parsedSelection = 0
  if (-not [int]::TryParse($selection, [ref]$parsedSelection)) {
    throw "Invalid selection: $selection"
  }

  $index = $parsedSelection - 1
  if ($index -lt 0 -or $index -ge $companies.Count) {
    throw "Selection out of range: $selection"
  }

  return $companies[$index]
}

function Set-Or-AppendEnvLine {
  param(
    [string[]]$Lines,
    [string]$Key,
    [string]$Value
  )

  $pattern = "^" + [regex]::Escape($Key) + "="
  $replacement = "$Key=$Value"
  $index = -1

  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -match $pattern) {
      $index = $i
      break
    }
  }

  if ($index -ge 0) {
    $Lines[$index] = $replacement
  } else {
    $Lines += $replacement
  }

  return ,$Lines
}

function Update-InstanceEnv {
  param(
    [string]$FilePath,
    [string]$TunnelUrl
  )

  if (-not (Test-Path $FilePath)) {
    throw "Env file not found: $FilePath"
  }

  $content = Get-Content -Path $FilePath
  if (-not $content) { $content = @() }

  $originList = @(
    "http://localhost:3100",
    "http://127.0.0.1:3100",
    $TunnelUrl
  ) -join ","

  $content = Set-Or-AppendEnvLine -Lines $content -Key "PAPERCLIP_AUTH_BASE_URL_MODE" -Value "explicit"
  $content = Set-Or-AppendEnvLine -Lines $content -Key "PAPERCLIP_AUTH_PUBLIC_BASE_URL" -Value $TunnelUrl
  $content = Set-Or-AppendEnvLine -Lines $content -Key "BETTER_AUTH_TRUSTED_ORIGINS" -Value $originList

  Set-Content -Path $FilePath -Value $content -Encoding UTF8
}

$tunnelUrl = Get-TunnelUrl -Url $MetricsUrl

if ($CompanyId -and $CompanyId.Trim().Length -gt 0) {
  $selectedCompanyId = $CompanyId.Trim()
  $selectedCompanyName = if ($CompanyName) { $CompanyName } else { "(provided by id)" }
} else {
  $company = Get-Company -Base $ApiBase -Name $CompanyName
  $selectedCompanyId = $company.id
  $selectedCompanyName = $company.name
}

$webhookUrl = "$tunnelUrl/api/companies/$selectedCompanyId/webhooks/agentmail"

if ($UpdateEnv) {
  Update-InstanceEnv -FilePath $EnvFile -TunnelUrl $tunnelUrl
}

$webhookUrl | Set-Clipboard

Write-Host "Tunnel URL: $tunnelUrl"
Write-Host "Company: $selectedCompanyName ($selectedCompanyId)"
if ($UpdateEnv) {
  Write-Host "Updated env file: $EnvFile"
}
Write-Host "AgentMail webhook URL copied to clipboard:"
Write-Host $webhookUrl
