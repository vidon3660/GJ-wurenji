process.env.RUNTIME_FIXTURE_PREFIX ??= "P0-SHOW-ALERT"
process.env.RUNTIME_FIXTURE_SKIP_LOGISTICS ??= "true"
process.env.RUNTIME_FIXTURE_SHOW_STOP_AT ??= "RUNTIME_ACTIVE"
process.env.RUNTIME_FIXTURE_OUTPUT ??= "artifacts/show-alert-browser-fixture-latest.json"
await import("./prepare-browser-scale-fixtures.mjs")
