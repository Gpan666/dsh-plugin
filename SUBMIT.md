# 提交步骤（awesome-dsh-plugin）

按 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 整理。**提交只需要一个文件**：`data/plugins/<owner>__<repo>.yml`。

## 前置条件（都要满足，否则 CI 会拦）

| 条件 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ 已加，`"bundle": { "patch": "./cordis.patch.yml" }` |
| 仓库根有 `cordis.patch.yml` | ✅ 已加 |
| 官方 `@deepseek-ai/*` 用 `peerDependencies` | ✅ 已改（`@deepseek-ai/schemastery` 保留在 `dependencies`，它不是官方 peer 必需） |
| 预发布版本用显式 `\|\|` 分支 | ✅ `>=4.1.0-0 <5.0.0-0` 本身已带 `-0`，覆盖预发布 |
| 仓库创建满 **1 天** | ⏳ 需真实仓库 |
| 加 `dsh-plugin` topic | ⏳ 需真实仓库 |
| 真实可用代码 | ✅ 35 个测试，无占位 |

## 第 1 步：建仓库并推上去

```bash
cd D:\Downloads\Archive\dsh-plugin-model-failover
git remote add origin https://github.com/<你的用户名>/dsh-plugin-model-failover.git
git branch -M main
git push -u origin main
```

然后在 GitHub 仓库页面 **About** 右侧点 ⚙️，添加 topic：`dsh-plugin`。

## 第 2 步：fork 列表仓库

```bash
# 在 GitHub 上 fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
git clone https://github.com/<你的用户名>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b add-model-failover
```

## 第 3 步：放条目文件

新建 `data/plugins/<你的用户名>__dsh-plugin-model-failover.yml`：

```yaml
url: https://github.com/<你的用户名>/dsh-plugin-model-failover
name: <你的用户名>/dsh-plugin-model-failover
category: model
description:
  en: Switches to the next healthy model candidate before the next agent step when the current model has been marked unhealthy.
  zh: 当前模型被判定不可用时，在下一步执行前切换到下一个健康的候选模型。
```

把 `<你的用户名>` 全部替换成真实用户名。文件名规则：`<owner>__<repo>.yml`（两个下划线）。

**不要手改 `README.md` / `README.zh.md`** —— 它们是生成的。

## 第 4 步（可选）：本地预览

```bash
npm ci
node scripts/generate-readme.mjs
```

我自己跑过这一步，条目正确出现在两个 README 的 `model` 分类下：

```
README.md:2972: - [example-owner/dsh-plugin-model-failover](...) - Switches to the next healthy model candidate...
README.zh.md:2972: - [example-owner/dsh-plugin-model-failover](...) — 当前模型被判定不可用时，在下一步执行前切换到下一个健康的候选模型。
```

## 第 5 步：提 PR

```bash
git add data/plugins/<你的用户名>__dsh-plugin-model-failover.yml
git commit -m "Add dsh-plugin-model-failover"
git push origin add-model-failover
```

在 GitHub 开 PR 到 `awesome-dsh-plugin:main`，一个 PR 一个条目。

## CI 会检查什么

1. 条目数量 ≤ 3（我们只 1 条，通过）
2. `dsh.bundle` 能被读到（✅ 已声明）
3. 仓库年龄 ≥ 1 天（⏳ 新建仓库要等）
4. `awesome-lint` + 站点构建（双语一致性、分隔符、日期）

失败会在 PR 评论里指出具体改什么，同一个分支推送修复即可，不用重开 PR。

## 关于描述准确性的提醒

贡献指南特别强调：**描述会被当作声明，并与代码核对**。夸大是本来不错的插件被打回的主要原因。

所以上面那两句英文/中文描述我写得比较克制：

- 说的是「下一步执行前切换」，**不是**「同一轮失败后自动续答」——后者做不到（原因见 README 的能力边界章节）
- 没有用「高可用」「永不中断」这类营销词
- 没有承诺任何不存在的命令或 API

如果维护者问细节，可以直接把 README 里那段「为什么同轮换模型做不到」的源码分析贴过去，这反而是加分项。

## 分类选择

选了 `model`。理由：插件做的事就是模型选择——检测模型健康度并切换。不选 `dev` 或 `tools`，因为那些是开发工具和通用工具，与模型路由无关。

贡献指南说选不准也不会被打回，维护者会直接改，所以不用纠结。

## 可选：截图

如果想在市场详情页展示截图，在**你自己仓库**的 `package.json` 旁放 `screenshots.json`：

```json
["assets/screenshot-1.png"]
```

现在没有 GUI，暂时不需要。
