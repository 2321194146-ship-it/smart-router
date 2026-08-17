# Smart Router Mainline

**企业级 LLM 智能编排与成本管理平台。** 按任务复杂度自动调度模型，按人/团队归因成本，把每月 AI 开支从一团乱账变成一张清账。

<p align="center">
  <img src="https://img.shields.io/badge/license-BSL_1.1-blue" alt="BSL License">
  <img src="https://img.shields.io/badge/target-20人团队--企业-10b981" alt="Target">
  <img src="https://img.shields.io/badge/Node.js-22%2B-222222" alt="Node">
</p>

---

## 一句话定位

> **LiteLLM 做的是模型路由，Smart Router 做的是模型编排——前者是瑞士军刀，后者是企业调度大脑。**

---

## 和同行比，差在哪

| 维度 | LiteLLM | One API / New API | **Smart Router** |
|------|---------|-------------------|------------------|
| 核心模式 | 路由（按状态选模型） | Key 分发（计费分账） | **编排（按任务选模型）** |
| 任务理解 | ❌ 不判断复杂度 | ❌ 不判断复杂度 | ✅ 分级调度+兜底 |
| 成本归因 | 按 provider 统计 | 按 key 统计 | **按人/团队/任务类型** |
| 员工管理 | ❌ 无 | 有（key 管理） | **角色+限额+审计** |
| 模型兼容 | 100+ provider | 依赖上游 | 全量（兼容 OpenAI/Anthropic/Responses） |
| 企业部署 | 需自研管理面板 | 需自建 | **开箱即用管理后台** |
| 商业定位 | 开源+云服务 | 商用授权 | **开源吸引 + 企业版授权** |

---

## 核心功能

### 智能编排（编排 ≠ 路由）

- **任务分级**：按 prompt 长度、上下文复杂度、是否带文件/图片，自动判定"简单/标准/复杂"三档
- **模型调度**：简单任务→商汤 flash（快+便宜），标准任务→intern-s1-mini，复杂任务→Qwen 系列
- **自动兜底**：降级模型失败后自动回滚到上一档，员工无感知

### 企业 API 管理

- **按人分配 Key**：每个员工独立 key，独立限额，独立预算
- **角色分级**：管理员/开发者/审计员，不同人看到不同信息
- **模型白名单**：按团队限制可用模型（比如"财务部只能用翻译模型"）

### 成本管控

- **实时成本面板**：按人、按天、按模型、按任务类型多维统计
- **限额与告警**：单人/单月超额自动告警
- **成本归因报告**：自动生成团队月报（谁花了多少、花了什么、合不合理）

### 基础设施级路由

- **多 Provider 容灾**：主模型挂掉自动切备用，30ms 内无感知
- **Circuit Breaker**：坏 key 自动熔断，恢复后自愈
- **智能重试**：429 限流自动冷却 5s 重试（非盲等）
- **健康探测**：60s 全量探测，degraded → down 自动摘除

---

## 开源授权

**BSL 1.1 (4 年 Source Available Restriction)**

- ✅ 免费自用、内部部署、二次开发
- ✅ 个人学习、研究、实验
- ❌ **不得作为商业服务直接提供**（托管 SaaS、代运营等）
- 🔒 商业使用请联系作者获取授权
- 📜 4 年后自动转为 Apache License 2.0

---

## Quick Start

```bash
# 1. 安装依赖
npm ci

# 2. 准备配置
cp config/config.example.json config/local.json
# 编辑 config/local.json：填入你的 API Key

# 3. 启动
npm start

# 4. 验证
curl -s http://127.0.0.1:28788/v1 | head -c 200
```

详细安装见 [Quick Start](#快速开始) 下方。

---

## 技术栈

- **Node.js >= 22**（零第三方运行时依赖）
- **SQLite** 持久化（生产可用，可替换 PostgreSQL）
- **OpenAI / Anthropic / Responses 协议兼容**
- **原生 ESM**，无需打包

---

## 快速开始

### 1. 安装

```bash
npm ci
```

### 2. 配置

```bash
cp config/config.example.json config/local.json
```

编辑 `config/local.json`：
- `providers[].api_key` → 你的真实 API Key
- `server.data_dir` → SQLite 数据目录（默认 `./data`）
- `intelligence.mode` → `off`（关闭）/ `shadow`（建议模式）/ `active_canary`（灰度）

### 3. 启动

```bash
npm start
# 或：node src/index.js config/local.json
```

### 4. 验证

```bash
curl -s http://127.0.0.1:28788/v1/models
```

---

## 企业版

开源版供开发者本地使用。企业版包含：

- Web 管理后台（看板、报表、审计）
- 多租户隔离
- 企业级 SSO / RBAC
- 托管部署（免运维）
- 定制支持与 SLA

企业版咨询请联系作者。

---

## 项目状态

当前版本：**1.0.0-phase2c-active-canary**

- ✅ 智能路由（候选构建 + Fallback 执行 + Circuit Breaker）
- ✅ 多协议兼容（chat / chat-stream / anthropic / responses）
- ✅ 智能层（Decision Engine + Task Analyzer + Budget）
- ✅ 用户管理（虚拟 Key + 角色 + 限额）
- ✅ 成本追踪（按 requestId 去重）
- ✅ 企业级管理后台（待上线）
- 📋 任务复杂度分级调度（编排核心，2.0）
- 📋 PostgreSQL 存储支持（3.0）