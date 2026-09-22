# 上游响应模型不一致审计（`/model-audit`）设计方案

状态：**方案修订版（第 2 轮），未实施**。与代码冲突时以代码为准；实施后在文末补实施记录与偏差。
日期：2026-09-22
针对：`@llmgates_api/pi-llmgates-provider` 0.7.1，peer `@earendil-works/pi-coding-agent` / `pi-ai` `>=0.81.0 <0.87.0`。

第 1 轮吸收的意见：审计不进入既有 usage ledger；不使用进程内总线与 `fs.watch` 双通道；Turn 归属通过 root context 传递。
第 2 轮按对照 pi-ai / pi-coding-agent / 子代理源码的只读评审修订：root marker 增加所有者规则，非所有者实例在创建时冻结 root context；计数与 300 条记录列表分离；shutdown 有界 flush；判定口径、观察统计、损坏恢复与改动清单同步修正；删去请求 body 解析等无收益部分。变更摘要见文末「修订记录」。

---

## 0. 结论摘要

- **做什么**：每次经本插件 native provider 发出的 LLM 请求，比较最终发出的模型与上游响应自报的模型。系列不同就记一次：状态行追加红色 `.xN`，历史按工作目录保存最近 300 条，`/model-audit` 查看。
- **只检测与记录**：不拦截、不重试、不改请求或响应字节、不改计费，也不把审计记录写入 `llmgates:usage:v1` usage ledger。
- **检测点**：`extensions/compat/provider.ts:1281`、`:1292` 的 `stream` / `streamSimple`。只要请求实际使用本插件注册的 native provider，就不依赖子代理包的事件格式。
- **pi-ai 能力**：0.83+ 三种兼容 API 使用 `options.fetch` 旁路；没有 fetch 观察结果时用 `AssistantMessage.responseModel` 兜底。0.81.0 仍需在实施前补一轮最低版本核验。
- **归属原则**：root marker 只由创建它的扩展实例（所有者）轮换与清理；所有者按请求读取实时轮次，非所有者在自己的 `session_start` 冻结 root context。计数在写入时累加进历史文件的按 root 计数表，不从记录列表重算。父 TUI 轮询这个单一历史文件。

## 1. 已确认的决策

| # | 决策 |
| --- | --- |
| D1 | 只有归一化后的模型系列不同才算；版本变体不计数、不写历史。 |
| D2 | 命令名 `/model-audit`。 |
| D3 | 默认开启；`LLMGATES_MODEL_AUDIT=0` 不包装 fetch、不收尾、不写新历史、不设置 root marker、不追加审计状态后缀。该开关不改变既有 TPS 语义。 |
| D4 | pi-ai 0.81–0.82 接受 Responses / Anthropic 无法从字段兜底；0.83+ 必须证明 fetch hook 能触发并在上游报告模型时记录 mismatch。上游没有模型名是“无结论”，不是 hook 失败。放宽 peer 上界前必须重新跑兼容门禁。 |
| D5 | 历史按 root 工作目录存放，每个目录最多 300 条；`/model-audit` 只看当前工作目录。 |
| D6 | 各种子代理只要实际调用本插件 native provider，并继承 root context，就必须检测和记录；外部 CLI、未加载本插件的 provider、clean-env 且无法建立 root context 的运行器不冒充已覆盖。 |

`LLMGATES_TPS` 仍只由既有 usage policy 控制。它为 0 时既有用量采集/持久化照旧关闭；审计历史是独立文件，审计是否追加状态后缀只看 `LLMGATES_MODEL_AUDIT` 和当前是否存在状态行。

## 2. 调研事实（实施前复核）

### 2.1 网关的口径

**sub2api**：依据本地 sub2api 副本 `backend/internal/service/upstream_response_model.go`（该副本没有 git 元数据，未与 Wei-Shaw/sub2api main 对齐确认）：

- OpenAI 读取 `response.model` / `model`，结束类事件的值优先；Anthropic 读取 `message.model` / `model`；Gemini 读取 `modelVersion`。
- 比较对象是经过映射后实际发往上游的模型；上游不报告模型时不下结论。
- 网关对自己映射后的同名响应可能改回客户端模型名；插件只能审计它实际收到的响应字节。

**NewAPI / CLIProxyAPI：实施前必须补调研**（插件同样一等支持这两类网关，第 1 轮只调研了 sub2api）。每个网关记录两件事，并附来源（源码路径或文档链接）：

1. 响应中的 `model` 是回显客户端请求名、上游真实名，还是按渠道配置而定；
2. `/v1/models` 列出的、映射到同一上游模型但调用参数不同的名称后缀（例如思考开关、推理强度一类后缀）的实际规则。

只有已证实“同一上游模型、不同调用参数”的后缀才能进入 §3.6 的内置规则；未证实的不收录，由用户等价表兜底。调研完成前不进入 `compare` 实现。

**调研结论（2026-09-22，实施时补）**：只读 GitHub 默认分支源码，路径相对各仓库根目录。

**NewAPI**（`QuantumNous/new-api` @ `996adffe5165bd5e311e33a03a86b8aede1fe376`）：

- 响应 `model`：同协议时原样透传上游 chunk——chat `relay/channel/openai/relay-openai.go` `sendStreamData`、Responses `relay/channel/openai/relay_responses.go`、Anthropic `relay/channel/claude/relay-claude.go` `ClaudeChunkData`；跨协议转换器也复制上游 model（`relaykit/relayconvert/internal/claude_messages/to_oai_chat_resp.go`）。例外：Gemini 上游（`relay/channel/gemini/relay-gemini.go`）与“Responses 走 chat”（`relay/channel/openai/responses_via_chat.go`）写的是 NewAPI 实际发往上游的名字。
- 模型映射只改请求（`relay/helper/model_mapped.go`，支持链式），**没有**把响应改回客户端名的设置；上游换模型时只记日志不改写（`relay/common/response_model.go` `ObserveResponseModel`，注释写明不得改变下游输出）。结论：映射后客户端看到的是映射名/上游名，**管理员配置的映射本身会被本插件记为不一致**，只能靠等价表豁免。该透传行为继承自 `songquanpeng/one-api`（`relay/adaptor/openai/main.go` `StreamHandler`）。
- 后缀（均在发往上游前剥离，`relay/helper/reasoning_suffix.go`；先整名黑名单 → 剥 `@` 链 → 再黑名单 → 一次破折号后缀解析）：
  - `@key:value` 链，key 仅 `thinking` / `effort` / `temperature` / `topp`，其它 key 直接报错（`relaykit/relayconvert/reasoning/suffix.go` `ParseModelModifiers`、`relay/helper/model_modifier.go`）。
  - `claude-*` / `gemini-*`：`-thinking-<int>`、`-nothinking`、`-thinking`（同文件 `ParseClaudeModelSuffix` 等）；受全局 `thinking_adapter_enabled` 控制，Claude 默认开、Gemini 默认关（`setting/model_setting/claude.go`、`gemini.go`），关闭时原名上送。
  - 推理强度尾缀 `-max|-xhigh|-high|-medium|-low|-minimal|-none`，只对 `gpt-*`、`o[1-9]*`、`claude-*`、`gemini-*`；gpt/o 分支豁免 `EffortTailModelIDs`（`setting/model_setting/global.go`，其中属于该分支的只有 `gpt-5.1-codex-max`）。
  - `deepseek-v4-*` 的 `-none` / `-max`（`relaykit/relayconvert/reasoning/suffix.go`、`relay/channel/deepseek/adaptor.go`）。
  - 依赖渠道类型、客户端看不见的规则**不收录**：xAI `grok-3-mini` 的 `-high/-low`、xAI/百度 `-search`、火山 `deepseek*-thinking`。
  - `/v1/models` 只列管理员配置的名字，带后缀的名字路由时回落到剥离后的基名（`model/channel_cache.go`）。

**CLIProxyAPI**（`router-for-me/CLIProxyAPI` @ `555662940411a07460e9d24d14477a5f50dffdb5`）：

- 响应 `model` 按路径不同：OpenAI 兼容上游 → chat 客户端原样透传；Codex / Gemini 上游取上游自报值；Claude 上游 → chat 客户端写的是 CPA 路由到的名字（含 `(…)` 后缀）；Kimi 执行器用路由名覆盖 `message.model`；**Responses 客户端**在 Claude / Gemini / OpenAI-chat 上游时回显客户端原始请求名（`internal/translator/**/…_openai-responses_response.go`），这条路径本插件永远看不到不一致。
- 别名映射默认不改写响应；只有别名配 `force-mapping: true` 时才把各处 model 字段改写成别名（`sdk/cliproxy/auth/response_model_rewriter.go`、`config.example.yaml`）。上游换模型只记日志（`internal/runtime/executor/helps/response_model.go` `IsModelSubstituted`，其容忍规则：小写、去 `(…)`、去 `vendor/`、日期后缀、3 位版本号、`-latest`）。`auto` 解析为第一个可用模型（`internal/util/provider.go`），响应必然与请求不同。
- 后缀：只有末尾 `(value)`，所有 provider 通用，执行器统一 `thinking.ParseSuffix` 剥离（`internal/thinking/suffix.go`）；破折号后缀（`-thinking`、`-high` 等）CPA 不解析，注册表里是真实独立 id。`/v1/models` 不列 `(…)` 变体。

**由此进入 §3.6 的内置规则**：末尾 `(…)`（CPA）；`@thinking|effort|temperature|topp:` 链（NewAPI）；`claude-*`/`gemini-*` 的思考后缀（NewAPI）；gpt/o/claude/gemini 推理强度尾缀并豁免 `gpt-5.1-codex-max`（NewAPI）；`deepseek-v4-*` 的 `-none`/`-max`（NewAPI）。另把 3–4 位数字版本尾（`-002`、`-0613`、`-2411`）作为版本变体归一化（CPA 自身的替换检测也容忍 3 位版本号），见文末「实施记录与偏差」。

本方案只支持插件当前的三个 API：`openai-completions`、`anthropic-messages`、`openai-responses`。

### 2.2 pi-ai 各版本能力

下表已对 0.81.1、0.82.0、0.83.0、0.84.0、0.85.0、0.85.1、0.86.0 及本机 0.87.0 的包源码做只读核对；peer 下限 0.81.0 仍需在实施前补核验。

实施时复核（2026-09-22，`npm pack` 解包只读 grep）：0.81.0 与 0.81.1 相同——三个适配器都不引用 `options.fetch`，只有 `openai-completions` 设置 `responseModel`，`buildBaseOptions` 不透传 `fetch`；0.82.0 同；0.83.0 / 0.85.1 三个适配器都把 `options.fetch` 交给 SDK client，`buildBaseOptions` 透传 `fetch`；0.86.0 起 `anthropic-messages` 增加 `responseModel`。与下表一致。这只是**源码级**核验，不替代 §10.2 的安装包门禁。

| 接口 | 0.81.1–0.82.0 | 0.83.0–0.85.1 | 0.86.0 / 0.87.0 |
| --- | --- | --- | --- |
| openai-completions | 有 `AssistantMessage.responseModel` | 有字段；支持 `options.fetch` | 同左 |
| anthropic-messages | 无字段、无通用 fetch 注入 | 只有 `options.fetch` | 有字段；支持 `options.fetch` |
| openai-responses | 无字段、无通用 fetch 注入 | 只有 `options.fetch` | 只有 `options.fetch` |

- `openai-completions` 的 `responseModel` 取第一个 `chunk.model !== model.id` 的 chunk（0.81.1 `openai-completions.js:258`，后续版本相同）。
- Anthropic 0.86+ 从 `message_start.message.model` 设置 `responseModel`，同样只在不同于 `model.id` 时设置。
- 0.83+ 的 `buildBaseOptions` 透传 `fetch`、`onPayload`，`streamSimple` 路径同样可观察；三个适配器把 `options.fetch` 交给 OpenAI / Anthropic SDK client。
- 三个适配器请求体的 `model` 均为 `model.id`，只有 `onPayload` 返回的新 payload 能改变它；pi 主循环总会传入 `onPayload`（pi-coding-agent 0.81.1 `core/sdk.js:200`）。
- `options.onResponse` 只有 status 和 headers，不能替代 body observer。
- `AssistantMessageEventStream.result()` 在收到 `done` 或 `error` 事件时 resolve（取消表现为 `stopReason: "aborted"` 的 error 事件），从不 reject；适配器若只 `end()` 而不推终止事件，则永不 resolve。

### 2.3 子代理与进程环境

- **pi-subagents 0.70.1 前台**：在父进程内创建 `AgentSession`；只有 runner 宿主才加载 ambient 扩展（`runs/shared/child-launch.js:184`），前台子代理通过 `inheritParentProviders` 直接使用父实例的 native provider 对象。前台运行期间父 Turn 被阻塞。
- **pi-subagents 0.70.1 后台**：独立 runner 进程，spawn 时复制父进程 `process.env`（`runs/background/async-execution.js:496-514`）；runner 内的子会话以 `mode: "print"` 加载 ambient 扩展，即新的本插件实例。
- **@router-for-me/pi-subagents-lite 1.5.1**：进程内 `createAgentSession`；默认加载宿主扩展（`agents/agent-runner.ts:492`，`extensions === false` 才关闭），`bindExtensions` 不传 mode（pi 默认 `"print"`）。`run_in_background` 在父进程内与父会话的后续轮次并发运行，`session_shutdown` 时全部 abort。该包 peer 声明为 `^0.80.1`，并自带 pi-coding-agent 0.80.10；它在 0.81–0.86 上能否正常运行本身待门禁确认。
- **共享环境**：进程内子会话与父会话共用同一个 `process.env`；pi 的 bash 工具把完整 `process.env` 传给每条命令（pi-coding-agent 0.81.1 `utils/shell.js:103-113`）。
- **模块状态**：pi 按进程缓存扩展 factory。pi-subagents 为子会话重置了缓存，lite 没有，因此 lite 子实例可能与父实例共享模块级状态（待验证）。所有归属相关状态必须放在 factory 调用的闭包里。
- **推论**：provider 层能覆盖所有“实际使用本插件 native provider”的子代理调用；进程内子会话不能改写共享 marker，也不能在每次请求时读取父会话的实时轮次，否则 Turn 会串到父会话的后续轮次（见 §4）。

## 3. 检测

### 3.1 挂载点与请求快照

每个扩展实例在 `session_start` 读取一次 `LLMGATES_MODEL_AUDIT`，并把审计 runtime 经 `registerCompatGateways` 的 options 注入 `createCompatProvider`。`stream` / `streamSimple` 每次调用：

1. 本实例审计关闭，或本实例尚未 `session_start` / 已 `session_shutdown`：直接走现有路径，不安装任何 wrapper。
2. 创建 `CallAudit`，立即快照 provider id、`model.id`、api、`streamOptions.sessionId` 和本实例的 root context（§4.2）。之后不再读取可变的 `process.env`。
3. 包装 `onPayload`：原样调用原 callback，原样返回其返回值（包括 `undefined`），原样抛出其异常；从返回值（为 `undefined` 时取原 payload）读取顶层 `model`，不保存 prompt。没有原 callback 时安装一个只读、返回 `undefined` 的包装。
4. 对 `fetch` 做旁路包装：底层实现为 `streamOptions.fetch ?? globalThis.fetch`，在调用时取值；其它 stream options 字段原样保留。
5. 在 `result()` resolve 后收尾（成功、错误、取消都走这里）。收尾与持久化整体 try/catch，不得产生未处理 rejection；`result()` 永不 resolve 时不记录，不设超时计时器。

### 3.2 最终请求模型

1. 原 `onPayload` 返回的最终 payload 顶层字符串 `model`；
2. 没有原 `onPayload` 时使用 `model.id`（三个适配器都以它作为请求模型）；
3. 最终 payload 没有字符串 `model`：请求模型未知，不下结论。

不解析请求 body：它不提供上述来源之外的信息，并且会在请求路径上同步解析整段 prompt。

### 3.3 fetch 旁路

- 只观察 2xx、`body` 不为 null、media type 为 `text/event-stream`（忽略 `;charset=utf-8` 等参数）的响应。三个适配器的请求都是 `stream: true`；其它响应原样返回，该调用按“无结论”统计。
- 使用 `TransformStream`（`pipeThrough`）：先 enqueue 原始 chunk，再在同一次同步调用里完成观察；不得重新编码响应字节。新 `Response` 保留 status、statusText、headers，取消、背压和错误对象由 pipe 原样传播。
- SSE 按事件边界解析：`TextDecoder` 流式解码，处理 CRLF、跨 chunk、多个 `data:` 行和空行结束；单个事件缓冲上限 256 KiB，超限只丢弃该事件的观察，不影响透传。
- 廉价过滤：`data` 不含 `"model"` 子串的事件不做 `JSON.parse`。结论确定后停止解析，只透传。
- 读取位置：

| 接口 | 读取位置 | 终止值 | 结论确定时机 |
| --- | --- | --- | --- |
| openai-responses | `event.response.model`，兼容顶层 `model` | `response.completed`、`response.incomplete`、`response.failed` 中的 `event.response.model` | 终止事件 |
| openai-completions | 每个 chunk 的顶层 `model` | 无 | 第一个系列不同的声明 |
| anthropic-messages | `message_start.message.model`、兼容顶层 `model` | 无 | `message_start` |

模型选择规则：

1. 有终止值时取终止值；
2. 否则取第一个与请求模型归一化后系列不同的声明（与 pi-ai 字段口径一致，避免“首个 chunk 回显请求名、后续 chunk 才是真实模型”时漏报）；
3. 所有声明都一致时取第一个声明，结论为一致；
4. 请求模型未知时不下结论，也不继续解析。

解析异常、非 JSON 数据、缺少模型字段都不得影响推理；debug 日志不得包含 prompt、headers 或响应正文。

### 3.4 字段兜底

fetch wrapper 没有被调用，或被调用但没有得到候选模型时，读取最终 `AssistantMessage.responseModel`。该字段只在与 `model.id` 不同时存在；字段兜底只作为观察结果，不重复计数。

### 3.5 观察统计

不做 pi-ai 版本探测，也不弹提示。每个进程按 API 维护四个计数：

| 计数 | 含义 |
| --- | --- |
| `fetch` | fetch wrapper 被调用过的 provider 调用数 |
| `response` | 从响应字节得到模型的调用数 |
| `field` | 由 `responseModel` 字段兜底得到模型的调用数 |
| `none` | 没有得到响应模型或请求模型未知的调用数 |

`/model-audit` 显示本进程的这些计数，`LLMGATES_DEBUG` 在 session_shutdown 时输出一行汇总（只含计数）。门禁用它们证明 0.83+ 的 hook 实际生效。

### 3.6 判定规则（D1）

归一化按顺序：

1. trim、转小写、去掉最后一个 `/` 之前的前缀、去掉末尾 `-latest`、去掉 `-YYYY-MM-DD`、`-YYYYMMDD`、`@YYYYMMDD`，以及 3–4 位数字版本尾 `-NNN` / `-NNNN`（实施时补，见文末偏差）；
2. 内置网关后缀规则：只收录 §2.1 调研已证实的后缀（清单见 §2.1 末尾）；第 1、2 步反复应用直到不再变化，以覆盖 `claude-sonnet-4-5-20250929-thinking` 这类叠加；
3. 用户等价表：`<agentDir>/llmgates/model-audit-equivalents.json`：

```json
{ "version": 1, "equivalents": [["claude-sonnet-4-5-thinking", "claude-sonnet-4-5"]] }
```

每组内的名字经第 1、2 步归一化后视为同一系列。文件不存在时视为空；格式错误时整份忽略，并在 `/model-audit` 提示；每个实例在 `session_start` 读取一次，`/model-audit` 时重读。

| 情况 | 结论 | 计数 | 写入历史 |
| --- | --- | --- | --- |
| 请求或响应模型未知 | 不下结论 | 否 | 否 |
| 归一化后相等或在同一等价组 | 一致/版本变体 | 否 | 否 |
| 归一化后不同 | **系列不同** | 是 | 是 |

一个 provider 调用最多一条历史记录。规则集中在纯函数中，新增内置规则只改该函数并补测试。

## 4. 归属与子代理（D6）

### 4.1 Root marker 与所有者

`LLMGATES_MODEL_AUDIT_ROOT` 只在审计开启时设置，值为受限 JSON（不超过 4 KiB）：

```json
{"v":1,"token":"<128-bit hex>","rootSessionId":"...","rootCwd":"/abs/project","historyPath":"/abs/.../llmgates/model-audit/<seg>.json","originTurnId":"<token>:3"}
```

`originTurnId` 可缺省（首轮开始前）。marker 不含密钥。

**所有者**是在 `session_start` 写入 marker 的那个扩展实例。所有者身份（`ownedMarker` 与写入前的 env 原值）保存在该 factory 调用的闭包里，不得放模块级。

- **TUI root**（`ctx.hasUI && ctx.mode === "tui"`）：每次 `session_start` 生成新 token 并写入 marker，成为所有者。
- **非 TUI**：marker 不存在或无效时写入自己的 marker，成为所有者（独立 root）；marker 有效时为非所有者。
- **只有所有者可以**轮换 `originTurnId`，以及在 `session_shutdown` 时恢复原值或删除 marker，而且仅当当前 env 仍等于自己写入的值。非所有者对 marker 只读，不写、不删。
- **originTurnId** 格式为 `${token}:${seq}`，seq 在所有者实例内递增。token 每次 `session_start` 都重新生成，所以 `/reload`、`/resume` 之后不会与历史中同一 rootSessionId 下的旧 id 相撞。
- **轮换时机与 TPS 对齐**：所有者维护 `turnActive`；`before_agent_start` 时仅在 `!turnActive` 时轮换并置位，`agent_settled` 时清除。语义与 `extensions/tps.ts:855` 的 `requestStartMs` 防护相同，保证审计 Turn 与状态行 Turn 段是同一个窗口。
- **校验**：出现以下任一情况，marker 视为无效（等同不存在），不采用其中的任何字段：
  - JSON 解析失败，或缺少必需字段；
  - `historyPath` 不是绝对路径，或不以 `.json` 结尾；
  - `historyPath` 的父目录不是 `…/llmgates/model-audit`；
  - `historyPath` 的文件名不等于 `encodeCwdSegment(rootCwd) + ".json"`。
- **可见性**：pi 的 bash 工具会把 marker 传给命令；bash 里再启动的 pi 会继承 marker，并计入当前 root 与 Turn（视为本轮工作）。不额外写日志，不在 UI 展示 marker 内容。

### 4.2 调用快照

- **所有者实例的 provider**：请求开始时读取本实例写入的实时 marker。pi-subagents 前台通过继承使用的正是这些 provider 对象，而前台运行期间父 Turn 被阻塞，因此实时值就是启动 Turn。
- **非所有者实例的 provider**：使用本实例 `session_start` 时冻结的 marker，此后不再读取 env。lite 进程内子代理（含后台）、pi-subagents runner 内的子会话、bash 中嵌套的 pi 都属于这一类，晚到的请求仍归入启动 Turn。
- `CallAudit` 创建后只使用快照；写入目标为快照中的 `historyPath`。

### 4.3 Turn / All 计数

- 计数在写入 mismatch 时，于同一次锁内读改写中累加进历史文件的 `roots[rootSessionId]`（§6），不从记录列表重算，因此不受 300 条上限影响。
- 有 `originTurnId`：`all + 1`、`turns[originTurnId] + 1`；没有：`all + 1`、`unattributed + 1`。
- 子代理晚到的记录计入其启动 Turn；如果那一轮已不是当前轮，状态行 Turn 不变，只有 All 增加。
- `/model-audit` 的“未归属”定义为本 root 下没有 `originTurnId` 的记录数（`roots[root].unattributed`），例如首轮开始前的压缩。
- clean-env 子进程没有 marker，会成为独立 root，写入它自己 agentDir 与 cwd 下的历史；父会话看不到这些记录，这是部分覆盖，不是静默误归属。

### 4.4 单一跨进程通道

不使用 `globalThis` 总线、`fs.watch` 或总线/文件双重去重：

1. 每个 mismatch 在 `withFileLock(historyPath)` 内读改写，再 `atomicWriteJson`。同进程同路径的串行已由 `withFileLock` 的进程内队列保证，不另建写队列；本实例只维护 pending 写入集合，供有界 flush 使用。
2. 父 TUI（`tps.ts`，仅 `isPrimaryUiSession`）在 session 生命周期内用一个 unref 轮询器：活跃时 1 秒，空闲时 2 秒。每次读取当前 marker，取 `historyPath`、`rootSessionId`、`originTurnId`；先 `stat`，mtime 与 size 都未变时不读文件；算出的后缀变化时才 `setStatus`，因为每次 `setStatus` 都会重绘整个 footer（`extensions/tps.ts:281`）。
3. `session_shutdown` 最多等待 pending 写入 1.5 秒，超时即不再等待，并计入本进程的“shutdown 时未完成写入”数。`LOCK_OPTIONS` 单次加锁的重试预算约 43 秒，陈旧锁要等满 30 秒，都不得阻塞 `/new`、`/resume`、`/reload` 或退出。

轮询延迟是可接受的 UI 延迟，不影响历史写入。

### 4.5 覆盖边界

| 调用路径 | 预期结果 |
| --- | --- |
| 父会话、压缩、分支摘要 | provider 直接观察；所有者实时快照 |
| pi-subagents 前台 | 继承父 provider；实时快照即启动 Turn |
| pi-subagents 后台 runner | runner 内子实例为非所有者，冻结 spawn 时继承的 marker |
| pi-subagents-lite 前台 / 后台 | 启用本插件扩展时，子实例为非所有者，冻结创建时的 marker；未启用本插件时不经过本插件 provider，不覆盖 |
| bash 中嵌套的 pi | 继承 marker，计入当前 root 与 Turn |
| clean-env 子进程 | 独立 root，父会话不可见 |
| 外部 CLI、自定义 provider | 不覆盖 |

门禁不得把“来源为 subagent”当作必要字段；验证 rootSessionId、historyPath 和 originTurnId 即可。

## 5. 状态行

```text
All 28m.52c.x3, Turn 1m.2c.~$0.236.x1
```

- `.xN` 是独立的审计后缀，由 `theme.fg("error", ...)` 单独着色，其余部分仍为 `dim`；不得把它放入 usage ledger。
- legacy（`extensions/tps-stats.ts:460-475`）与 quality-aware（`extensions/usage/format.ts`）两套格式函数改为返回分段（All 段、Turn 段、idle marker）。`tps.ts` 负责拼接与着色：`.xN` 追加在对应段末尾、idle marker 之前。
- All = `roots[rootSessionId].all`，Turn = `roots[rootSessionId].turns[当前 originTurnId]`；为 0 时不显示。活跃轮次的状态行只有 Turn 段，因此只追加 Turn 后缀。
- `LLMGATES_TPS=0` 不改变既有状态行生命周期，也不阻止审计记录；`LLMGATES_MODEL_AUDIT=0` 才隐藏审计后缀。
- 没有 TUI 状态通道时不污染 stdout；`/model-audit` 复用 `/calls` 的 notify 行为。

## 6. 历史存储（D5）

- **路径**：快照中的 `historyPath`。所有者写入 marker 时取 `<agentDir>/llmgates/model-audit/<encodeCwdSegment(cwd)>.json`。
- **格式**：

```json
{
  "version": 1,
  "cwd": "/abs/project",
  "updatedAt": "…",
  "roots": {
    "<rootSessionId>": { "all": 3, "unattributed": 0, "turns": { "<originTurnId>": 1 }, "updatedAt": "…" }
  },
  "records": []
}
```

- **上限**：
  - `records` 新的在前，最多 300 条，只用于展示；
  - `roots` 最多 100 个，超出时淘汰 `updatedAt` 最旧的 root；
  - 每个 root 的 `turns` 按插入顺序保留最近 20 个。
- **记录字段**：

| 字段 | 说明 |
| --- | --- |
| `id` | 随机 16 位十六进制 |
| `startedAt` / `at` | 请求开始/结论写入时间 |
| `rootSessionId` | 快照中的 root session |
| `sessionId` | 发起调用的 session，可为空 |
| `originTurnId` | 启动该请求的轮次，可为空 |
| `provider` / `api` | 网关实例 id、pi 接口类型 |
| `sentModel` / `responseModel` | 清洗并限制长度后的模型名 |

不记录 prompt、响应内容、API key、headers、baseUrl、conflict 或 source。

- **权限**：`model-audit` 目录 0700、文件 0600。只对 `llmgates/model-audit` 目录本身做“不是 symlink”的校验并修正权限，不改其它目录的权限。
- **写入**：在锁内读改写，按读取结果处理：

| 读取结果 | 处理 |
| --- | --- |
| 文件不存在 | 新建 |
| `version` > 1 | 只读，不写入，计入本进程写入失败（原因“版本较新”） |
| 不可解析或结构错误 | 改名为 `.<basename>.corrupt` 隔离（只保留一份，覆盖更早的隔离文件），然后新建，计入本进程“已隔离”次数 |
| 锁失败、磁盘错误 | 不覆盖原文件，计入本进程写入失败；debug 模式记录原因 |

- **clear**：在同一把锁内写入空的 `records` 和 `roots`，不删除文件。这会清零本 cwd 下所有会话的计数与状态行后缀，确认对话需写明这一点。遇到损坏文件时同样先隔离再清空。
- **数据清洗**：模型名移除控制字符、限制 UTF-8 字节数；命令展示时再次转义，不能让网关返回值注入终端换行或控制序列。

## 7. `/model-audit` 命令

- **不带参数**：
  - 顶部显示本 root session 的 All、当前 Turn、未归属数量；
  - 本进程的写入失败次数、已隔离次数、shutdown 时未完成写入数（均注明“本进程”，子进程的失败在此不可见）；
  - 本进程按 API 的观察计数（§3.5）；
  - 等价表是否有效；
  - 然后列出当前 cwd 最近的记录（最多 300 条）：时间、实例、发出模型、响应模型。
- **`clear`**：确认后在锁内清空当前 cwd 文件（语义见 §6）；失败时保留原文件并报告。
- TUI 使用列表菜单，非 TUI 使用 `notify`；不把原始 JSON 直接写 stdout。
- 命令与 root lifecycle 必须在 `extensions/index.ts` 的 gateway try/catch 之前单独注册，gateway 失败不得连坐。
- README 中文、英文两份同步更新。

## 8. 开关与配置

| 项 | 默认 | 作用 |
| --- | --- | --- |
| `LLMGATES_MODEL_AUDIT` | 开 | 关闭 observer、root marker、历史追加和状态后缀；不影响既有 TPS。每个扩展实例在 `session_start` 读取一次，进程内修改需 `/reload` 生效 |
| `LLMGATES_TPS` | 开 | 沿用既有 usage policy；不控制审计历史 |
| `model-audit-equivalents.json` | 无 | 用户等价表（§3.6） |

## 9. 改动清单

| 文件 | 内容 |
| --- | --- |
| 新增 `extensions/model-audit/observer.ts` | fetch 包装、SSE 事件解析、廉价过滤与提前停止、bounded buffer |
| 新增 `extensions/model-audit/compare.ts` | 模型归一化、内置网关后缀规则、用户等价表、系列比较 |
| 新增 `extensions/model-audit/store.ts` | 路径校验、roots/records 上限、锁内读改写、原子写、版本/损坏隔离、clear |
| 新增 `extensions/model-audit/runtime.ts` | 每实例 runtime：所有者 marker、非所有者冻结、`turnActive`、`CallAudit`、payload/fetch 接入、观察计数、有界 flush |
| 新增 `extensions/model-audit/command.ts` | `/model-audit` |
| `extensions/compat/index.ts` | `RegisterCompatGatewaysOptions` 接收审计 runtime 并传给 `createCompatProvider` |
| `extensions/compat/provider.ts` | `stream` / `streamSimple` 接入 runtime |
| `extensions/tps.ts` | audit history 轮询（stat 门控、变化才刷新）、分段拼接与着色 |
| `extensions/tps-stats.ts` | legacy 状态行格式函数返回分段 |
| `extensions/usage/format.ts` | quality-aware 状态行格式函数返回分段，不改变 usage 数据 |
| `extensions/index.ts` | 早于 gateway 注册独立注册 command/root lifecycle，并把 runtime 注入 compat 注册 |
| `README.md` / `README.en.md` | 命令、开关、等价表、覆盖边界 |
| `docs/pre-publish-gate.md` | §4 增加审计验证项 |

## 10. 测试与门禁

### 10.1 Focused tests

- `observer`：
  - 三种 API 的真实事件形状，包括嵌套 `event.response.model` 与 Anthropic `message_start`；
  - 跨 chunk、CRLF、多 `data:` 行、终止事件；
  - “首个声明一致、后续不同”的 completions 流必须判为不同；
  - 结论确定后停止解析；
  - 非 2xx、body 为 null 的 2xx、content-type 参数、无模型、超限；
  - abort 与流错误时透传的错误对象不变。
- `compare`：大小写、前缀、日期、`-latest`、mini 等示例；调研确认的网关后缀；等价表生效、格式错误整份忽略。
- `runtime`：
  - `onPayload` 改写模型，返回值与异常原样透传；
  - 非所有者不能轮换或删除 marker，同一模块图中两次 factory 调用互不共享所有者状态；
  - 非所有者冻结快照：父会话进入下一轮后，子实例的请求仍用启动 Turn；
  - `turnActive` 防护；`/reload`、`/resume` 后 originTurnId 不相撞；
  - marker 校验失败时视为不存在；
  - 锁被占用时 shutdown 在 1.5 秒内返回；
  - `LLMGATES_MODEL_AUDIT=0` 完全不包装。
- `store`：
  - 计数不受 300 条记录截断影响；roots 与 turns 上限；
  - 按 cwd 隔离；并发追加与 clear；
  - `version` > 1 只读；损坏文件隔离后新建；
  - 权限修正只作用于 `model-audit` 目录；锁失败状态。
- `tps`：legacy 与 quality 两条状态行的分段拼接与着色、审计不进入 usage ledger、Turn/All 取自 roots、stat 未变不读文件、后缀不变不 `setStatus`、0 次隐藏。

### 10.2 发布前门禁 §4 新增项

使用 loopback 假网关返回与请求不同的模型：

1. openai-responses、openai-completions、anthropic-messages 各测一次：历史有记录，状态行有 `.x1`，命令可见。0.83+ 上 `/model-audit` 本进程计数中，三种 API 的 `response` 都必须大于 0。
2. 返回日期后缀或 `-latest` 变体、§2.1 调研确认的网关后缀模型、等价表中的配对：均不计数、不写历史。
3. pi-subagents 前台、后台，以及 pi-subagents-lite 前台、后台（明确启用本插件扩展；若 lite 在目标 pi 版本上无法运行，记为未覆盖，不算通过）：
   - 记录写入父 history path，rootSessionId 正确；
   - 父会话已进入下一轮时，子代理晚到的记录仍计入启动 Turn；
   - 子代理结束后，父 marker 仍在，且 originTurnId 未被改写。
4. 在子代理 worktree cwd 中运行：记录仍写父 history path。
5. `LLMGATES_TPS=0` 时 usage 仍关闭，但审计历史按设计独立；`LLMGATES_MODEL_AUDIT=0` 时没有 wrapper、marker、写入和后缀。
6. `/new`、`/resume`、`/reload` 后 Turn 不串号；人为占住历史文件锁时，退出与切换会话在 1.5 秒左右返回。
7. 0.81.0 floor、0.86.0 upper-bound gate 未通过前，不宣称 peer 范围已认证。

### 10.3 版本约束（D4）

- peer 上界放宽前，三种 API 的 fetch hook 必须在目标版本门禁中实际触发并记录 mismatch。
- 0.81.0 尚未与 0.81.1 等同认证；若不补测，应把支持下限写成已验证版本，而不是泛称整个 peer 范围。
- 本机 pi 0.87.0 超出当前 `<0.87.0` peer；0.87 只能作为额外观察，不能替代 0.86.0 gate。

## 11. 已知限制

- 只能看到上游自报模型名；没有模型名不能证明没有路由。
- 网关对自己的映射改回客户端模型名时，插件看不到该内部映射。
- pi-ai 0.81–0.82 的 Responses / Anthropic 没有 fetch/字段观察能力。
- content-type 不是 `text/event-stream` 的流式响应不观察，只计入 `none`。
- 记录列表只保留最近 300 条；计数表最多保留 100 个 root，更早的 root 被淘汰后，resume 该会话时 All 从 0 开始。
- clean-env 子进程成为独立 root，父会话不可见；外部 CLI、未使用本插件 native provider 的自定义模型不覆盖。
- bash 中嵌套启动的 pi 会继承 marker，计入当前 root 与 Turn。
- 用户新 prompt 触发的预压缩发生在 `before_agent_start` 之前，归入上一轮（与 TPS 的压缩归属一致）。
- 写入失败、隔离与 shutdown 未完成写入的计数只覆盖本进程。

## 12. 实施顺序

1. 完成 §2.1 的 NewAPI / CLIProxyAPI 调研，把结论与来源写回本文。
2. `compare` + `observer`：纯函数、真实事件形状和 bounded parser 测试。
3. `store`：路径校验、权限、roots/records 上限、锁、原子写、版本/损坏与 clear 语义。
4. `runtime`：所有者/非所有者、冻结快照、`turnActive`、payload/fetch wrapper、观察计数、有界 flush。
5. compat 注入与 provider 接入、loopback 测试。
6. `/model-audit`、单一 history poller、分段状态行后缀。
7. README、pre-publish gate 和 0.81.0/0.86.0 兼容验证。
8. 按 §10.2 完成真实 pi 安装包门禁；未通过前不进入发布流程。

## 修订记录

### 第 2 轮（2026-09-22）

| 问题 | 修订 |
| --- | --- |
| 进程内子会话（lite、runner 内子会话）会轮换或删除共享 marker | §4.1 增加所有者规则，所有者状态放在 factory 闭包 |
| 按请求读取 marker，进程内后台子代理会串到父会话后续轮次 | §4.2 非所有者在 `session_start` 冻结 root context |
| shutdown 无上限等待 flush，最长可达数十秒 | §4.4 flush 最多等 1.5 秒 |
| 300 条上限按 cwd 共享，All 会变小 | §4.3 / §6 计数写入 `roots`，与记录列表分离；clear 语义写明 |
| originTurnId 可能在 reload/resume 后相撞 | §4.1 改为 `${token}:${seq}` |
| 只调研 sub2api，网关别名后缀会误报 | §2.1 补调研任务；§3.6 内置规则只收录已证实后缀，并增加用户等价表 |
| completions 取首个声明，与 pi-ai 字段口径不一致而漏报 | §3.3 改为取第一个系列不同的声明，结论确定后停止解析 |
| `unobservable` 需要版本探测且门禁无处可看 | §3.5 改为按 API 的观察计数，在 `/model-audit` 与 debug 汇总中输出 |
| clean-env 与“未归属”定义矛盾 | §4.3 统一定义 |
| marker 外泄、historyPath 被直接信任 | §4.1 精简字段（删去 `rootPid`）、增加校验并如实写明可见性；§6 限定 chmod 范围 |
| 损坏文件导致该 cwd 审计永久失效 | §6 隔离后新建；`version` > 1 只读 |
| 状态行改动清单缺 `tps-stats.ts`，空闲轮询会反复重绘 | §5 / §9 分段格式；§4.4 stat 门控、变化才刷新 |
| 过度设计 | 删去请求 body 解析、非流式 JSON 分支、独立写队列、`unobservable` 提示与 `rootPid` |
