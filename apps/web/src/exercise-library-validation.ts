export function validateExerciseTemplateDraft(draft: { title: string; summary: string; taskBrief: string }): string | null {
  return draft.title.trim() && draft.summary.trim() && draft.taskBrief.trim()
    ? null
    : "请填写模板名称、摘要和学生任务说明"
}
