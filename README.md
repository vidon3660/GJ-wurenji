# 低空无人集群教学仿真平台

面向大专院校无人机、低空运行、物流调度和巡检课程的 B/S 实训系统。教师发布包含区域资源、机型、运行事件和指标的任务；学生在二维 GIS 中设计方案，在 Cesium 三维视图中检查建筑、地形和运行状态，服务端按运行数据计算结果。学生可以提交多套方案，系统按任务约束和指标判定是否达到要求，不使用固定文字答案。

系统输出是教学仿真结果，不能用于真机飞行、飞行审批、航线划设或实际物流运营。

## 当前场景范围

代码中的场景类型只有以下三种：

| 场景类型 | 任务设计 | 运行计算 |
| --- | --- | --- |
| `CITY_LOGISTICS` 城市低空物流 | 物流中心、起降点、配送点、订单、时间窗、机型、航线、环境和事件 | 订单完成/准时、飞行时间、电量、航线与空间风险、机间间隔、机池周转和事件处置 |
| `CITY_SHOW` 城市编队表演 | 表演区、编队程序、分批起飞、机型、规模、通信/定位和设备事件 | 阶段完成、起降数量、编队状态、程序轨迹空间检查、机间水平/垂直间隔和事件处置 |
| `VTOL_INSPECTION` 垂起广域巡检 | 巡检对象、任务区、主备起降点、航线阶段、地形、垂起转换和运行事件 | 任务覆盖、航线阶段、地形净空、速度/高度/转换限制、能源余度、备降可行性和事件处置 |

应急救援不是第四种场景。应急内容以物流、表演和巡检任务中的运行事件、备降、返航、任务转移、分组降落等处置阶段出现；教师不能创建 `EMERGENCY_RESCUE` 类型任务。

表演 V1.0 任务模板为 100、500、1000、3000 架；5000 架参数仅保留兼容解析，不能在当前任务目录中创建、发布或作为验收规模。物流模板为 3、5、10、20、50 架，巡检模板为 1、5、20 架，最终可选项由已发布资源包决定。

## 功能边界

### 教师端

教师可以创建课程、班级和场景任务，选择已发布区域资源包，设置学生可编辑字段、硬约束、时间窗、指标阈值和评分量表，发布任务并查看运行数据、告警、处置动作和结果报告。任务发布后，区域、机型和规则快照被冻结。

### 学生端

学生进入已发布任务后，根据教师提供的字段在二维地图中规划航点、航段高度、速度、起飞时刻、任务分配和主备航线；是否显示订单、事件、备降或能源字段取决于任务模板和场景实现。学生提交前必须完成预检并启动一次新的运行会话，再查看三维态势、事件处置和服务端计算指标。

通用仿真包含电量消耗、任务时长、返航余量、部分充电/换电约束等计算能力，但不是每个 V3 场景都提供完整的充换电编辑界面；页面中只能编辑任务快照明确开放的字段。新运行会话会清除未发布评价中的上一轮指标，防止沿用旧方案结果。

首次进入教师端或学生端会按当前账号和可操作任务显示引导；没有目标任务时不会展示无效操作入口。

## 结果如何计算

各场景使用任务发布时冻结的资源和参数，但计算模型不同，不能将通用仿真包支持的所有字段等同于每个工作台都已实现：

| 模块 | 当前计算方式 | 适用范围和限制 |
| --- | --- | --- |
| 通用路径/空间风险 | 连续航段与旋转建筑/障碍物包围体、禁限飞区、边界相交；同一时刻的水平/垂直机间隔离 | 依赖输入中的建筑几何与高度。浏览器只显示而未写入任务的数据不参与判定 |
| 通用能源模型 | 飞行与悬停消耗、容量折减、返航余量、充电功率/时长、换电时长和补能点约束 | 计算库具备这些输入；各 V3 工作台尚未提供统一的充换电全流程编辑界面 |
| 物流 | 按航程、航段和机型参数计算飞行时间与估算电量，按时间窗、机池周转和事件计算订单结果 | 电量为教学估算，当前周转时长不等同于电池寿命或充电桩排队模型 |
| 表演 | 导入程序按关键帧之间的线性轨迹检查速度、高度和机间距；运行阶段按编队显示数量、状态和处置动作 | 默认水平隔离 5 m、垂直隔离 3 m。只有本地 ENU 坐标的导入文件没有区域建筑对应关系，导入通过不代表建筑碰撞检查通过；大规模运行使用编队聚合 |
| 垂起巡检 | 分阶段计算功率、耗时、能量和任务覆盖，比较主备航线余量，按地形剖面检查净空 | 取决于高程采样密度和机型功率参数，不是空气动力学或电池化学模型 |

地形净空计算需要有效高程。任务要求净空而数据缺失时，检查不能判为合格；“地面风险”目前指建筑、障碍物和净空冲突，没有人口密度、伤亡概率或坠落扩散模型。

方案指标来自服务端运行数据；没有当前会话结果时，对应自动评价保持待计算。运行终止、失败、超时及约束冲突按指标判定，教师量表评分与自动计算项分别保存。说明文字或教师评分不会替代飞行时间、冲突、电量等数值计算。

## GIS 和二三维联动

坐标数据使用 WGS84 / EPSG:4326。接入 GCJ-02 时必须在地图适配层转换，不能把偏移坐标直接写入场景数据。二维模式用于点、线、面、航点和区域规划；三维模式用于建筑高度、地形和运行态势。两种模式共用对象 ID、选中状态和图层状态，并保留地图范围。

区域资源包可以包含影像、建筑 GeoJSON、DEM/quantized-mesh 地形、边界、障碍物、禁限飞区、起降点、物流节点和巡检对象，并带有版本、范围、坐标系和 SHA-256。仓库内置物流教学区文件：

- `apps/web/public/map/logistics/gd-north-core-orthophoto.jpg`
- `apps/web/public/map/logistics/gd-north-core-buildings.geojson`

没有正式区域包时只能使用仓库内置轻量教学区或椭球地面。Cesium ion 世界影像、世界地形和 OSM 3D Buildings 都是可选外部服务，不能代替任务资源包中的建筑和高程数据。`VITE_DEM_TERRAIN_URL` 必须指向 Cesium quantized-mesh `layer.json` 服务，不能填写原始 GeoTIFF。

## 技术结构

```text
apps/web                 Vue 3、Element Plus、CesiumJS：教师/学生工作台、二维 GIS、三维态势和结果页
apps/server              NestJS、TypeORM：认证、课程、任务、资源包、运行会话、事件、评价和报告
packages/shared          共享类型、场景策略、阶段定义和资源契约
packages/simulation      物流、表演、垂起、空间风险和通用能源仿真
PostgreSQL 17 + PostGIS  任务、区域、方案、运行记录和指标
MinIO                    生产对象存储；开发可使用本地文件存储
Worker                   Outbox 作业、报告生成、租约和重试
```

仓库使用 npm workspaces，要求 Node.js `>=24`。生产 Compose 使用 Linux/amd64 镜像；Apple Silicon 由 Docker Desktop 通过兼容模式运行。

## 首次启动

先安装 Git、Node.js 24、npm 和 Docker Desktop（Docker Compose 插件至少为 `2.24.4`，用于解析 `!override`/`!reset`），在仓库根目录执行：

```bash
git clone https://github.com/vidon3660/GJ-wurenji.git
cd GJ-wurenji
npm ci
npm run setup
```

`npm run setup` 只在 `.env` 不存在时生成配置，随机生成数据库、JWT、MinIO、OnlyOffice 和演示账号密码，并将文件权限设为仅当前用户可读。密码不会打印到终端，保存在 `.env` 的 `DEMO_ADMIN_PASSWORD`、`DEMO_TEACHER_PASSWORD`、`DEMO_STUDENT_PASSWORD` 和 `DEMO_STUDENT2_PASSWORD` 中。演示账号邮箱为 `admin@demo.local`、`teacher@demo.local`、`student@demo.local` 和 `student2@demo.local`。`.env` 不能提交到 Git。账号只在 `SEED_DEMO_DATA=true` 且数据库没有该用户时创建；修改 `.env` 不会重置已有账号密码。

开发环境优先使用本地文件存储和 PostGIS：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

启动后访问 `http://localhost:3000`，接口地址为 `http://localhost:3000/api`。

- 存活检查：`/api/healthz`
- 依赖和迁移检查：`/api/readyz`
- PostgreSQL：宿主机 `55432`（可由 `POSTGRES_PORT` 修改）
- Vite 开发服务器：`http://localhost:5173`

需要使用 MinIO 时，不加载 `docker-compose.local.yml`，并在 `.env` 设置 `V3_FILE_STORAGE_PROVIDER=MINIO`，再执行 `docker compose up -d --build`。MinIO API 默认 `59000`，控制台默认 `59001`。生产环境固定使用 MinIO；不能把开发机的本地文件目录当作生产对象存储。

需要报告 Worker 时：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile worker up -d --build worker
npm run worker:smoke
```

以上命令对应本地文件存储模式；使用 MinIO 模式时移除 `-f docker-compose.local.yml`。Worker 读取同一数据库和文件存储。OnlyOffice 只在需要在线文档或 DOCX 处理时启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile office up -d onlyoffice
```

## 本地开发

如果只启动数据库，在根目录执行：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d db
npm run dev:prepare
npm run dev
```

`npm run dev` 启动 Vite `5173` 和 NestJS `3000`。本地文件默认写入 `apps/server/data/v3-files`，地图数据按 `MAP_DATA_DIR` 读取，服务端、资源检查和地形采样使用同一仓库相对路径；未配置时回退到 `apps/web/dist/map`。不要在运行中切换文件目录，否则数据库中的资源引用会失效。修改 `VITE_*` 后需要重新启动 Vite 或重新构建镜像。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 类型检查 | `npm run typecheck` |
| 生产构建 | `npm run build` |
| 仿真、服务端、前端测试 | `npm test` |
| 生成物流教学地图 | `npm run map:demo-assets` |
| 区域地图导入 | `npm run map:region:import -- --config path/to/region-config.json --output-root data/map` |
| 地图资源检查 | `npm run map:resources:acceptance` |
| 资源包构建 | `npm run resource:build -- --manifest path/to/descriptor.json --source-dir path/to/package --private-key path/to/key.pem --key-id key-id` |
| 文档包验收 | `npm run document:acceptance` |
| 部署配置检查 | `npm run deployment:smoke -- --config-only` |
| 本地运行配置回归 | `npm run test:runtime-config` |
| 本地性能计算 | `npm run performance:baseline` |
| 备份创建 | `npm run backup:create -- --output data/backups/<恢复点目录>` |
| 备份校验 | `npm run backup:verify -- --input data/backups/<恢复点目录>` |
| 教师区域地图/学生列表浏览器检查 | `npm run visual:smoke` |
| 浏览器三场景响应式检查 | `npm run accessibility:v3-runtime:browser` |

根目录的运行、备份和浏览器验收命令会自动加载 `.env`，显式环境变量优先。浏览器脚本使用 `playwright-core`，不会下载 Chrome/Chromium。执行前设置 `CHROME_PATH`，并启动应用、准备演示账号和对应场景夹具；脚本结果写入 `artifacts/`。`visual:smoke` 登录真实教师/学生账号，检查 V3 教师预设区域地图与学生任务列表；教师输出 `coverage=V3_REGION_MAP_2D_3D` 表示地图已加载，`V3_REGION_CATALOG_EMPTY` 表示当前没有区域可供检查。设置 `VISUAL_TEACHER_EMAIL`/`VISUAL_STUDENT_EMAIL` 和对应的 `VISUAL_*_PASSWORD` 可以覆盖演示账号，密码未覆盖时使用 `.env` 的 `DEMO_*_PASSWORD`。`accessibility:v3-runtime:browser` 需要三种场景的运行夹具，检查运行区布局与控件。旧 `accessibility:browser` 保留用于历史 V2 界面，不作为当前 V3 验收入口。

## 地图和关键环境变量

`.env.example` 是模板，实际值写入本地 `.env`：

```dotenv
DATABASE_URL=postgresql://wurenji:<password>@localhost:55432/wurenji
V3_FILE_STORAGE_PROVIDER=LOCAL
V3_FILE_STORAGE_DIR=./apps/server/data/v3-files
MAP_DATA_DIR=./data/map
WEB_ORIGIN=http://localhost:3000,http://localhost:5173

VITE_MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
VITE_LOGISTICS_OFFLINE_IMAGERY_URL=/map/logistics/gd-north-core-orthophoto.jpg
VITE_LOGISTICS_BUILDINGS_URL=/map/logistics/gd-north-core-buildings.geojson
VITE_CESIUM_ION_TOKEN=
VITE_DEM_TERRAIN_URL=
VITE_ENABLE_WORLD_IMAGERY=true
VITE_ENABLE_WORLD_TERRAIN=false
VITE_ENABLE_OSM_BUILDINGS=false
```

正式部署还必须设置 `PRODUCTION_DATABASE_URL`、`JWT_SECRET`、`ONLYOFFICE_JWT_SECRET`、MinIO 密钥、`WEB_ORIGIN`、`COOKIE_SECURE=true`、`TYPEORM_SYNCHRONIZE=false`、`SEED_DEMO_DATA=false` 和资源包信任公钥。生产环境不使用演示账号自动播种。

## 生产部署、备份与恢复

生产部署需要 HTTPS 网关、PostGIS、MinIO、Worker、受信资源包公钥和学校目标环境的证书：

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.production.yml \
  --profile production --profile worker \
  up -d --build
```

生产只对外开放网关 80/443 端口。完整变量、证书和升级回滚说明见 [`deploy/README.md`](deploy/README.md)。

备份必须在目标环境执行，并按存储方式选择命令：

- Docker 本地文件存储：使用 `docker compose -f docker-compose.yml -f docker-compose.local.yml --profile backup run --rm backup create`。MinIO 模式去掉本地覆盖文件；生产环境使用 [`deploy/README.md`](deploy/README.md) 中的完整命令。备份容器可读取对应命名卷和对象存储，输出挂载到主机 `data/backups/`。
- 源码开发：停止写入后，在配置了 `.env`、`pg_dump` 和本地文件目录的主机执行 `npm run backup:create -- --output data/backups/<恢复点目录>`。

恢复前必须停止应用写入；严格恢复还需要 `--confirm RESTORE --confirm-exact REPLACE_DATABASE_AND_FILES`。不得把备份、密钥、证书或 `.env` 提交到仓库。

## 现场验收边界

本地单元测试和短时脚本不能代替学校目标环境的 GPU、浏览器、正式地图、并发人数和长时运行。正式验收应在同一目标环境标签下准备三个场景资源和任务，至少检查：表演 3000 架、物流 50 架/100 单、巡检 20 架、20 名学生并发以及每个场景 30 分钟运行记录。5000 架不属于当前验收门槛。浏览器性能命令示例：

```bash
ACCEPTANCE_TARGET_LABEL=target-lab \
BROWSER_PERF_DURATION_MS=1800000 \
BROWSER_PERF_REQUIRE_FORMAL_SCALE=true \
BROWSER_PERF_REQUIRE_LONG_RUN=true \
BROWSER_PERF_REQUIRE_RUNNING_SESSION=true \
RUNTIME_SCENE=ALL \
npm run performance:browser-runtime
```

没有正式建筑、高程或影像资源时，验收报告必须标明资源缺失；不能以静态截图替代运行结果。

## 文档入口

| 内容 | 文档 |
| --- | --- |
| 文档总目录 | [`docs/README.md`](docs/README.md) |
| 教师和学生操作 | [`docs/低空无人集群教学仿真软件-完整操作手册.md`](docs/低空无人集群教学仿真软件-完整操作手册.md) |
| 场景任务和指标 | [`docs/教学任务与三场景题库设计实施说明.md`](docs/教学任务与三场景题库设计实施说明.md) |
| 系统设计 | [`docs/系统设计与实施方案.md`](docs/系统设计与实施方案.md) |
| 地图资源 | [`docs/城市物流无人机离线地图改造总体架构.md`](docs/城市物流无人机离线地图改造总体架构.md) |
| 技术设计和现场验收 | [`docs/低空无人集群仿真实训系统技术设计与验收方案.md`](docs/低空无人集群仿真实训系统技术设计与验收方案.md) |
| 开发交付记录 | [`docs/开发交付记录.md`](docs/开发交付记录.md) |
| 当前待办 | [`docs/实施待办清单.md`](docs/实施待办清单.md) |
| 生产部署 | [`deploy/README.md`](deploy/README.md) |

## 当前限制

系统用于教学方案设计和运行分析，不包含真实飞控、机载通信、厘米级动力学、真实气象预报、自动最优调度或真机安全放行。建筑、地形和影像结果取决于任务绑定的区域资源版本；未绑定正式资源时只能使用仓库内置轻量教学区。正式课程交付前请完成目标环境资源、容量、浏览器、证书、备份恢复和回滚验证。
