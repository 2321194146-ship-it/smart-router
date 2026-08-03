# ASYNC_FAILURE_ISOLATION_REPORT.md

Smart Router Mainline - Phase 2-B Shadow 异步异常隔离

## 1. 问题（修复前）

协议层调用 `context.intelligence.suggest(...)` 未 await，外层同步 try/catch 无法捕获
Promise 拒绝 → 可能产生 unhandledRejection；且 Suggestion 未落库时 Execution 可能已 Finalize。

## 2. 修复（方案A）

```js
// 5 个协议处理器（chat / chat-stream / responses-stream / anthropic / anthropic-stream）
if (context.intelligence && typeof context.intelligence.suggest === 'function') {
  try {
    await context.intelligence.suggest({ requestId, body: patchedBody, agentId, budget, candidates, protocol });
  } catch (_e) {
    // Shadow 层失败不影响主流程；错误必须有明确日志
    process.stderr.write(`[shadow_error] suggest failed for ${requestId}: ${_e.message}\n`);
  }
}
```

- `await` 保证 **Suggestion 落库后 Execution 才可能 Finalize**（不出现"已 Finalize 但建议未创建"）。
- Shadow 仅本地计算 + 同步 SQLite 写入（DatabaseSync），await 不产生明显网络延迟。
- 方案B（fire-and-forget）未采用；方案A 语义更强。

## 3. 数据库写入失败测试（集成测试 2）

破坏 `store.saveShadowDecision` 抛错后：

| 断言 | 结果 |
| --- | --- |
| 用户请求返回 200（不受影响） | ✅ |
| 响应内容正常（DB_OK） | ✅ |
| Phase1 路由不受影响（finalize 正常完成） | ✅ |
| 无 unhandledRejection（协议层 try/catch 捕获） | ✅ |
| 错误有明确日志（`[shadow_error] suggest failed ...`） | ✅（代码路径验证） |
| 不生成半条 Shadow 记录（shadow_decisions 空） | ✅ |

单元测试同样覆盖：`suggest` DB 失败时异常向上传播由调用方捕获、无半条记录、off 模式不受影响。

## 4. Finalizer 观察者隔离（Phase2-A 延续）

`finalizer.addObserver(async (auditRecord) => intelligence.recordFinalized(auditRecord))`
在事务成功提交后触发；观察者异常被吞掉并记录日志，不影响用户请求与 Phase1 执行结果。
单测注入抛错观察者 → finalize 仍成功。

## 5. 结论

异步异常隔离达标：用户请求、Phase1 路由、日志完整性、无半条记录全部验证通过。
