# 项目约束

本仓库是 `weather-mcp/weather-mcp` 的 fork；上游开发约定保存在
`docs/AI_ASSISTANT_GUIDE.md`，改动前同时阅读 `README.md`、`CHANGELOG.md`、
`FORK.md` 和该文件。优先新增 fork 专用文件，减少与上游冲突。

## HTTP 鉴权

- stdio 入口保持无鉴权、单用户语义；本节只约束托管的 Streamable HTTP 入口。
- HTTP 入口只有 OIDC OAuth（2026-09-21 起 IdP 是 Logto，此前是 Auth0），没有 URL key、query key、静态 Bearer key 或配置错误时的退路。
- **配置只给 `WEATHER_OIDC_ISSUER`（完整 issuer URL，尾斜杠跟 discovery 一致：Logto `https://auth.laputa.one/oidc` 不带）**，
  JWKS 地址从 `<issuer>/.well-known/openid-configuration` 读，签名算法放行非对称算法（Logto 签 ES384），
  **HS\* 和 none 永远不收**。discovery 读不到或 issuer 对不上时返回 unavailable（fail closed），下个请求重试。
  旧的 `WEATHER_AUTH0_DOMAIN` / `WEATHER_AUTH0_AUDIENCE` 还在环境里时启动直接报错，不静默忽略。换 IdP 只改环境变量。
- `WEATHER_OIDC_AUDIENCE` 必须与 `<WEATHER_PUBLIC_BASE_URL><WEATHER_HTTP_PATH>`
  完全一致，生产固定为 `https://weather.laputa.one/mcp`，不带尾斜杠。
- Weather 自己先校验 JWT 的签名、issuer、audience、expiration 和 sub，随后把
  原 token 转发到 Garmin 私网 `/internal/weather/identity`。Garmin users 表是唯一
  使用白名单；未知或停用用户拒绝，授权服务不可用时 fail closed，不缓存授权结果。
- Garmin slug 默认就是 Weather tenant id；例外只允许通过
  `WEATHER_TENANT_ALIASES_FILE` 显式映射。当前唯一历史映射是 `user4 -> lihao`。
- tenant id 决定 saved-location 目录和限流桶。任何鉴权改动都必须验证不同用户的
  locations 互不可见，且日志、异常和响应不包含 access_token、sub 或服务器路径。
- `/.well-known/oauth-protected-resource/mcp` 位于域名根，`resource` 必须与 audience
  一字不差。MCP 客户端地址固定 `/mcp`；`/mcp/<key>` 必须 404。

## 部署

- Weather 与 Garmin api 只通过外部 Docker 网络 `mcp-internal` 相互通信；两者同时保留
  各自的 `default` 网络，用于公网 API 出站访问和宿主机 loopback 端口发布。
- OpenResty 必须对公网 `/internal/` 返回 404；Weather 公网只暴露 `/mcp`、OAuth
  metadata、根说明和 `/healthz`。
- 生产切换前备份 `config` 与 `data`，不修改既有 `locations.json`。OAuth 真机通过后
  才撤销旧 key；回滚使用旧镜像和配置备份，不在新代码中恢复 key 旁路。

## 验证

- HTTP 鉴权或 tenant 改动至少运行：`npm run build`、HTTP/OAuth 定向测试和完整
  `npm test`。
- 必测缺失/伪造/过期/错误 audience token、未知/停用用户、Garmin 授权服务故障、
  metadata、旧 key 失效、限流隔离、saved-location 隔离与 `user4 -> lihao`。
