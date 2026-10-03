export function normalizeVtlStageSelection<T extends string>(selected: readonly T[], ordered: readonly T[]) {
  const firstMissingIndex = ordered.findIndex((code) => !selected.includes(code))
  return [...ordered.slice(0, firstMissingIndex < 0 ? ordered.length : firstMissingIndex)]
}
