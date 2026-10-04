# 低空无人集群教学仿真平台

面向大专院校无人机、低空运行和物流调度课程的 B/S 教学实训系统。教师配置场景任务、空间资源、飞行器参数、运行事件和评价指标；学生在二维 GIS 中设计方案，在同一 Cesium Viewer 中切换三维查看建筑与地形，运行仿真并提交结果。系统允许多套方案竞争，是否合格由服务端根据运行数据和任务指标计算，不由文字说明或预设答案决定。

当前主线包含城市编队表演、城市低空物流、垂起广域巡检三类场景。平台输出属于教学仿真结果，不能用于真机飞行、飞行审批、航线划设或实际物流运营。

## 能做什么

### 教师端

- 创建课程、班级和场景任务，选择已发布的区域资源包与场景覆盖层。
- 通过任务向导配置规模模板、机型、起降点、配送点或巡检对象、边界、建筑、障碍物、禁限飞区、地形、能源设施、天气、通信和运行事件。
- 设置任务模式（训练或考核）、时间窗、硬约束、指标阈值和评分量表。
- 选择场景任务题库，将任务发布给班级或指定学生，查看阶段进度、运行状态和多方案结果。
- 查看服务端计算的运行记录、告警、处置动作、指标和报告，导出 JSON/CSV 或打印结果。

### 学生端

1. 从任务列表进入已发布任务，查看教师冻结的区域、机型、规则和指标。
2. 在二维地图中编辑航点、航段高度、速度、起飞时刻、任务分配和主备航线；需要时配置充电、换电和备降计划。
3. 预检通过后启动仿真，在三维视图中观察建筑高度、地形、机群和运行态势。
4. 按场景处理天气、通信、设备、航线、订单或任务条件变化，执行返航、备降、降速、重调度等可用动作。
5. 查看当前运行的时间、完成量、风险、能量、事件处置和性能指标，保存方案版本并提交。

首次进入学生端或教师端时，系统会按照当前账号和实际可操作任务显示引导；没有可执行任务时不会弹出无目标提示。

## 三类场景

| 场景 | 教师配置重点 | 学生设计内容 | 运行结果示例 |
| --- | --- | --- | --- |
| 城市编队表演 `CITY_SHOW` | 表演区域、功能区、编队程序、机群规模、风雨、定位/通信和设备事件 | 编组、表演航迹、批次起飞、返航/降落和事件处置 | 阶段完成、起飞/降落数量、异常机组、事件处置率、程序空间检查和报告 |
| 城市低空物流 `CITY_LOGISTICS` | 中心机场、起降点、配送点、等待/备降点、订单、时间窗、机池、航线和调度事件 | 区域分析、主备航线、订单分配、时刻表、能源补给和动态重调度 | 订单完成率、准时率、飞行时间、航线/空域风险、机间冲突、机池周转和最低剩余能量 |
| 垂起广域巡检 `VTOL_INSPECTION` | 任务对象、主备起降点、可飞区域、地形、垂起转换参数、能量和巡检事件 | 任务分区、机组分配、八阶段航线、地形剖面、备降选择和应急动作 | 任务覆盖、航线结构、转换高度、地形净空、主备航线能量、设备限制和事件处置 |

内置规模模板为表演 100/500/1000/3000 架、物流 3/5/10/20/50 架、垂起 1/5/20 架。代码可以识别 5000 架的聚合参数，但 V1.0 资源包不提供 `SHOW_5000` 创建模板，5000 架不属于当前任务发布和验收范围；如需扩展，必须先提供相应资源包、任务规则和目标环境运行记录。

## 服务端如何判定方案

场景条件、资源版本和机型参数在任务发布时冻结。学生每次运行都会建立新的运行会话；开始新运行时，未发布评价中的旧指标会清除，结果页面不会沿用上一轮方案数据。

服务端计算内容包括：

- 连续航段与建筑物、障碍物、禁限飞区、边界和地形的三维关系；地形净空需要有效高程数据，缺失时返回不可判定，不用零高程代替。
- 按仿真时间计算机间水平/垂直间隔、交叉航段冲突、冲突开始时间、持续时间和最近距离。阈值来自任务规则；表演轨迹导入默认检查水平 5 m、垂直 3 m 的机间隔离。
- 最大高度、最低高度、速度、爬升/下降能力、航程、载荷、可用状态、任务时间窗和超时。
- 电池容量折减、航段与悬停消耗、返航余量、充电功率、充电时长、换电时长、能源站距离/高差和补能后可用能量。补能点或服务时长无效时，方案不可执行。
- 物流订单完成、准时到达、航线状态、机池周转、事件响应与重调度；表演阶段、机群状态、事件影响与程序空间检查；垂起任务覆盖、航线阶段、地形剖面和备降能量。

“通过”只会在运行数据满足任务硬约束和指标阈值后出现。没有完成运行、运行失败或高程数据不足时，指标保持待计算或不合格状态。

## GIS 与二三维联动

- 坐标统一使用 WGS84 / EPSG:4326。接入 GCJ-02 时必须在地图适配层转换，不能把偏移坐标写入场景数据。
- 二维模式用于点、线、面、航点、区域和图层规划；三维模式用于建筑高度、地形和运行态势观察。二者共用同一 Cesium Viewer、对象 ID、选中状态和图层状态，切换时保留相机中心与显示范围。
- 地图资源包可以包含影像、建筑 GeoJSON、DEM/quantized-mesh 地形、边界、障碍物、禁限飞区、起降点、物流节点和巡检对象，并提供版本、范围和 SHA-256。
- 仓库内置轻量物流教学资源：
  - `apps/web/public/map/logistics/gd-north-core-orthophoto.jpg`
  - `apps/web/public/map/logistics/gd-north-core-buildings.geojson`
- 在线影像可使用 OpenStreetMap 瓦片；Cesium ion 影像、全球地形和 OSM 3D Buildings 为可选配置。`VITE_DEM_TERRAIN_URL` 只能指向 Cesium quantized-mesh 兼容服务，不能直接填写 GeoTIFF。

## 技术结构

```text
apps/web        Vue 3 + CesiumJS + Element Plus，教师/学生工作台、二维 GIS、三维态势和结果页面
apps/server     NestJS + TypeORM，认证、任务、资源包、运行会话、事件、评价、文件和报告
packages/shared 共享类型、场景策略、阶段定义、资源和运行契约
packages/simulation 物流调度、表演运行、垂起航线、空间风险和通用路径仿真
PostgreSQL/PostGIS 任务、区域、方案、运行记录、指标和操作数据
MinIO           生产文件资产和报告存储；开发环境可使用本地文件存储
Worker          Outbox 作业、DOCX/PDF 报告生成、租约、重试和健康检查
```

仓库按 npm workspaces 管理，要求 Node.js `>=24`。数据库使用 PostgreSQL 17 + PostGIS；Compose 默认使用 Linux/amd64 镜像，Apple Silicon 由 Docker Desktop 通过兼容模式运行。

## 快速启动（Docker）

先安装 Docker Desktop、Node.js 24 和 npm，然后在仓库根目录执行：

```bash
npm run setup                 # 仅在 .env 不存在时生成本地配置

docker compose up -d --build # 启动 db、MinIO、迁移和应用
```

启动后访问 `http://localhost:3000`。

- 应用存活：`http://localhost:3000/api/healthz`
- 数据库和依赖就绪：`http://localhost:3000/api/readyz`
- PostgreSQL：宿主机 `55432`（可由 `POSTGRES_PORT` 修改）
- MinIO API：`59000`；MinIO 控制台：`59001`
- OnlyOffice（可选）：`49080`

报告生成使用独立 Worker。需要 DOCX/PDF 报告时执行：

```bash
docker compose --profile worker up -d --build worker
npm run worker:smoke
```

OnlyOffice 仅在需要在线文档编辑或 DOCX 处理时启动：

```bash
docker compose --profile office up -d onlyoffice
```

演示账号的密码由 `.env` 中的 `DEMO_*_PASSWORD` 提供。`npm run setup` 不会在终端打印密码，也不会覆盖已有 `.env`；`.env` 不得提交到版本库。

## 本地开发

本地开发使用 Vite 前端和 NestJS 服务端，文件资产默认写入 `apps/server/data/v3-files`。不要在 `data/v3-files` 与 `apps/server/data/v3-files` 之间切换，否则数据库引用的资源包和成果文件将无法读取。

```bash
npm install
npm run setup
docker compose up -d db
npm run dev:prepare        # 构建 shared/simulation，并执行开发迁移
npm run dev                # 前端 http://localhost:5173，API http://localhost:3000/api
```

开发环境默认 `V3_FILE_STORAGE_PROVIDER=LOCAL`；Docker 组合环境默认使用 MinIO。修改 `VITE_*` 后需要重新运行前端构建或重新构建镜像。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 类型检查 | `npm run typecheck` |
| 生产构建 | `npm run build` |
| 仿真、服务端、前端测试 | `npm test` |
| 单独运行仿真测试 | `npm run test --workspace @wurenji/simulation` |
| 单独运行服务端测试 | `npm run test --workspace @wurenji/server` |
| 单独运行前端测试 | `npm run test --workspace @wurenji/web` |
| 生成轻量物流教学地图 | `npm run map:demo-assets` |
| 地图区域导入 | `npm run map:region:import -- --config path/to/region-config.json --output-root data/map` |
| 地图资源就绪检查 | `npm run map:resources:acceptance` |
| 资源包构建 | `npm run resource:build -- --manifest path/to/descriptor.json --source-dir path/to/package --private-key path/to/key.pem --key-id key-id` |
| 文档包验收 | `npm run document:acceptance` |
| 配置与部署检查 | `npm run deployment:smoke -- --config-only` |
| 本地性能计算 | `npm run performance:baseline` |
| 响应式与 Cesium 视觉检查 | `CHROME_PATH=/path/to/chrome npm run visual:smoke` |
| 无障碍浏览器检查 | `CHROME_PATH=/path/to/chrome npm run accessibility:browser` |

浏览器脚本使用 `playwright-core`，不会自动下载浏览器。设置 `CHROME_PATH` 指向 Chrome/Chromium；应用必须已启动，输出默认写入 `artifacts/`。

## 地图和环境变量

复制 `.env.example` 后按环境填写配置。常用变量如下：

```dotenv
# 服务端
DATABASE_URL=postgresql://wurenji:<password>@localhost:55432/wurenji
V3_FILE_STORAGE_PROVIDER=LOCAL
V3_FILE_STORAGE_DIR=./apps/server/data/v3-files
MAP_DATA_DIR=./data/map
WEB_ORIGIN=http://localhost:3000,http://localhost:5173

# 前端地图
VITE_MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
VITE_LOGISTICS_OFFLINE_IMAGERY_URL=/map/logistics/gd-north-core-orthophoto.jpg
VITE_LOGISTICS_BUILDINGS_URL=/map/logistics/gd-north-core-buildings.geojson
VITE_CESIUM_ION_TOKEN=
VITE_DEM_TERRAIN_URL=
VITE_ENABLE_WORLD_IMAGERY=true
VITE_ENABLE_WORLD_TERRAIN=false
VITE_ENABLE_OSM_BUILDINGS=false
```

地图使用说明：

- 不配置 Cesium ion 时，二维/三维仍可使用椭球地面和仓库内置教学资源；外部瓦片不可用时，页面回退到本地网格和区域资源。
- 配置 ion Token 后可以启用 World Imagery、World Terrain 和 OSM 3D Buildings。Token 应只允许访问所需资源，并限制域名；修改后必须重新构建前端。
- 正式区域资源应通过资源包导入流程提供范围、版本、坐标系、SHA-256 和高程基准。正式任务不能用缺少建筑或地形的临时文件代替。

## 生产部署

生产部署使用 HTTPS 网关、内部应用、PostGIS、MinIO、Worker 和可选地图服务。先在部署主机准备 `.env`、TLS 证书目录和受信资源包公钥，再执行：

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.production.yml \
  --profile production --profile worker \
  up -d --build
```

生产配置至少应满足：

- `NODE_ENV=production`、`SEED_DEMO_DATA=false`、`TYPEORM_SYNCHRONIZE=false`。
- 设置长度足够的 `JWT_SECRET`、`ONLYOFFICE_JWT_SECRET`、数据库和 MinIO 密钥。
- `WEB_ORIGIN` 使用 HTTPS；`COOKIE_SECURE=true`，反向代理场景按实际设置 `TRUST_PROXY=true`。
- `V3_FILE_STORAGE_PROVIDER=MINIO`，配置 MinIO 访问参数和 `MINIO_BUCKET`。
- 配置 `RESOURCE_PACKAGE_TRUSTED_KEYS_FILE` 或 `RESOURCE_PACKAGE_TRUSTED_KEYS_JSON`，关闭未签名资源注册。
- 证书放在部署主机的 `TLS_CERT_DIR`，不提交证书和私钥。

生产只对外开放 Nginx 网关的 80/443 端口。部署检查、备份恢复、升级和回滚说明见 [`deploy/README.md`](deploy/README.md)。

## 运行规模与现场验收

本地测试和短时脚本不能代替学校目标环境的显卡、浏览器、正式地图、并发人数和长时运行记录。仓库提供的主要目标规模为：

- 表演：浏览器夹具 3000 架；5000 架仅作为后续聚合扩展，不属于当前任务发布和验收门槛。
- 物流：50 架、100 单。
- 垂起巡检：20 架。
- 班级并发：至少 20 名真实学生账号。
- 长时运行：三个场景各至少 30 分钟，运行会话必须在采样期间保持 `RUNNING`。

示例命令：

```bash
# 目标环境浏览器运行（需先准备登录账号、任务和 Chrome）
ACCEPTANCE_TARGET_LABEL=target-lab \
BROWSER_PERF_DURATION_MS=1800000 \
BROWSER_PERF_REQUIRE_FORMAL_SCALE=true \
BROWSER_PERF_REQUIRE_LONG_RUN=true \
BROWSER_PERF_REQUIRE_RUNNING_SESSION=true \
RUNTIME_SCENE=ALL \
npm run performance:browser-runtime

# 生成当前环境的运行材料汇总
ACCEPTANCE_TARGET_LABEL=target-lab npm run acceptance:evidence
```

表演、物流和垂起夹具准备、班级并发、地图资源、备份恢复、升级回滚及现场签字文件的变量和命令，统一以 [`docs/低空无人集群仿真实训系统技术设计与验收方案.md`](docs/低空无人集群仿真实训系统技术设计与验收方案.md)、[`docs/实施待办清单.md`](docs/实施待办清单.md) 和 [`docs/开发交付记录.md`](docs/开发交付记录.md) 为准。验收汇总只接受同一 `ACCEPTANCE_TARGET_LABEL` 下的新报告，不把静态历史数字当作本次结果。

备份命令（已启动本地数据库和 MinIO 时）：

```bash
npm run backup:create
npm run backup:verify -- --input data/backups/20261004T120000Z
npm run backup:restore -- --input data/backups/20261004T120000Z --confirm RESTORE
```

严格恢复会清空目标数据库和文件，必须另加脚本要求的确认参数，并在目标环境执行。

## 文档入口

| 内容 | 文档 |
| --- | --- |
| 文档总目录 | [`docs/README.md`](docs/README.md) |
| 教师/学生完整操作 | [`docs/低空无人集群教学仿真软件-完整操作手册.md`](docs/低空无人集群教学仿真软件-完整操作手册.md) |
| 三场景任务和指标计算 | [`docs/教学任务与三场景题库设计实施说明.md`](docs/教学任务与三场景题库设计实施说明.md) |
| 系统设计和实施 | [`docs/系统设计与实施方案.md`](docs/系统设计与实施方案.md) |
| 技术设计与现场验收 | [`docs/低空无人集群仿真实训系统技术设计与验收方案.md`](docs/低空无人集群仿真实训系统技术设计与验收方案.md) |
| 地图资源架构 | [`docs/城市物流无人机离线地图改造总体架构.md`](docs/城市物流无人机离线地图改造总体架构.md) |
| 当前交付记录 | [`docs/开发交付记录.md`](docs/开发交付记录.md) |
| 当前改进和回归入口 | [`docs/本轮改进与验收说明.md`](docs/本轮改进与验收说明.md) |
| 目标环境待办 | [`docs/实施待办清单.md`](docs/实施待办清单.md) |
| 生产部署 | [`deploy/README.md`](deploy/README.md) |

## 当前边界

系统面向教学方案设计和运行分析，当前不包含真实飞控、机载通信、厘米级动力学、真实气象预报、自动最优调度或真机安全放行。建筑、地形和影像结果取决于绑定的区域资源版本；没有正式资源时只能使用仓库内的轻量教学区。请先完成目标环境资源、容量、浏览器、证书、备份恢复和回滚验证，再用于正式课程交付。
