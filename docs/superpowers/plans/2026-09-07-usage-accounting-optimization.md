# 用量与计费统计复核后的优化方案

**状态：方案 A–C 与文档口径已随 #90 落地（2026-09-20）；本文件保留为当时的设计记录。**

**复核基线：** pi-subagents 0.69.0；仓库开发依赖 pi-coding-agent 0.81.1；本机 pi-coding-agent 0.85.1 仅作兼容性对账，当时不提升 peer 支持上限（0.7.1 发版时另行按 pi 0.86.0 实测放宽，见 CHANGELOG）。0.69.0 的证据来自带版本标注的本地源码/fixture，属于 `wired`，不等同于真实包安装后的 runtime-certified。

**范围：** `extensions/tps.ts`、`extensions/tps-subagent.ts`、`extensions/tps-subagent-bridge.ts`、`extensions/tps-usage-inlets.ts`、`extensions/usage/` 及相关 focused tests；同步当前 ownership/compat 文档和历史设计快照中的当前口径。

## 1. 目标与非目标

### 1.1 目标

1. pi-subagents 0.69 的 `bg_wait`、async-complete、foreground-complete 与 `_meta.json` 到达时，同一 child 的 token/call/cost 只进入一次；没有当前 session 可验证 ownership 的 run 不得被 `bg_wait` 结果新绑定。
2. 通用工具的 `tool_execution_update` 与 `tool_execution_end` 使用明确的 progress/final identity；终态没有 usage 时，provisional progress 不进入最终账本。
3. Pi 顶层 `result.usage` 的 numeric cost 与完整、可验证的 cost object 都有确定的质量口径，并与本扩展的 `/calls` 统计保持可解释的 parity；未知 model id 不因默认费率产生金额，zero cost 能保留 `reported` 质量。
4. 保持当前 origin-turn 绑定、meta/tool 分离 revision、TUI-only collector 和 fail-closed 外部覆盖边界。
5. 保持对 pi-subagents 0.69 和当前 peer `pi-coding-agent` 0.81.1 的兼容，不通过扫描临时目录或猜测跨 session run 换取覆盖率。

### 1.2 非目标

- 不在本方案中支持 pi-subagents nested/fork/helper LLM 的 child factory usage。
- 不把 `artifactDir: "temp"` 下的临时文件直接纳入当前 TUI session。
- 不把第三方 EventBus probe、CLI 文本、子会话 `session.jsonl` 推断成已认证账本来源。
- 不把历史持久化记录的 unknown quality 静默迁移为 reported；如需迁移，另开有版本号的持久化变更。
- 不在未完成 0.85.1 兼容认证前扩大 peer range。

## 2. 优先级总览

| 优先级 | 项目 | 当前结论 | 目标结果 |
| --- | --- | --- | --- |
| P0 | `bg_wait` ownership | 当前管理类 exclusion 没有 0.69 的 `bg_wait`；顶层 pooled usage 会被 generic D 认领 | `bg_wait` 有专用 management adapter；稳定绑定当前 session 的 completion/run identity；不重复、不跨 session |
| P0 | generic tool progress 清理 | D 的 progress 是 `toolusage:`，`dropProgressForToolCall()` 不识别 | D progress 统一使用 `toolprogress:`；终态有无 usage 都能清理 |
| P0 | object-shaped cost | `.cost.total` 当前标为 unknown，ledger 不计入 costUsd；未知 model id 还可能落到默认费率，zero quality 也会丢失 | 只对完整、符合 Pi usage 形状的来源自报金额标 `reported`；未知 model 保持 unknown；zero cost 不估算且保留 `reported` |
| P1 | aggregate/per-child 边界 | 当前是跨来源、跨粒度 first-wins；部分 child 可定位、部分不可定位时没有安全规则 | 明确保留 first-wins；混合 identity 不得把已知 child 冒充整个 run aggregate；补齐所有到达顺序和部分 payload 测试 |
| P1 | 0.69 source identity | child `runId` 可选，普通 async artifact 使用父 run，单 child 还可能没有 index | 固定 parent/child/index 规则；indexless meta 只有在 0.69 单 child 约束成立时才规范化，否则 fail-closed |
| P1 | 回归测试 | 缺少 0.69 `bg_wait`、foreground 无数字、generic D progress 的直接 fixture | 使用固定的 0.69 payload fixture 覆盖 ownership、fallback、替换和 session 边界 |
| P2 | 文档与版本声明 | 当前 ownership spec 仍登记旧管理工具；README 对 `bg_wait`/object cost 不完整 | 同步中英文 README、ownership spec、compat matrix 和 docs 索引；peer range 保持不变 |

## 3. 方案 A：重划 `bg_wait` 的 usage ownership

### 3.1 0.69 合同

pi-subagents 0.69 的工具名是 `bg_wait`。其成功结果可能包含：

- 顶层 `usage`，由 `details.completions[].results[].usage` 的 plain numeric cost 汇总后，经 `toAgentToolUsage()` 转成 Pi cost object；
- `details.mode = "management"`、`details.results = []`；
- `details.completions[]`，每个 completion 有稳定的父 `runId`，child 的 `runId` 可选，child usage 是 plain numeric cost；
- foreground-complete 事件只携带完成状态和 run identity，0.69 不保证携带 usage。
- `WaitCompletionChild` 的 `runId` 和 `sessionFile` 都是可选投影字段；普通 async child 的 artifact identity 通常来自父 run + agent + flat index，而不是 child `runId`；单 child 时 index 可能省略。
- `bg_wait` 的投影结果不携带可供本扩展重新验证的父 session identity。0.69 自身在 wait/list/result-file 层做 session 过滤，但本扩展不得把“工具名 + 任意 runId”当作当前 session 的独立证明。

因此 generic D 不能读取 `bg_wait` 的顶层 `result.usage`。`bg_wait` 的数字只能由专用 adapter 按 completion identity 归入已存在的 `meta:` ownership。

### 3.2 Ownership 与 session 绑定

1. 将 `bg_wait` 加入 management exclusion；保留 `subagent_wait`、`subagent_supervisor`、`intercom` 作为旧版本/其他管理入口的 exclusion names，不把它们描述成 0.69 的 aliases；不得引入未被当前包证明的 `contact_supervisor` 名称。
2. 新增纯函数 `extractBgWaitUsage(result, currentSession, trustedRunIds)`，只读取 `details.completions[].results[]`。`trustedRunIds` 由调用方提供，表示当前 session 已经从受信启动/事件路径观察过的 run；parser 不得自行把 `bg_wait` 中的新 run 变成 trusted。它不得读取 `details.results[]`，不得把顶层 pooled `usage` 再生成 `toolusage:<toolCallId>`。
3. 在接受 completion usage 前，先验证：调用来自当前 primary TUI session；completion 有非空、可规范化的父 `runId`；若 payload 带 session identity，则必须与当前 session 匹配。由于正常 0.69 projection 没有父 session identity，`bg_wait` 不得单独建立新的 session ownership：父/child run 必须已经由当前 session 的 `subagent` 启动、completion event 或其他受信路径观察并绑定；否则数字和后续 meta ownership 都丢弃。
4. 从 `details.completions[]` 收集父 run ID 和存在的 child run ID，但只对已通过当前 session ownership 门禁的 ID 触发 `sessionRunIds`/`runOrigin` 与 meta scan。不能通过 status/list 文本猜测 run ID，也不能用一个未认证的 `bg_wait` payload 给当前 session 建立 ownership。
5. child source key 必须与现有 async/meta 规则完全一致：
   - 有稳定 child `runId` 时，使用 `meta:<childRunId>:<agent>:<index>`；
   - 普通 0.69 async child 没有 child `runId` 时，使用已由 fixture 固定的 `meta:<parentRunId>:<agent>:<flatIndex>`；index 来自 completion results 的稳定顺序/0.69 flat index，不得猜测随机序号；
   - 0.69 单 child 省略 index 的 `_meta.json` 只有在确认该 parent/agent 只有一个 indexless child 时，才规范化为该 child 的 canonical index `0`；不能证明唯一性时 fail-closed；
   - 无法证明 child 粒度身份时，只有在该 completion 没有任何已接受的 per-child 记录时，才允许使用一个 `meta:<parentRunId>` aggregate；不能用 aggregate 覆盖已知 child 或未知 child 子集；
   - 不允许按 `bg_wait` 的 toolCallId 生成新的长期计数 key。
6. `bg_wait` 重复调用依靠上述稳定 sourceKey 和现有 ledger identity/revision 去重；本方案不新增 completion 持久化表。跨进程 replay 若需要额外状态，另开持久化方案。
7. 同一次 `bg_wait` 返回多个 completion 时逐个按 identity 处理；已由 event/meta 占用的 key 跳过，未占用的 key 才接受 fallback。顶层 pooled usage 永远不进入 D；一个 completion 内若 child identity 混合，已知 child 只按 per-child 计，无法安全归属的部分不得被提升为整个 parent aggregate。顶层 aggregate 与 per-child 不能同时进入同一 run。

### 3.3 验收用例

- 固定的 0.69 `bg_wait` payload：顶层 cost object、`details.completions[].results[].usage` 和 child identity 都可解析，且 generic D 不产生 `toolusage:`。
- 普通 0.69 async child 无 child `runId`、多 child 有 flat index、单 child 无 index 的三种 artifact/source shape 均有版本标注 fixture；indexless meta 无法证明唯一性时 fail-closed。
- async-complete 先到、`bg_wait` 后到：只保留同一 sourceKey 的一份。
- `bg_wait` 先到、async-complete 后到：仍只保留一份，结果按 §6 的 first-wins 规则处理。
- completion event 无数字、`bg_wait` 无数字但 `_meta.json` 有数字：先确认父 run 已由当前 session 的受信路径绑定，再触发 meta scan，meta 只计一份。
- `bg_wait` 带有当前 session 未观察过的、但格式合法的旧 session runId：不得绑定，不得触发 meta scan，不进入 finalized ledger。
- 同一 completed run 重复 `bg_wait`，以及一次等待多个 completed run：不按 wait toolCallId 增长第二份。
- `bg_wait` 只有 run aggregate：只计一个 `meta:<runId>` aggregate，不叠加 child sibling。
- 一个 completion 同时含有可定位和不可定位 child：不得生成覆盖整个 parent 的 aggregate；已知 child 与不可归属部分的处理结果必须明确为 per-child 或 fail-closed partial。
- 无 session identity、无稳定 run identity、或跨 session identity 的伪造 payload：不进入 finalized ledger。

## 4. 方案 B：统一 progress/final execution identity

### 4.1 当前问题

B 的 progress 使用 `toolprogress:<toolCallId>:...`，generic D 当前直接保留 `toolusage:<toolCallId>`。`dropProgressForToolCall()` 只识别 `toolprogress:` 和 B 的 `tool:` 前缀，因此 D progress 在终态无 usage 时可能残留。

### 4.2 建议实现

1. 抽出 `progressSourceKey(toolCallId, sourceKey)`，统一编码 toolCallId 和底层 sourceKey。
2. B、D 的 `tool_execution_update` 都通过该 helper 生成 progress sourceKey，并保留 snapshot revision。
3. `tool_execution_end` 先在 usage task queue 中执行 `dropProgressForToolCall()`，再接受终态记录；终态无 usage 也必须完成清理。
4. 终态有 usage 时保留 snapshot replacement 语义；progress 与 final 不得作为两个 response 贡献。
5. `toolusage:<toolCallId>` 仍只作为 generic D 的终态 namespace，不与 B 的 `tool:<id>:...` fallback 混用。
6. `dropProgressForToolCall()` 必须同时清理 canonical `toolprogress:<encoded-toolCallId>...`、现有 B 的 `tool:<raw-toolCallId>:...` 以及升级前 generic D 可能留下的 `toolusage:<toolCallId>` progress；清理顺序必须先 drop、后 ingest final，不能删除刚写入的终态。
7. canonical encoding 和 legacy matching 要覆盖包含 `:`, `%`, `/` 的 toolCallId；同一进程中已有的旧 snapshot/provisional key 不得因 source shape 变化永久残留。

### 4.3 验收用例

- generic tool update 有 usage、end 有 top-level usage：只显示 end 数值。
- generic tool update 有 usage、end 无 usage：最终 All/Turn 不保留 progress。
- generic tool 多次 update：只保留最新 snapshot。
- subagent update + subagent end 的现有行为保持不变。
- update/end source shape 不同时仍只保留一个 execution contribution。
- toolCallId 含特殊字符、旧 `toolusage:` progress、旧 `tool:` progress 和新 `toolprogress:` progress 均能在 end 有/无 usage 时清理。

## 5. 方案 C：明确 object-shaped cost 的质量规则

### 5.1 认证边界

本方案把 `tool_execution_update`/`tool_execution_end` 的顶层 `result.usage` 视为 Pi-compatible tool-result contract，而不是可密码学认证的 producer 来源。`ToolExecutionEndEvent.result` 在当前 peer 中是 `any`，所以“reported”只表示 payload 通过完整协议形状校验并由工具自报，不表示网关账单已独立核验。Pi 自身会将同一形状纳入 `/cost`；因此：

- `usage.cost` 为有限非负 number：`reported`；
- `usage.cost` 为完整 cost object，`input/output/cacheRead/cacheWrite/total` 均为有限非负 number：`reported`；
- `usage.cost.total = 0` 仍为 `reported`，不能因为零值退回估算或 unknown；
- 没有 numeric amount 但 model/provider 命中本仓已知 pricing rule 或受信 model registry：沿用既有 estimated policy；
- 非空但未命中规则的 model id、未知 provider 或仅有展示标签：不得使用 `DEFAULT_MODEL_COST`，保持 `unknown`；
- 没有 amount、只有 token，或字段不在顶层 `usage.cost` contract 内：`unknown`，不套父模型默认费率；
- `bg_wait` 顶层 object 不由 generic D 处理，避免与 management adapter 双计。

“任意第三方私有 cost 字段”是指不符合顶层 Pi `result.usage` contract 的字段；不能用字段名称猜测私有协议，也不能把任意嵌套金额提升为 reported。由于没有 producer authentication，generic D 不得声称比“符合 Pi-compatible shape 的来源自报”更强的可信度。

### 5.2 建议实现

1. 为 `resolveUsageCostWithQuality()` 增加明确的调用方语义，例如 `pi-tool-result`，禁止继续用含义过宽的 `unknown` 表示 Pi-compatible object。
2. generic D 只对完整、合法的顶层 cost object 使用 `reported`；compaction `fromHook` 和无可验证 model pricing 的来源继续使用现有 unknown/estimated 规则。
3. 增加非负 finite 的 protocol parser；zero cost 必须沿着 `SubagentUsageRecord`、legacy adapter、usage contract 和 ledger 保留 `reported` 零值，不能用 `costUsd > 0` 作为质量存在条件。
4. 对未知 model id 禁止调用默认费率；“可估算”必须有明确 registry/rule 命中证据，显示标签不构成 pricing key。
5. 保持现有 ledger 规则：unknown cost 不进入 confirmed `costUsd`，但质量在 `/calls`、状态行和 model rows 可见；本方案不新增 unknown amount 字段，也不改变历史 unknown 记录的总额语义。
6. 不迁移或重写已有持久化 observation。新代码只影响之后解析的新 Pi tool-result；恢复旧记录的 quality 和 totals 必须保持不变。
7. README 中明确：Pi-compatible numeric/object cost 是来源自报 reported；只有 token、非法 object 或不可认证金额是 unknown；历史持久化记录不会被本方案静默升级。

### 5.3 验收用例

- generic tool numeric `usage.cost` 与 Pi `/cost` 的新记录金额一致，quality 为 reported。
- generic tool object `usage.cost.total` 与 Pi `/cost` 的新记录金额一致，quality 为 reported。
- 完整 object cost 的 zero cost 保持 `reported`，不估算、不产生虚假金额；legacy adapter 和 ledger totals 均保留该质量。
- 无 cost、只有 token：token 计入，cost quality 为 unknown。
- 非空 unknown model id、unknown provider、仅展示标签均不因默认费率产生金额；命中明确 pricing rule 的 model 才允许 estimated。
- 缺失 cost object 字段、负数、NaN、任意嵌套金额均为 unknown，不提升为 reported。
- compaction `fromHook` 规则不回归。
- 恢复旧的 unknown object-cost observation 时，历史 totals 不因本方案变化。

## 6. 方案 D：固化 source identity、revision 和 first-wins 边界

### 6.1 本次明确保留的规则

1. sync per-child result 与 `_meta.json` 继续共享 `meta:<runId>:<agent>:<index>`；run aggregate 使用 `meta:<runId>`。
2. 同一 run 的 aggregate/per-child 是跨粒度互斥，而不是可叠加。当前实现采用**到达顺序 first-wins**：先接受 aggregate，后来的 child 被抑制；先接受 child，后来的 aggregate 被抑制。不能把该规则表述成无条件“per-child 优先”。
3. 同一 sourceKey 的 meta mtime revision 只在 meta inlet 内比较；tool revision counter 不与 mtime 比较。
4. ledger snapshot identity 继续由 source package、producer、snapshot epoch、scope、execution 组成；同 revision 幂等，更高 revision 替换同一 snapshot。
5. 无 revision 的 completion event 若已经带有数字并占用 sourceKey，后续 meta 不回补；这是保守的 first-wins under-count 边界。只有 event 没有任何可计数字段时，才等待 meta。
6. 0.69 普通 async child 没有 child runId 时，只有在 parent + agent + flat index 已被版本 fixture 证明稳定时才生成 per-child；单 child indexless meta 只在唯一性证明成立时规范化，否则保持 fail-closed。
7. 一个 completion 内只要已有任何 per-child 被接受，就不得把剩余不可定位 child 汇成覆盖整个 parent 的 aggregate；该部分必须显式 under-count/partial。

### 6.2 Fixture 与部分 payload

1. 增加“aggregate 先到、child 后到”和“child 先到、aggregate 后到”两组 fixture，并断言 totals 不双计、granularity 按到达顺序固定。
2. 增加“无 revision completion event + 后续完整 meta” fixture，确认 event 有数字即视为终态。
3. 增加“event 只有部分数字 + meta 更完整” fixture。若 0.69 真实 payload 产生该形状，本次仍保持 first-wins 并明确其 under-count；要做 completeness 回补必须另开设计，不在本方案隐式改变。
4. 增加 async 无 results 的 run aggregate、`totalChildUsage`、root usage 的来源优先级测试；明确一个事件不能同时生成 aggregate 和 per-child。
5. 增加普通 0.69 多 child、单 child indexless artifact、child identity 混合和未观察旧 session run 的 fixture；断言 ownership 先于 meta scan。

## 7. 方案 E：artifact 与 session 边界

### 7.1 保持当前实现边界

- project `.pi/subagents/artifacts`、legacy `.pi-subagents/artifacts`、session sidecar 继续扫描；当前代码已经具备这三类候选目录。
- `artifactDir: "temp"` 不直接扫描，避免跨 session 临时文件污染。
- 只有当前 session 已通过启动/事件等受信路径观察的 run 才能进入 `sessionRunIds`；不因为 `bg_wait` projection、status/list 文本中出现 runId 就单独建立 ownership。
- `session_shutdown` 保留 generation/sessionActive 防护；旧 task 在新 session 不得写入。无需在本方案新增 queue drain 或持久化结构。

### 7.2 文档口径

- 不再把“只扫描 `.pi/subagents`”当作当前代码事实；文档应确认 project/legacy/session 三类目录。
- 明确 0.69 的 `artifactDir` 只有 project/session/temp，不是任意路径。
- 明确普通 0.69 child 的 parent-run/flat-index 规则、单 child indexless artifact 的唯一性门禁。
- 明确 temp artifacts、没有 parent session file、child factory/nested usage 和无法证明 index 唯一性的 meta 是已知 under-count boundary。

## 8. 版本与兼容性策略

1. 当前 peer range `>=0.81.0 <0.85.0` 不修改。
2. 先在仓库 pi-coding-agent 0.81.1 上完成 P0 修复和 focused tests。
3. 0.69.0 的本次证据等级保持 `wired`：使用带来源版本的固定 payload/source-shape fixture；没有真实包安装和真实 TUI runtime 验证时，不得写成 `certified` 或“已运行兼容”。
4. 若要正式支持 0.85.1，另开兼容性变更：
   - 在 0.85.1 上跑 typecheck；
   - 用 runtime fixture 验证 `tool_execution_end.result`、`ctx.sessionManager.getSessionId()`、`ctx.sessionManager.getSessionFile()`、`pi.events`；
   - 检查 `agent_settled`、shutdown/reload 和 usage task generation 顺序；
   - 单独更新 peer range、CI matrix、README 支持版本和发布门禁。
5. 在兼容性变更完成前，不把本机 0.85.1 运行成功写成正式支持声明。

## 9. 测试矩阵

### 9.1 固定 fixture

在测试目录加入不依赖全局安装的 0.69 fixture，至少包含：

- `bg_wait` 顶层 object cost、`details.mode = "management"`、`details.completions[].results[].usage`；
- 有 child run ID、无 child run ID、多个 completion、重复 wait；
- 普通 0.69 async child 无 child run ID 但有 parent/agent/flat index；单 child indexless artifact；workflow child 有独立 child run ID；
- async-complete 有数字、无数字、aggregate、per-child；
- foreground-complete 只有 run identity、没有 usage；
- 0.69 `artifactDir` project/session/temp 的边界说明。
- 未观察旧 session 的合法 run ID、混合 child identity、重复 wait 和 pooled top-level usage 不得产生 ownership/账本记录。

Fixture 文件注明来源版本和 payload shape，不把当前或未来 1.x 包的观察写成 0.69 证据。

### 9.2 单元测试

- `test/tps-usage-inlets.test.ts`
  - `bg_wait`、`subagent_wait`、`subagent_supervisor`、`intercom` 均被 management exclusion 拦截；
  - object cost、numeric cost、zero cost 的 quality；完整 cost object 与非法/部分 object 的边界；未知 model/provider 不使用默认费率；
  - `details.mode` 和 nested `details.results` 不会被 generic D 误认领。
- `test/tps-subagent.test.ts`
  - bg_wait completion identity 和 parent/child key 规则；
  - 普通 0.69 parent/agent/flat-index、单 child indexless meta、workflow child run ID；
  - aggregate/per-child first-wins 两种顺序；
  - 混合 child identity 不生成覆盖整个 parent 的 aggregate；
  - event no-number 与 meta fallback；
  - partial payload、`totalChildUsage`、root usage 边界。
- `test/tps-subagent-bridge.test.ts`
  - 当前 session 的 async/foreground run observation；
  - 不同 session 的事件被丢弃；
  - fixture provenance 改为 0.69，不再使用未注明版本的 1.x 形状。
- `test/usage-pi-subagents-adapter.test.ts`
  - B/D progress sourceKey 都带 `toolprogress:`；
  - 终态 sourceKey 与 progress sourceKey 的替换关系；特殊 toolCallId 与升级前 legacy key 清理。
- `test/usage-collector.test.ts`
  - canonical/legacy progress key 的 drop 规则；end 有/无 usage 的最终账本状态。
- `test/usage-ledger.test.ts`
  - reported object cost（含 zero）进入 totals；unknown cost 不进入 confirmed costUsd；
  - 同 sourceKey、不同 revision、多个 model partition 的完整替换；
  - 旧持久化 unknown observation 恢复后 totals 不变。

### 9.3 Runtime tests

在 `test/tps-runtime.test.ts` 增加：

1. async-complete + `bg_wait` pooled result 不双计；两种到达顺序均符合 first-wins；
2. event 无数字、`bg_wait` 无数字、meta 有数字时只计一次；
3. generic D progress 后终态无 usage 不留账；
4. generic D object cost 与 Pi semantics 对齐，且不影响未知金额规则；
5. foreground-complete 无 usage 时由绑定的 meta fallback 计入；
6. session shutdown 后旧 task 不写入新 session；
7. completion payload 无 session/run identity 时 fail-closed。
8. completion payload 带合法但当前 session 未观察过的旧 runId 时，不绑定、不扫描、不入账。
9. 混合 child identity、单 child indexless meta 和 unknown model pricing 均符合上述 fail-closed/quality 规则。

### 9.4 默认验证命令

只运行直接相关的 focused checks：

```bash
npx vitest run \
  test/tps-subagent.test.ts \
  test/tps-subagent-bridge.test.ts \
  test/tps-usage-inlets.test.ts \
  test/usage-pi-subagents-adapter.test.ts \
  test/usage-ledger.test.ts \
  test/usage-collector.test.ts \
  test/tps-runtime.test.ts
```

然后运行：

```bash
npm run typecheck
```

本方案默认不运行裸 `npm run test`、全仓 build 或发布门禁。只有用户明确要求全仓验证或进入发布审查时，才按仓库门禁执行 `npm run check`/`npm run gate`；发布门禁仍包括 tarball 解包、`pi install <目录>` 和真实 pi 功能验证。

实现完成验收与发布门禁是两个不同阶段：focused checks/typecheck 只能证明代码验收，不代表可以发布。

## 10. 实施顺序与回滚点

1. **P0-1：** 先更新 ownership spec 和 exclusion constants，加入 `bg_wait` adapter、受信 run binding、0.69 fixtures 与 source identity tests。
2. **P0-2：** 固化 parent/child/flat-index 及 indexless meta 规则，完成 aggregate/per-child 与跨 session runtime tests。
3. **P0-3：** 统一 B/D progress key，完成 canonical/legacy cleanup 与 generic tool runtime tests。
4. **P0-4：** 将合法 Pi-compatible object cost 标为 reported，完成 zero quality、unknown model、legacy adapter、ledger/formatter tests。
5. **P1：** 固化 aggregate/per-child first-wins、partial payload 和 foreground meta fallback fixtures；除非 fixture 证明现有策略错误，不改变生产优先级。
6. **P2：** 同步 `README.md`、`README.en.md`、`docs/README.md`、`docs/superpowers/specs/2026-07-24-subagent-usage-tps-design.md`、`docs/superpowers/specs/2026-08-22-multi-agent-usage-compat-design.md`、`docs/superpowers/specs/2026-09-07-usage-compat-matrix.md` 及必要的当前文档引用。
7. 每个 P0 项目单独提交，便于发现账本变化时按项目回滚；不得把 P0 修复与 peer range 扩大合并发布。

## 11. 实施完成验收标准

- P0 focused tests 和 typecheck 通过，且至少包含带版本标注的 pi-subagents 0.69 `bg_wait` fixture。
- `bg_wait`、async event、foreground/meta 三条路径在同一场景下不双计；受信 ownership 下的无数字 fallback 场景不漏计；未认证 run 和无法安全归属的部分明确 fail-closed/partial；总额不依赖显示层手工去重。
- aggregate/per-child 两种到达顺序均有确定、文档化的 first-wins 结果；不把两种粒度相加。
- generic D progress 在 end 无 usage 时不进入 finalized totals。
- 新 Pi object cost 在 `/cost` 与 `/calls` 之间不静默分叉；unknown quality 仍可见；旧持久化记录不被静默改写。
- 无新产生的跨 session run 绑定；当前 session 未观察的 run 不得由 `bg_wait` 单独绑定；无 session/run identity 的 completion fail-closed；temp artifacts 仍明确标注为不覆盖。
- 当前 ownership spec、compat matrix、中英文 README、历史设计快照的当前口径与实现一致；保留旧 management exclusion names，不宣称它们是 0.69 aliases。
- `git diff` 只包含实现、focused tests、相关 README/docs；无生成文件、密钥或无关格式化变更。

## 12. 发布门禁（仅在准备发布时执行）

实现完成验收通过后，若该行为变更已合并并准备发布，必须再按仓库门禁执行：

1. `npm run gate` 或 `./scripts/pre-publish-gate.sh`；
2. 解包 tarball 后使用 `pi install <目录>`，不得直接 `pi install ./*.tgz`；
3. 在真实 Pi TUI 中验证本次涉及的 `/calls`、子代理归属、重复 wait、跨 session/shutdown 和未知 cost 规则；
4. 功能验证通过后运行 `./scripts/gate-record-pass.sh`，再进入版本、认证和发布流程。

门禁未通过时不得把 focused tests/typecheck 结果写成可发布结论。
