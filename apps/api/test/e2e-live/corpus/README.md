# 真实 DeepSeek 端到端验收（AI 能力口径）

本目录承载**真实模型端到端与盲测验收**，与 CI 里的 Mock 机制测试（`npm run test`）**分开运行、分开报告**。

- 运行：`npm run test:e2e:live`（需先在环境变量配置真实个人模型）。
- 配置：`JIT_AI_API_BASE`（如 `https://api.deepseek.com/v1`）、`JIT_AI_MODEL`（如 `deepseek-chat`）、
  `JIT_AI_API_KEY`。三者缺一，验收**判定为不通过**（`assert.fail`），**不会 skip 蒙混过关**——
  Mock 全绿不能代替 AI 能力验收。

## 语料

- `自然语言问法集.md`：开发期可见的同义 / 口语 / 开放式问法集。
- `heldout-盲测集.md`：与开发实现**隔离维护**的盲测集，验收时临时喂入。

## 断言口径（只按机制，绝不绑定固定串 / 关键词 / 正则）

对每条真实问题，验收只检查以下机制事实：

1. **是否调用 AI 规划**：`payload.plannerCall.attempted === true`，规划成功时 `status === 'success'`。
2. **证据是否非空且经权限过滤**：有依据的问题产生 `payload.sources`，每条来源都能追溯到真实档案/附件/位置。
3. **citation 是否全部可追溯**：任何 `claims` 的引用 ref 都能回溯到真实来源；无来源不得给出内容型论断。
4. **无依据问题是否正确拒答**：语料中不存在事实的问题必须落到 `content_no_evidence` / 澄清，绝不编造。
5. **越权数据是否绝不泄漏**：borrower 提问 restricted 档案内容时正文绝不出现涉密标记串。
6. **数字是否与数据库一致**：清单 / 统计的权威数字来自数据库 `inventory`，模型只叙述不改写。

运行结束打印两张独立表：`机制正确性（Mock，见 npm run test）` 与 `AI 能力（真实 DeepSeek，本脚本）`，
后者逐条显示**实际模型调用次数**、证据来源数、citation 可追溯率。


本轮验收约定（2026-11-01）：

- `golden-expectations.json` 为原 18 题逐项记录检索范围、关键事实、证据来源和应有行为；`capability-cases.json` 补充附件标题、描述性召回、项目进展、多附件长文和开放问题。
- 这些文件已由实施者检查，因此 `independentBlind` 为 false。可通过 `JIT_AGENT_BLIND_CORPUS` 提供独立验收人维护的 JSON 数组，各项含 tag/actor/question/expected，不将问题写入生产规则。
- `npm run test:e2e:live --workspace apps/api` 同时执行真实 DeepSeek、Embedding 网络探测及隔离数据库端到端问题集。必须配置独立 `JIT_EMBEDDING_API_BASE/MODEL/API_KEY`；缺失会明确失败，绝不使用 Mock 或 skip 代替联合验收。
- summary/compare/reference 有真实资料时必须完成可追溯回答；不能把空证据或拒答算作能力通过。multi 还检查每个附件所有分块及全部生成批次。
- 历史问题、合成新增问题和真正独立盲测必须分别报告；构建通过不能替代模型能力验收。
