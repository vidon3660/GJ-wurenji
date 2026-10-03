# 云阵无人集群虚拟仿真实训 MVP

这是一个可直接运行的 B/S 架构 MVP，实现教师配置场景、学生规划多机方案、服务端仿真、问题回放、成果提交与导出。前端使用 Vue 3、CesiumJS 和 Element Plus，后端使用 NestJS、TypeORM、PostgreSQL/PostGIS，仿真使用 TypeScript 和 Node Worker Thread。

## 一键启动

需要 Docker Desktop。Apple Silicon 会通过 Docker Desktop 兼容模式运行官方 PostGIS 镜像。

```bash
npm run setup                 # 首次执行：生成本地 .env，不覆盖已有配置
docker compose up -d --build
```

表演评价发布后的 PDF 报告由独立 Worker 异步生成；本地启用命令：

```bash
docker compose --profile worker up -d --build worker
npm run worker:smoke
```

启动完成后访问：

```text
http://localhost:3000
```

健康检查：`http://localhost:3000/api/healthz`；数据库就绪检查：`http://localhost:3000/api/readyz`。生产环境请参考 `deploy/README.md`，通过 `production` profile 使用 HTTPS 网关，不要直接暴露应用、数据库和 MinIO 端口。

演示账号：

| 角色 | 账号 | 密码 |
|---|---|---|
| 教师 | `teacher@demo.local` | `.env` 中的 `DEMO_TEACHER_PASSWORD` |
| 学生 | `student@demo.local` | `.env` 中的 `DEMO_STUDENT_PASSWORD` |
| 学生 2 | `student2@demo.local` | `.env` 中的 `DEMO_STUDENT2_PASSWORD` |

PostGIS 默认映射到宿主机 `55432`，避免与本机已有的 PostgreSQL `5432` 冲突。可通过 `POSTGRES_PORT` 修改。

## 已实现流程

- 教师新建城市集群表演或城市物流配送实训。
- 教师配置无人机、边界、起降点、任务点、障碍物、禁飞区、风雨和安全规则。
- 场景检查、发布版本和学生提交进度查看。
- 学生编组、任务分配、航点创建，以及高度、速度、起飞时间配置。
- 二维地图负责点位、区域、航线规划；点击对象可定位并高亮，图层开关与对象选择在二维/三维间保持一致。
- Cesium 单 Viewer 2D/3D 切换，三维用于地形、建筑高度和运行态势观察，航线与仿真轨迹回放。
- Worker Thread 固定 200 ms 步长仿真，最多 50 架无人机。
- PostgreSQL Outbox、租约、重试和独立 Worker 进程，已接入表演最终报告自动生成。
- 任务完成、间距、禁飞区、障碍物、边界、超时、航程、载重和性能限制检查。
- 问题定位、修改后重跑、最终版本提交、JSON/CSV 导出和浏览器打印。

## 本地开发

```bash
npm run setup                 # 已有 .env 时保持不变
docker compose up -d db
npm install
npm run dev:prepare       # 数据库已启动后执行迁移和共享包构建
npm run dev
```

`npm run setup` 只在 `.env` 不存在时生成本地随机数据库、对象存储、JWT 和演示账号密码；命令不会打印任何密码，也不会覆盖已有 `.env`。首次开发启动建议使用 `npm run dev:prepare` 完成环境初始化、共享包构建和迁移，然后运行 `npm run dev`。

开发地址为 `http://localhost:5173`，API 为 `http://localhost:3000/api`。`.env.example` 已配置本机数据库端口 `55432`。

本地开发的文件资产统一存放在 `apps/server/data/v3-files`，`V3_FILE_STORAGE_DIR` 必须与该目录一致。不要在 `data/v3-files` 和 `apps/server/data/v3-files` 之间切换，否则数据库中的资源包、文档模板和成果文件可能无法读取。

常用检查：

```bash
npm run build
npm test
npm run map:demo-assets       # 需要重建仓库自带的轻量教学区离线底图时执行
npm run visual:smoke
```

`visual:smoke` 要求应用已在 `3000` 端口运行，并使用本机 Chrome 验证教师/学生工作台、Cesium WebGL 画布和 2D/3D 切换。截图输出到 `/tmp/wurenji-visual`。

仓库已内置一套可直接运行的轻量教学区离线资源：`apps/web/public/map/logistics/` 下的单幅影像和建筑 GeoJSON，供物流 2D/3D 页面在没有外部地图服务时完成教学演示。它是可替换的演示数据，不代表正式测绘成果；接入正式资源后，使用对应资源包的 URL、范围和 SHA-256，并重新构建前端。

### 交付验收

短时正式规模浏览器预检会同时验证 3000 架表演、50 架/100 单物流、20 架垂起巡检、帧率、SSE 在线状态和 JS 堆增长，但不会被当作正式长时证据：

```powershell
$env:BROWSER_PERF_DURATION_MS='15000'
$env:BROWSER_PERF_HEARTBEAT_INTERVAL_MS='2000'
$env:BROWSER_PERF_REQUIRE_FORMAL_SCALE='true'
npm.cmd run performance:browser-runtime
```

目标环境正式验收至少持续 30 分钟，并要求测试开始时运行会话处于 `RUNNING`：

```powershell
$env:ACCEPTANCE_TARGET_LABEL='target-lab'
$env:BROWSER_PERF_DURATION_MS='1800000'
$env:BROWSER_PERF_REQUIRE_FORMAL_SCALE='true'
$env:BROWSER_PERF_REQUIRE_LONG_RUN='true'
$env:BROWSER_PERF_REQUIRE_RUNNING_SESSION='true'
$env:BROWSER_PERF_TARGET_LABEL='target-lab'
npm.cmd run performance:browser-runtime
```

表演、物流和垂起巡检可以分别生成浏览器报告；`target-environment:acceptance` 会按场景合并同一目标标签的最新文件。正式表演/物流夹具设置 `RUNTIME_FIXTURE_CLOCK_RATE='0.25'`，垂起夹具设置 `VTL_FIXTURE_RUNTIME_CLOCK_RATE='0.25'`。规模门禁要求表演恰好 3000 架、物流恰好 50 架/100 单、垂起恰好 20 架，并校验分组、机池、订单、任务和排程的内部计数一致性。

垂起巡检长时工况应先创建 20 架、低速航线、0.25x 时钟的运行项目，并把教学事件延后到采样窗口之后，避免运行在采样期间自动完成或因事件暂停：

```powershell
$env:VTL_FIXTURE_SCALE='VTL_20'
$env:VTL_FIXTURE_STOP_AT='RUNTIME_ACTIVE'
$env:VTL_FIXTURE_EVENT_TRIGGER_OFFSET_SECONDS='3600'
$env:VTL_FIXTURE_ROUTE_SPEED_MPS='5'
$env:VTL_FIXTURE_RUNTIME_CLOCK_RATE='0.25'
$env:VTL_FIXTURE_OUTPUT='artifacts/performance/vtl-20-long-run-fixture.json'
npm.cmd run acceptance:vtl:fixture

$env:RUNTIME_SCENE='VTOL_INSPECTION'
$env:RUNTIME_PROJECT_ID='<fixture 输出中的 projectId>'
$env:BROWSER_PERF_DURATION_MS='1800000'
$env:BROWSER_PERF_REQUIRE_FORMAL_SCALE='true'
$env:BROWSER_PERF_REQUIRE_LONG_RUN='true'
$env:BROWSER_PERF_REQUIRE_RUNNING_SESSION='true'
npm.cmd run performance:browser-runtime -- --output artifacts/performance/browser-runtime-vtl-20-long-run.json
```

班级并发脚本默认使用两个演示学生。正式验收通过 `CLASS_CONCURRENCY_CREDENTIALS_FILE` 传入教师和至少 20 名真实测试学生，文件格式如下：

```json
{
  "teacher": { "email": "teacher@example.edu", "password": "change-me" },
  "students": [
    { "email": "student01@example.edu", "password": "change-me" },
    { "email": "student02@example.edu", "password": "change-me" }
  ]
}
```

```powershell
$env:ACCEPTANCE_TARGET_LABEL='target-lab'
$env:CLASS_CONCURRENCY_CREDENTIALS_FILE='C:\secure\class-credentials.json'
$env:CLASS_CONCURRENCY_ROUNDS='20'
$env:CLASS_CONCURRENCY_REQUIRE_FORMAL='true'
$env:CLASS_CONCURRENCY_TARGET_LABEL='target-lab'
npm.cmd run class-concurrency:smoke
$env:ACCEPTANCE_TEACHER_EMAIL='teacher@example.edu'
$env:ACCEPTANCE_TEACHER_PASSWORD='<teacher-password>'
$env:VTL_RESOURCE_ACCEPTANCE_REQUIRE_PASS='true'
npm.cmd run vtl:resources:acceptance
npm.cmd run target-environment:acceptance
npm.cmd run acceptance:evidence
```

凭据文件只用于登录，不会写入验收报告；报告仅保存匿名参与者编号、用户 ID、项目数量和项目 ID 摘要。

安全、部署、备份恢复、软件升级回滚、班级并发和浏览器长时脚本都会把 `ACCEPTANCE_TARGET_LABEL` 写入证据；班级和浏览器脚本仍可分别用 `CLASS_CONCURRENCY_TARGET_LABEL`、`BROWSER_PERF_TARGET_LABEL` 覆盖。目标环境最终验收只聚合同一标签且默认 168 小时内生成的证据，避免本机结果或过期结果冒充机房现状；有效期可通过 `TARGET_ACCEPTANCE_MAX_EVIDENCE_AGE_HOURS` 调整。

运行 `acceptance:evidence` 前，应把本次实际结果写入 `ACCEPTANCE_TEST_SUMMARY` 和 `ACCEPTANCE_TYPECHECK_SUMMARY`。未提供时这两项保持 `PENDING`，汇总器不会用静态历史数字代替本次验证。

目标环境最终验收还需要通过 `TARGET_ACCEPTANCE_SIGNOFF_FILE` 提供人工签字 JSON。文件必须包含与 `TARGET_ACCEPTANCE_TARGET_LABEL`（未设置时使用 `ACCEPTANCE_TARGET_LABEL`）一致的 `targetLabel`、`approvedBy`、ISO 8601 `approvedAt`，并在 `approvals` 中将 `tlsCertificate`、`formalSecrets`、`authorizedFonts`、`backupRestoreWitnessed` 和 `upgradeRollbackWitnessed` 全部设为 `true`。签字、20 人班级、三场景 30 分钟和 HTTPS 任一缺失时，生产验收保持 `PENDING`。

签字文件结构如下，五项只能在现场逐项见证后改为 `true`：

```json
{
  "targetLabel": "target-lab",
  "approvedBy": "验收负责人",
  "approvedAt": "2026-08-14T10:00:00+08:00",
  "approvals": {
    "tlsCertificate": false,
    "formalSecrets": false,
    "authorizedFonts": false,
    "backupRestoreWitnessed": false,
    "upgradeRollbackWitnessed": false
  }
}
```

## 地图配置

默认使用 OpenStreetMap 在线影像和椭球地面。可通过环境变量切换影像供应商：

```text
VITE_MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

如需接入 Cesium ion 的真实地形高程和 OSM 3D 建筑，在本机 `.env.local` 或 Docker 使用的 `.env` 中配置：

```text
VITE_CESIUM_ION_TOKEN=你的Cesium-ion-Token
VITE_DEM_TERRAIN_URL=
VITE_TERRAIN_REQUEST_TIMEOUT_MS=8000
VITE_ENABLE_WORLD_IMAGERY=true
VITE_ENABLE_WORLD_TERRAIN=true
VITE_ENABLE_OSM_BUILDINGS=true
```

启用 ion 后，底图使用 Cesium World Imagery（资产 2），地形使用 Cesium World Terrain（资产 1），并可叠加 OSM 3D Buildings。`VITE_DEM_TERRAIN_URL` 可填写自有 Cesium quantized-mesh 或兼容 TerrainProvider 的地形服务地址，作为没有区域级 DEM 资源时的全局回退。区域资源包可以在 `content.terrain` 中声明 `provider`、`url`、`version`、`sha256`、`verticalDatum` 和 `extent`；V3 地图优先加载该区域 URL，失败后回退椭球地形。普通 GeoTIFF 不能直接填入该变量，需要先发布为 Cesium 地形瓦片服务。

若 ion 影像加载失败，系统会退回配置的在线瓦片和本地网格底图。这些变量会在前端构建阶段写入浏览器资源，因此应使用仅允许访问所需 ion 资源、并配置 URL/域名限制的 Token，不要使用具备资产管理权限的主 Token。修改配置后需要重新构建前端或 Docker 镜像。真实地形启用后，地图点位会采样并显示地面高程；无人机的任务高度仍按相对地面高度处理。

业务坐标统一保存为 WGS84。若接入 GCJ-02 地图，必须在地图适配层转换，不能将偏移坐标写入场景数据。

## MVP 边界

本版本面向教学试点，不包含真机/飞控接入、高精度动力学、复杂气象场、自动最优调度、微服务或千机仿真。生产部署必须修改 `JWT_SECRET`，并在 HTTPS 网关后设置 `COOKIE_SECURE=true`；TypeORM `synchronize` 仅用于 MVP，正式维护数据后应改用迁移脚本。
