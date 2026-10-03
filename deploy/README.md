# 部署说明

## 本地启动

在仓库根目录执行 `npm run setup` 生成本地 `.env`，再运行 `docker compose up -d --build`。`.env` 只保存在部署主机，不提交到版本库，也不要复制到日志、工单或截图中。

## 生产配置

生产环境通过 `deploy/docker-compose.production.yml` 覆盖开发配置。请在部署主机的 `.env` 中配置下表变量，并按现场密钥管理制度保存真实值：

| 变量 | 用途 |
|---|---|
| `NODE_ENV` | 运行环境，生产设置为 `production` |
| `PRODUCTION_DATABASE_URL` | 生产数据库连接配置 |
| `POSTGRES_PASSWORD` | 数据库容器初始化配置 |
| `JWT_SECRET` | 登录会话签名密钥 |
| `ONLYOFFICE_JWT_SECRET` | 文档服务回调签名密钥 |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | 对象存储访问配置 |
| `WEB_ORIGIN` | 对外 HTTPS 来源 |
| `COOKIE_SECURE` / `TRUST_PROXY` | HTTPS Cookie 与代理信任开关 |
| `SEED_DEMO_DATA` | 生产设置为 `false` |
| `RESOURCE_PACKAGE_TRUSTED_KEYS_FILE` 或 `RESOURCE_PACKAGE_TRUSTED_KEYS_JSON` | 资源包签名公钥 |
| `ONLYOFFICE_PUBLIC_URL` | 文档服务对外访问地址 |

生产门禁会校验密钥长度、HTTPS 来源、安全 Cookie、关闭演示数据、关闭 TypeORM 自动同步和资源包签名配置。不要把真实值写入 Compose 文件或源码。

## HTTPS 证书

生产网关需要由学校或组织认可的证书。请在部署主机按 `deploy/nginx` 配置要求准备证书文件，并限制证书目录权限；证书和私钥只从受信任的证书机构或校内 PKI 获取，不在仓库中生成、提交或共享私钥。

启动生产网关：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml --profile production --profile worker up -d --build
```

健康检查：`/api/healthz` 和 `/api/readyz`。Worker、备份、升级回滚命令参见根目录 `README.md` 的对应章节；所有备份和恢复操作均应在目标环境执行并保留审计记录。
