/** A completed morph must release its camera snapshot before the next switch. */
export function listenForMapMorphComplete(
  event: { addEventListener: (callback: () => void) => () => void },
  callback: () => void
): () => void {
  let remove: (() => void) | undefined
  const cancel = () => {
    remove?.()
    remove = undefined
  }
  remove = event.addEventListener(() => {
    cancel()
    callback()
  })
  return cancel
}
