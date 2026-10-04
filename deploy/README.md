# 生产部署说明

本目录提供生产 Compose 覆盖文件和 Nginx 网关配置，要求 Docker Compose 插件 `>=2.24.4`。部署前先完成根目录 [`README.md`](../README.md) 的环境准备、资源包导入和配置检查；本文件不包含密钥，也不能替代学校现场的容量、备份和回滚验证。

## 部署组成

生产组合包含：

- `db`：PostgreSQL 17 + PostGIS；
- `migrate`：执行已提交的数据库迁移；
- `app`：NestJS API 和前端静态文件；
- `minio`：V3 文件资产、报告和导入包对象存储；
- `worker`：Outbox 作业、DOCX/PDF 报告生成和租约重试；
- `map-service`：只读区域地图资源；
- `gateway`：HTTPS、API 代理和地图代理。

生产环境没有演示账号自动创建，`SEED_DEMO_DATA` 必须为 `false`。课程、班级、教师、学生、区域资源包和任务应通过正式数据准备流程导入。

## 准备配置

在部署主机的仓库目录创建 `.env`，不要把它提交到 Git、工单或截图。至少配置：

| 变量 | 说明 |
| --- | --- |
| `NODE_ENV` | 固定为 `production` |
| `PRODUCTION_DATABASE_URL` | 生产 PostGIS 连接串，供 migrate、app、worker、backup 共用 |
| `POSTGRES_PASSWORD` | 数据库容器初始化密码；使用已有外部数据库时仍需按 Compose 配置提供 |
| `JWT_SECRET` | 登录会话签名密钥，长度至少 32 个字符 |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | MinIO 访问凭据 |
| `MINIO_BUCKET` | 业务文件桶，默认 `wurenji` |
| `WEB_ORIGIN` | 对外 HTTPS 来源，多个来源用逗号分隔 |
| `COOKIE_SECURE` / `TRUST_PROXY` | 生产应为 `true`，由 HTTPS 网关终止 TLS |
| `SEED_DEMO_DATA` | 固定为 `false` |
| `TYPEORM_SYNCHRONIZE` | 固定为 `false` |
| `RESOURCE_PACKAGE_TRUSTED_KEYS_FILE` 或 `RESOURCE_PACKAGE_TRUSTED_KEYS_JSON` | 资源包签名公钥；生产禁止未签名资源注册 |
| `ONLYOFFICE_PUBLIC_URL` / `ONLYOFFICE_JWT_SECRET` | 需要在线 DOCX 处理时配置 |
| `TLS_CERT_DIR` | `fullchain.pem` 和 `privkey.pem` 所在目录 |

生产应用固定使用 `V3_FILE_STORAGE_PROVIDER=MINIO`。`MAP_DATA_DIR` 应指向部署主机挂载的只读地图目录；`map-service` 对外只提供 `/map/` 下的静态资源。

## 启动

证书目录中准备 `fullchain.pem` 和 `privkey.pem` 后，在仓库根目录执行：

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.production.yml \
  --profile production --profile worker \
  up -d --build
```

Compose 会先等待数据库和迁移完成，再启动应用。网关地址为 `https://<host>/`；健康检查为：

- `https://<host>/healthz`：应用进程存活；
- `https://<host>/readyz`：数据库、迁移和依赖就绪；
- 地图资源服务存活：在部署主机执行 `docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml exec map-service wget -qO- http://localhost/map-healthz`。

生产只将网关的 80/443 端口暴露给用户。PostgreSQL、MinIO、OnlyOffice、Worker 和 map-service 不应直接暴露到校园网络。

## Worker 与文档服务

没有 Worker 时，运行会话和常规 API 仍可工作，但报告作业不会被消费。需要报告时启用 `worker` profile，并检查：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml --profile worker ps
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml --profile worker logs --tail=100 worker
```

OnlyOffice 属于可选组件，仅在在线文档编辑或 DOCX 处理流程启用：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml --profile office up -d onlyoffice
```

## 地图资源

正式区域资源包应通过导入流程写入 `MAP_DATA_DIR`，包含版本、范围、坐标系、建筑数据、障碍物、禁限飞区、起降点以及有效高程或明确的椭球地面策略。缺少任务要求的建筑或高程时，服务端会拒绝相应的可判定结果；不能用临时空文件代替正式资源。

导入和检查示例：

```bash
npm run map:region:import -- \
  --config path/to/region-config.json \
  --output-root data/map
npm run map:resources:acceptance
```

部署后确认 `map-service` 能读取目标区域文件，并检查应用返回的地图资源版本与任务绑定版本一致。

## 备份与恢复

备份必须在停止业务写入或已确认一致性的窗口执行。Docker 部署使用备份容器，以便访问命名卷和 MinIO：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml --profile backup run --rm backup create
# 验证指定恢复点
# docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml --profile backup run --rm backup verify --input /app/backups/<恢复点目录>
```

恢复前先停止 `app`、`worker` 和网关写入，再执行：

```bash
docker compose ... run --rm backup restore \
  --input /app/backups/<恢复点目录> \
  --confirm RESTORE
```

严格恢复会重建数据库并清空业务文件，需要额外的 `--mode EXACT --confirm-exact REPLACE_DATABASE_AND_FILES`。恢复后必须检查 `/readyz`、文件资产引用、地图资源和三种场景任务。恢复点目录、数据库 dump、对象文件、密钥和证书不得上传到 GitHub。

## 更新与回滚

更新前创建恢复点并记录当前镜像版本；更新后依次检查迁移、`/readyz`、Worker、MinIO、地图服务和登录流程。仓库提供的软件发布脚本会生成带镜像、迁移和部署文件的发布目录：

```bash
npm run software:build -- --version 0.1.0
npm run software:verify -- --input data/software-releases/wurenji-0.1.0
```

发生故障时，只能使用发布目录中的安装状态和恢复点执行回滚；不要直接修改已发布任务的资源版本或数据库结构。

## 验收记录

现场验收至少覆盖：

- 表演 100/500/1000/3000 架模板，5000 架不属于 V1.0 任务范围；
- 物流 50 架、100 单；
- 垂起巡检 20 架；
- 三个场景的建筑/高程资源、事件处置、结果指标和报告；
- 至少 20 名学生账号并发和每场景 30 分钟运行；
- 备份校验、恢复演练、升级和回滚。

浏览器验收脚本需要目标环境已启动、Chrome/Chromium 已安装、`CHROME_PATH` 已设置并准备登录账号和场景夹具。脚本输出放在 `artifacts/`，不能把没有目标环境运行记录的静态数字写入验收报告。
