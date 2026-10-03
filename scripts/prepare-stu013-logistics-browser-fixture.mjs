process.env.STU012_FIXTURE_SCALE ??= "LOGISTICS_20"
process.env.STU012_FIXTURE_STOP_AT ??= "RUNTIME_ACTIVE"
process.env.STU012_FIXTURE_OUTPUT ??= "artifacts/stu013-logistics-alert-browser-fixture-latest.json"
process.env.STU012_FIXTURE_TITLE ??= `STU-013 物流告警运行验收 ${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`
process.env.STU012_FIXTURE_REPLAY_EVENT ??= "ORDER_PRIORITY_CHANGED"
await import("./prepare-stu012-browser-fixture.mjs")
