/** Includes older object-store assets after a deployment switches to LOCAL storage. */
export function requiresObjectStorage(manifest) {
  if (manifest.storage?.provider && manifest.storage.provider !== "LOCAL") return true
  if (manifest.artifacts?.some((artifact) => artifact.kind === "V3_FILE" && artifact.storageProvider !== "LOCAL")) return true
  return manifest.fileAssets?.some((asset) => asset.status !== "DELETED" && asset.storageProvider !== "LOCAL") ?? false
}
