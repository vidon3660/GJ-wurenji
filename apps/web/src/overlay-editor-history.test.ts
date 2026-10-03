import { describe, expect, it } from "vitest"
import { commitOverlayEditorHistory, createOverlayEditorHistory, redoOverlayEditorHistory, undoOverlayEditorHistory } from "./overlay-editor-history"

describe("overlay editor history", () => {
  it("supports undo and redo in order", () => {
    let history = createOverlayEditorHistory({ objects: [] as string[] })
    history = commitOverlayEditorHistory(history, { objects: ["point"] })
    history = commitOverlayEditorHistory(history, { objects: ["point", "area"] })

    history = undoOverlayEditorHistory(history)
    expect(history.present.objects).toEqual(["point"])
    history = undoOverlayEditorHistory(history)
    expect(history.present.objects).toEqual([])
    history = redoOverlayEditorHistory(history)
    expect(history.present.objects).toEqual(["point"])
    history = redoOverlayEditorHistory(history)
    expect(history.present.objects).toEqual(["point", "area"])
  })

  it("clears redo states after a new edit", () => {
    let history = createOverlayEditorHistory(0)
    history = commitOverlayEditorHistory(history, 1)
    history = commitOverlayEditorHistory(history, 2)
    history = undoOverlayEditorHistory(history)
    history = commitOverlayEditorHistory(history, 3)
    expect(redoOverlayEditorHistory(history).present).toBe(3)
  })
})
