export function mergeBrowserRuntimeEvidence(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined
  const selected = new Map()
  for (const report of candidates) {
    for (const result of report.results ?? []) {
      if (typeof result?.sceneType !== "string") continue
      const candidate = {
        ...result,
        evidenceSource: {
          path: report.path ?? null,
          generatedAt: report.generatedAt ?? null,
          targetLabel: report.environment?.targetLabel ?? null
        }
      }
      const current = selected.get(result.sceneType)
      if (!current || preferredBrowserResult(candidate, current, options.targetLabel)) selected.set(result.sceneType, candidate)
    }
  }
  if (selected.size === 0) return undefined
  const results = [...selected.values()]
  const sources = Object.fromEntries(results.map((result) => [result.sceneType, result.evidenceSource]))
  return {
    format: "wurenji-browser-runtime-baseline",
    formatVersion: 1,
    generatedAt: latestTimestamp(results.map((result) => result.evidenceSource?.generatedAt)),
    environment: options.targetLabel ? { targetLabel: options.targetLabel } : {},
    results,
    sources,
    path: [...new Set(results.map((result) => result.evidenceSource?.path).filter(Boolean))].join(", ") || null
  }
}

export function browserEvidenceSource(value, sceneType) {
  return value?.results?.find((item) => item.sceneType === sceneType)?.evidenceSource ?? null
}

export function browserEvidencePath(value, sceneType) {
  return browserEvidenceSource(value, sceneType)?.path ?? value?.path ?? null
}

function preferredBrowserResult(candidate, current, targetLabel) {
  if (targetLabel) {
    const candidateMatches = candidate.evidenceSource?.targetLabel === targetLabel
    const currentMatches = current.evidenceSource?.targetLabel === targetLabel
    if (candidateMatches !== currentMatches) return candidateMatches
  }
  return evidenceTime(candidate.evidenceSource) > evidenceTime(current.evidenceSource)
}

function latestTimestamp(values) {
  const latest = values.map((value) => Date.parse(value ?? "")).filter(Number.isFinite).sort((left, right) => right - left)[0]
  return latest === undefined ? null : new Date(latest).toISOString()
}

function evidenceTime(value) {
  const parsed = Date.parse(value?.generatedAt ?? "")
  return Number.isFinite(parsed) ? parsed : 0
}
