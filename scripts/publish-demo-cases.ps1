$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3000'
$origin = 'http://localhost:5173'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$headers = @{ Origin = $origin; Referer = "$origin/" }

function Invoke-Api([string]$method, [string]$path, $body) {
  $params = @{ Uri = "$base$path"; Method = $method; WebSession = $session; Headers = $headers; ContentType = 'application/json' }
  if ($null -ne $body) { $params.Body = ($body | ConvertTo-Json -Depth 20 -Compress) }
  $response = Invoke-WebRequest @params
  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw "$method $path failed: $($response.StatusCode) $($response.Content)" }
  if ([string]::IsNullOrWhiteSpace($response.Content)) { return $null }
  return $response.Content | ConvertFrom-Json
}

Invoke-Api 'POST' '/api/auth/login' @{ email = 'teacher@demo.local'; password = $env:DEMO_TEACHER_PASSWORD } | Out-Null
$packages = Invoke-Api 'GET' '/api/v3/resource-packages' $null
$classes = Invoke-Api 'GET' '/api/v1/education/classes' $null
$questionBanks = Invoke-Api 'GET' '/api/v1/education/question-banks?sceneType=VTOL_INSPECTION' $null
$logisticsQuestionBanks = Invoke-Api 'GET' '/api/v1/education/question-banks?sceneType=CITY_LOGISTICS' $null
$class = @($classes | Where-Object { $_.code -eq 'LOW-2401' })[0]
if (-not $class) { throw '找不到 LOW-2401 演示班级' }

function Package([string]$type, [string]$scene, [string]$regionCode) {
  $matches = @($packages | Where-Object {
    $_.packageType -eq $type -and $_.status -eq 'ACTIVE' -and
      (($type -ne 'REGION') -or $_.manifest.regionCode -eq $regionCode) -and
      (($type -notin @('EVENT','SCALE_TEMPLATE','DOCUMENT_TEMPLATE')) -or $_.manifest.sceneType -eq $scene)
  })
  if ($matches.Count -eq 0) { throw "找不到资源 $type / $scene / $regionCode" }
  return $matches[0]
}

$now = [DateTime]::UtcNow
$available = $now.AddMinutes(-5).ToString('o')
$due = $now.AddDays(30).ToString('o')
$cases = @(
  @{ title = 'Shanghai Bund Formation Training v2026.10.02'; scene = 'CITY_SHOW'; region = 'SH-BUND-SHOW-01'; scale = 'SHOW_100'; brief = 'Plan a waterfront formation, flight choreography and multi-aircraft safety checks.' },
  @{ title = 'Guangzhou North Low-altitude Logistics Training v2026.10.02'; scene = 'CITY_LOGISTICS'; region = 'GZ-NORTH-LOGISTICS-01'; scale = 'LOGISTICS_3'; brief = 'Select delivery points, plan routes, validate routes and dispatch orders.' },
  @{ title = 'Guizhou Mountain VTOL Inspection Training v2026.10.02'; scene = 'VTOL_INSPECTION'; region = 'GZ-MOUNTAIN-VTOL-01'; scale = 'VTL_1'; brief = 'Divide inspection objects, plan VTOL routes, check terrain clearance and diversion.' }
)

foreach ($item in $cases) {
  $region = Package 'REGION' $item.scene $item.region
  $scale = Package 'SCALE_TEMPLATE' $item.scene ''
  $event = Package 'EVENT' $item.scene ''
  $rule = Package 'RULE' '' ''
  $aircraft = Package 'AIRCRAFT' '' ''
  $report = Package 'REPORT' '' ''
  $resourceIds = @($region.id, $scale.id, $rule.id, $aircraft.id, $report.id)
  $resourceIds += $event.id
  if ($item.scene -eq 'CITY_SHOW') { $doc = Package 'DOCUMENT_TEMPLATE' $item.scene ''; $resourceIds += $doc.id }
  $config = @{
    scaleTemplateCode = $item.scale
    regionPackageId = $region.id
    availableAt = $available
    dueAt = $due
    taskBrief = $item.brief
    allowResubmission = $true
    allowedValidationAttempts = 3
    allowedRuntimeAttempts = 2
    resultVisibility = 'FULL_REVIEW'
  }
  if ($item.scene -eq 'CITY_SHOW') { $config.scenario = @{ eventCodes = @('WEATHER_LIMIT') } }
  if ($item.scene -eq 'CITY_LOGISTICS') {
    $candidateIds = @($region.manifest.logisticsNodes | Where-Object { $_.type -eq 'DELIVERY_POINT' -and $_.enabled } | Select-Object -First 1 | ForEach-Object { $_.id })
    $config.scenario = @{ orderCount = 3; orderReleaseMode = 'BATCH'; candidateDeliveryPointIds = $candidateIds; timeWindowMinutes = 30 }
  }
  if ($item.scene -eq 'VTOL_INSPECTION') {
    $bank = @($questionBanks | Where-Object { $_.sceneType -eq 'VTOL_INSPECTION' -and $_.publishedVersionId })[0]
    $mainLanding = @($region.manifest.vtlLandingSites | Where-Object { $_.type -eq 'MAIN' })[0]
    $config.questionBankVersionId = $bank.publishedVersionId
    $boundaryPoints = @($region.manifest.boundary | Select-Object -First 4)
    $minLon = ($boundaryPoints | Measure-Object -Property longitude -Minimum).Minimum
    $maxLon = ($boundaryPoints | Measure-Object -Property longitude -Maximum).Maximum
    $minLat = ($boundaryPoints | Measure-Object -Property latitude -Minimum).Minimum
    $maxLat = ($boundaryPoints | Measure-Object -Property latitude -Maximum).Maximum
    $taskBoundary = @(
      @{ longitude = $minLon + 0.001; latitude = $minLat + 0.001 },
      @{ longitude = $maxLon - 0.001; latitude = $minLat + 0.001 },
      @{ longitude = $maxLon - 0.001; latitude = $maxLat - 0.001 },
      @{ longitude = $minLon + 0.001; latitude = $maxLat - 0.001 }
    )
    $config.vtlParameters = @{ projectBackground = $item.brief; completionRequirements = 'Complete inspection planning and route checks.'; mainLandingSiteId = $mainLanding.id; aircraftModelCode = 'VTOL-TEACHING-01'; aircraftParameterVersion = '1.0.0'; taskAreaBoundary = $taskBoundary }
    $config.scenario = @{ simulationClockRate = 3600; vtlRuntimeClockRate = 3600 }
  }
  if ($item.scene -eq 'CITY_SHOW') {
    $config.showParameters = @{ projectBackground = $item.brief; completionRequirements = 'Complete the formation route and safety checks.'; plannedStartAt = $available; plannedEndAt = $due; plannedAudienceCount = 100; maximumHeightMeters = 120; contactName = 'Demo Teacher'; contactPhone = '13800000000'; aircraftModel = 'Teaching Formation UAV' }
  }
  $existing = @((Invoke-Api 'GET' '/api/v3/assignments/drafts' $null) | Where-Object { $_.title -eq $item.title })[0]
  if ($existing -and $existing.status -eq 'PUBLISHED') { Write-Output "$($item.title): already published"; continue }
  if ($existing -and $existing.status -eq 'DRAFT') { Invoke-Api 'DELETE' "/api/v3/assignments/drafts/$($existing.id)" $null | Out-Null; $existing = $null }
  $draft = if ($existing) { $existing } else { Invoke-Api 'POST' '/api/v3/assignments/drafts' @{ title = $item.title; sceneType = $item.scene; mode = 'TRAINING'; isDemo = $false; isAcceptanceData = $false; config = $config } }
  $target = @(@{ type = 'CLASS'; targetId = $class.id })
  Write-Output "Preparing $($item.title) draft=$($draft.id) revision=$($draft.revision)"
  $preview = Invoke-Api 'POST' "/api/v3/assignments/drafts/$($draft.id)/preview" @{ expectedRevision = $draft.revision; targets = $target; resourcePackageIds = $resourceIds }
  Write-Output "Preview complete $($item.title)"
  $check = Invoke-Api 'POST' "/api/v3/assignments/drafts/$($draft.id)/preflight" @{ expectedRevision = $draft.revision; targets = $target; resourcePackageIds = $resourceIds }
  $published = Invoke-Api 'POST' "/api/v3/assignments/drafts/$($draft.id)/publish" @{ expectedRevision = $draft.revision; configHash = $preview.configHash; targets = $target; resourcePackageIds = $resourceIds; preflightConfirmation = @{ checkedAt = $check.checkedAt; checkCodes = @($check.checks | Where-Object { $_.level -eq 'WARNING' } | ForEach-Object { $_.code }) } }
  Write-Output "$($item.title): published, projects=$($published.projectCount)"
}
