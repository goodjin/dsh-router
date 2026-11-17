# IQuest-Q1 系统提示词指令被项目文件覆盖

## 问题

派发规则写在系统提示词（system/message，第 10 行）中，明确要求"多步骤任务必须用 subagent 工具派发子会话执行"。模型请求中携带了 subagent 等 26 条工具（第 14 行 request/header）。

但模型首个动作是 read 项目内的 AGENTS.md，随后按该文件中的工作流程自行执行完毕，全程未调用 subagent 或任何协作工具。

即：模型将项目级 AGENTS.md 的指令优先级置于系统提示词之上。

## 环境

- 模型：iquest / iquest-q1（IQuest-Q1）
- 会话：session-b6bef176-c900-4545-93da-fc847e088615
- 时间：2026-11-16T18:18+08:00
- 宿主：DeepSeek Harness 0.2.1-rc.2

## 日志

`iquest-q1-delegation-failure.jsonl`，158 条事件，已脱敏。关键行：
- 第 10 行：系统提示词（含派发规则）
- 第 14 行：工具列表（含 subagent）
- 第 17 行起：模型直接 read AGENTS.md 并自行执行