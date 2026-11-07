# dsh-plugin-model-failover

DSH 的模型故障转移插件：当前模型变得不可用时，**下一步**（或下一条消息）自动换到下一个健康的候选模型。

## 先说清楚它能做到什么、做不到什么

我读了 DSH 的实际源码（`dsh-agent-loop`），把边界写在这里，避免你有错误预期。

### ❌ 做不到：同一轮内失败后换模型继续回复

这不是配置问题，是架构约束：

```js
// dsh-agent-loop/lib/index.js — step() 内部的重试循环
while (true) {
  const { config } = await this.prepareRequest(turn, step, decision.selection, signal)
  //                                                              ^^^^^^^^^^^^^^^^ 固定不变
  ...
  if (finish.kind === 'error') {
    const action = await dispatch.waterfall('agent/request-error', { ... })
    if (action?.kind !== 'retry') throw new LlmError(...)
    continue    // ← 回到顶部，但 decision.selection 还是同一个
  }
}
```

四点关键事实：

1. `decision.selection` 在整个 `step()` 生命周期内**固定**，`step` 编号也不变。`continue` 之后仍传入同一个 selection，**所以 retry 只会重发同一个模型**。
2. `prepareRequest()` 里有硬校验：`agent/request` 里改 provider/model 会直接抛
   `use agent.model.select() before step preparation`。
3. `step()` 抛错后主循环立刻 `turnEnds = {kind:'error'}` 并 `throwError`，**本轮结束**。没有「本步失败但继续下一步」的路径。
4. `agent.model.select()` 只是往 session 追加一条 `model/selection`，而 `preStep()` 开头 `this.model.current()` 读它。所以 **select() 只对下一次 preStep 生效**，对已在 `step()` 内的重试无效。

另外 loop 走的是 `preparedCall?.stream(request) ?? llm.stream(request)`；正常情况 `prepareCall` 成功，**完全绕过 `llm/stream` waterfall**，所以拦 `llm/stream` 也改不了 agent 的模型。

要做到同轮换模型，只能改 agent loop 本身（让 `request-error` 后能重新进入 `preStep`），那是 fork DSH，不是插件。

### ✅ 做得到

| 能力 | 机制 |
|---|---|
| **跨轮/跨步故障转移** | `agent/pre-step` 里若当前模型处于冷却，调 `agent.model.select()` 换到下一个健康候选 |
| **失败即时降级** | 监听 `agent/request-error` 记账，该模型立刻进入冷却，下一步不再选它 |
| **配置类错误直判** | `AUTH` / `NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_MODEL_INFO` 重试无意义，直接冷到上限 |
| **后台探活** | 定期打 1 token 请求，提前发现掉线模型 |
| **粘滞** | 当前模型健康就不换，避免回复风格跳变、保住 KV 缓存 |
| **指数退避** | 首次冷却 60s，逐次翻倍，受 `maxCooldownSec` 截断 |

## 如果这条回复不能丢，请同时装 `dsh-llm-retry`

两者互补：

- **`@deepseek-ai/dsh-llm-retry`** 负责**同一个模型重试**，救得回限流、5xx、超时这类抖动（在 `step()` 内重发）。
- **本插件**负责**模型整体挂了就换掉**，让下一条/下一步用健康的模型。

本插件默认**不抢** retry，先 `next()` 交给下游，让 llm-retry 先用它的预算。它用尽后失败才终止本轮。

## 安装

```bash
# 在你的 profile 目录
pnpm add dsh-plugin-model-failover
```

然后在 profile 的 `cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: model-failover
      name: 'dsh-plugin-model-failover'
```

需要 `cordis` 提供 `agents` 服务（DSH 默认有）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `candidates` | 两个 deepseek 模型 | 候选表，一行一个 `provider/model`，`#` 后为注释 |
| `failureThreshold` | `1` | 连续失败几次判坏 |
| `cooldownSec` | `60` | 初始冷却，逐次翻倍 |
| `maxCooldownSec` | `600` | 冷却上限 |
| `sticky` | `true` | 健康就不换 |
| `probeTimeoutSec` | `8` | 单次探活超时 |
| `probeIntervalSec` | `120` | 探活周期 |
| `claimRetry` | `false` | `true` 时本插件接管 `request-error` 的重试（**注意仍是同一模型重发**） |
| `restoreOnStart` | `true` | 预留：启动恢复历史健康记录 |

候选写法（三种等价）：

```
deepseek-official/deepseek-v4-flash
deepseek-official|deepseek-v4-flash
deepseek-official deepseek-v4-flash
```

## 服务接口

插件加载后暴露 `modelFailover` 服务：

```js
const svc = ctx.get('modelFailover')
svc.status()          // { enabled, candidates: [{provider, model, ok, coolingDown, ...}], lastSwitch }
svc.probe()           // 立刻探活一遍
svc.reset()           // 清空健康记录
svc.updateSettings({ candidates: '...' })   // 运行中改配置，不重启
```

## 会访问哪里

- 探活请求走 DSH 自己的 `llm` 服务（你已在用的模型接口），不连任何第三方。
- 本插件不写盘、不读 Cookie、不碰消息内容。

## 已知限制

- **探活花 token**：每次 1 token。默认 120 秒周期 + 2 个候选 ≈ 一天 1440 次调用。嫌贵就把 `probeIntervalSec` 调长或只留一个候选。
- **切换只在 step 边界生效**：见上文「做不到」。
- **`claimRetry` 是同一模型重发**：它只控制重试次数归谁管，不会换模型。
- 健康状态目前只在内存，重启后重置（`restoreOnStart` 为后续持久化预留）。

## 许可

MIT
