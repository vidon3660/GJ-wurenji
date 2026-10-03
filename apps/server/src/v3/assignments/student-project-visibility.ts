export interface StudentProjectClassification {
  snapshot: {
    isDemo: boolean
    isAcceptanceData: boolean
  }
}

export function filterVisibleStudentProjects<T extends StudentProjectClassification>(projects: T[], includeInternalData = false): T[] {
  return includeInternalData ? projects : projects.filter((project) => !project.snapshot.isDemo && !project.snapshot.isAcceptanceData)
}
