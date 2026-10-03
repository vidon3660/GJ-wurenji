export type OverlayEditorHistory<T> = {
  past: T[]
  present: T
  future: T[]
}

export function createOverlayEditorHistory<T>(initial: T): OverlayEditorHistory<T> {
  return { past: [], present: initial, future: [] }
}

/** Record a new immutable editor snapshot and invalidate redo states. */
export function commitOverlayEditorHistory<T>(history: OverlayEditorHistory<T>, next: T): OverlayEditorHistory<T> {
  return { past: [...history.past, history.present], present: next, future: [] }
}

export function undoOverlayEditorHistory<T>(history: OverlayEditorHistory<T>): OverlayEditorHistory<T> {
  const previous = history.past.at(-1)
  if (previous === undefined) return history
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future]
  }
}

export function redoOverlayEditorHistory<T>(history: OverlayEditorHistory<T>): OverlayEditorHistory<T> {
  const next = history.future[0]
  if (next === undefined) return history
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1)
  }
}
