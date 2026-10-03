import { describe, expect, it } from "vitest"
import type { QuestionDefinition, ShowObjectiveMetricView } from "@wurenji/shared"
import { gradeQuestion, normalizeQuestionDefinitions } from "./question-bank.validation.js"

describe("question bank validation and grading", () => {
  it("treats an omitted or empty explanation as optional", () => {
    const [result] = normalizeQuestionDefinitions([{
      code: "OPTIONAL-EXPLANATION",
      type: "SINGLE_CHOICE",
      difficulty: "BEGINNER",
      prompt: "解析可以为空吗？",
      options: [{ key: "A", label: "可以" }, { key: "B", label: "不可以" }],
      correctAnswer: "A",
      explanation: ""
    }])

    expect(result.explanation).toBe("")
  })

  it("normalizes questions and applies order-independent multiple choice grading", () => {
    const questions = normalizeQuestionDefinitions([{
      code: "safety-01",
      type: "MULTIPLE_CHOICE",
      prompt: "选择安全措施",
      options: [{ key: "A", label: "暂停" }, { key: "B", label: "复核" }],
      correctAnswer: ["A", "B"],
      maxScore: 8,
      sortOrder: 1
    }])
    expect(questions[0]?.code).toBe("SAFETY-01")
    expect(questions[0]).toMatchObject({ difficulty: "BEGINNER", knowledgePoints: [] })
    expect(gradeQuestion(questions[0]!, ["B", "A"], [])).toMatchObject({ autoScore: 8, judgment: "CORRECT" })
  })

  it("gives partial credit when required planning fields are incomplete", () => {
    const question = normalizeQuestionDefinitions([{
      code: "PLAN-01",
      type: "PLANNING",
      prompt: "填写规划",
      correctAnswer: null,
      gradingRule: { kind: "REQUIRED_FIELDS", fields: ["route", "safety", "reasoning"] },
      maxScore: 30,
      sortOrder: 1
    }])[0]!
    expect(gradeQuestion(question, { route: "A", safety: "B" }, [])).toMatchObject({ autoScore: 20, judgment: "PARTIAL" })
  })

  it("waits for an authoritative metric and passes after it exists", () => {
    const question = normalizeQuestionDefinitions([{
      code: "EVIDENCE-01",
      type: "SIMULATION_EVIDENCE",
      prompt: "准时率达到 90%",
      correctAnswer: null,
      gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "ON_TIME_DELIVERY", operator: "GTE", threshold: 90 },
      maxScore: 20,
      sortOrder: 1
    }])[0]!
    expect(gradeQuestion(question, null, [])).toMatchObject({ autoScore: null, judgment: "PENDING" })
    const metrics: ShowObjectiveMetricView[] = [{ code: "ON_TIME_DELIVERY", label: "准时到达率", value: 92, displayValue: "92%", unit: "%", state: "PASS", detail: "" }]
    expect(gradeQuestion(question, null, metrics)).toMatchObject({ autoScore: 20, judgment: "CORRECT" })
  })

  it("rejects duplicate codes and an incompatible metric rule", () => {
    expect(() => normalizeQuestionDefinitions([
      { code: "DUP", type: "TRUE_FALSE", prompt: "A", correctAnswer: true },
      { code: "dup", type: "TRUE_FALSE", prompt: "B", correctAnswer: false }
    ])).toThrow("题目编号重复")
    expect(() => normalizeQuestionDefinitions([{
      code: "BAD",
      type: "PLANNING",
      prompt: "A",
      correctAnswer: null,
      gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "X", operator: "GTE", threshold: 1 }
    }])).toThrow("仅适用于仿真证据题")
  })

  it("rejects question definitions that cannot be graded", () => {
    expect(() => normalizeQuestionDefinitions([{
      code: "PLAN-EXACT-NULL",
      type: "PLANNING",
      prompt: "填写规划",
      correctAnswer: null,
      gradingRule: { kind: "EXACT" }
    }])).toThrow("必须配置必填字段规则或结构化正确答案")
    expect(() => normalizeQuestionDefinitions([{
      code: "EVIDENCE-EXACT",
      type: "SIMULATION_EVIDENCE",
      prompt: "检查仿真指标",
      correctAnswer: null,
      gradingRule: { kind: "EXACT" }
    }])).toThrow("仿真证据题必须配置指标阈值规则")
  })

  it("does not disclose the answer through the student-facing shape", () => {
    const question: QuestionDefinition = {
      code: "A",
      type: "TRUE_FALSE",
      difficulty: "INTERMEDIATE",
      knowledgePoints: ["飞行安全"],
      prompt: "A",
      options: [{ key: "TRUE", label: "正确" }, { key: "FALSE", label: "错误" }],
      correctAnswer: true,
      explanation: "hidden",
      maxScore: 1,
      stageCode: null,
      gradingRule: { kind: "EXACT" },
      sortOrder: 1
    }
    expect(gradeQuestion(question, true, [])).toMatchObject({ autoScore: 1, judgment: "CORRECT" })
  })
})
