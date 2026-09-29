# Smart Router 模块化版部署说明（6.2.1）

> 本目录是 **模块化重构版**（Smart Router 6.2.1，新增 OpenAI Responses API / Codex 兼容）。它不是对旧生产服务的原地升级包，
> 而是一个独立可部署的构建。请严格按本文档中的端口与验收规则操作。

---

## 一、端口与运行环境（重要）

| 端口 | 用途 | 说明 |
|------|------|------|
| **7878** | **旧生产服务** | 当前正在运行的旧版智能路由网关。**请勿停止、修改或占用此端口。** 本交付物在验收前不得接管 7878。 |
| **17878** | **模块化新版测试端口** | 仅用于验证本 6.2.1 构建。通过 `PORT=17878` 独立启动，与 7878 互不干扰。 |

**未经人工验收，禁止用本构建替换 7878 旧生产服务。**

---

## 二、交付包内容（已清理，不含敏感信息）

交付的 `smart-router-6.2.1-responses-stable-candidate.zip` 已剔除以下内容，可安全分发：

- ❌ `config/config.local.json`（本地占位）
- ❌ 真实 `config/config.json`（仅保留脱敏的 `config/config.example.json`）
- ❌ `.env`、真实 API Key、管理员 Token
- ❌ `data/`（含 `*.db` 运行数据）
- ❌ `node_modules/`（原生模块 `better-sqlite3` 需在目标机编译）

保留：源码 `src/`、仪表盘 `frontend/dist/`、脱敏模板 `config/config.example.json`、`start.sh`、`DEPLOY.md`、依赖声明 `package*.json`。

---

## 三、部署步骤

1. **解压**
   ```bash
   unzip smart-router-6.2.1-responses-stable-candidate.zip -d smart-router
   cd smart-router
   ```

2. **（可选）生成运行时配置**
   `start.sh` 会在缺少 `config/config.json` 时自动从 `config/config.example.json`
   复制一份脱敏模板。你也可以手动复制后填入真实值：
   ```bash
   cp config/config.example.json config/config.json
   # 编辑 config/config.json：设置 admin_token、各 provider 的 api_key 等
   ```

3. **冒烟验证（用独立测试端口 17878，不碰 7878）**
   ```bash
   PORT=17878 HOST=127.0.0.1 npm start
   ```
   另开终端检查：
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17878/health
   curl -s -H "X-Api-Key: <你的admin_token>" http://127.0.0.1:17878/v1/models
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17878/api/providers
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17878/api/cost
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17878/dashboard
   # Responses API（6.2.1 新增）：缺 input 应返回 400
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer <你的admin_token>" \
     -H "Content-Type: application/json" http://127.0.0.1:17878/v1/responses -d '{"model":"auto"}'
   ```

---

## 四、切换到 7878 生产（仅限验收通过后）

只有在人工逐项确认 17878 测试端口的所有端点、路由切换、鉴权、SQLite 迁移均正常，
并且你**明确决定**接管旧生产服务后，才执行以下步骤：

1. 停止旧的 7878 服务（由你自行操作，本脚本不会自动停止它）。
2. 用 7878 启动本构建：
   ```bash
   PORT=7878 HOST=127.0.0.1 npm start
   ```
3. 验证 7878 端点正常后，方可视为替换完成。

> ⚠️ 任何情况下，自动化流程都**不得**自动停止 7878 或自动接管生产端口。
> 是否替换 7878 必须由人工决策。

---

## 五、关键稳定性行为（6.1.0 起）

- **Provider 级故障快速切换**：5xx / 408 / 网络失败 / 超时 / 地区或策略限制，
  在单 Provider 重试预算用尽后立即跳到下一个 Provider，不再轮流尝试同一故障服务器的所有 Key，
  避免耗尽全局调用上限而饿死健康 Provider。
- **Key 级错误原地换 Key**：401 / 明确 Key 级 403 / 模型权限 403 / 429 只换当前 Provider 的下一个 Key。
- **未知 403 不永久禁用 Key**：无法判断的普通 403 仅临时冷却该 Key（冷却结束后重新可用），
  不再将 Key 置为 `invalid`。明确 `Invalid API key` 仍永久禁用；模型权限 403 仅禁 Key+模型组合；
  地区/策略/临时限制仅做 Provider 冷却。
- **SQLite 迁移幂等且安全**：`cost_daily` 表按主键是否为 `(date, model, provider)` 判定是否需要迁移，
  迁移失败绝不破坏原表，旧数据保留于 `cost_daily_backup`。
