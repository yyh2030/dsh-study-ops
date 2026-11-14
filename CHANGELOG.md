# DSH 研究插件套件 · 变更日志

> 规则：每次改动/调整都在本文件追加一条，注明日期、插件、版本、问题 ID、改了什么、验证方式。
> 修复阶段的详细验收记录在 `reports/research-plugin-remediation-20261108/` 各阶段完成记录里。

## 2026-11-10 · 07 隐私执行与分享边界（P01/P02 接入，P03/P04 边界）

- **research-core 1.4.0（本轮未升版本号）**（新增 `privacy-projection.mjs`；`results.mjs`；`package.json` 导出）
  - P01：新增 `agentProjection(kind,payload,mode,options)`。strict-local 对 analysis_status/analysis_results/analysis_run/analysis_export/scale_score/材料摘要只返回状态、计数、opaque artifactId（`art-<sha16>`）和 blocked 原因；summary-cloud 按顶层字段白名单过滤，未知字段或超过 32 KiB 的载荷整体返回 `policy_blocked`；`local` 只授权本机界面，Agent 仍走最小化。模式只从 `ctx.get('privacy')` 服务、研究 `plugins.<plugin>.privacyMode` 或插件配置 `privacyMode` 读取，缺省 strict-local，工具参数不能放宽。
  - P02：新增 `shareProjection(results,{meta,artifacts,allowedColumns})`：study 仅保留 id/name/version（path/dataRoot/config 去掉）；显示名含路径/邮箱/URL/控制字符时整段隐藏；表按列 schema、声明类型与角色过滤，participantId/姓名/电话/邮箱/地址/备注/自由文本与未知列默认不保留，`group` 等分类列和数值列保留（不按“值像数字”误判）；图注/正文/警告/节点错误同策略，含路径或联系信息的自由文本整段隐藏；manifest 只保留相对路径；`notes` 明示“自由文本/图片元数据不能仅靠规则保证匿名”。
  - 路径与错误：`scrubText` 覆盖 `C:\`、`\\server\share`、`\\?\`、`/home`、`/Users`、`/tmp`、`~/`、URL/邮箱/证件/手机号/文件名；`sanitizeError` 去路径与逐人编号，丢弃 details 与异常栈。
  - 结果对象：`buildResults` 保留列 `role`；analysis-run `results()` 透传 meta 表的 `types/analysisSet/nodeId`，使分享过滤按 schema 而不是按值推断。
- **analysis-run 0.5.0（本轮未升版本号）**（`index.js`）：analysis_results/analysis_status/analysis_run/analysis_export 工具返回全部经过 `agentProjection`；exportRun 用 `shareProjection` 生成 report.html、results.json、tables.docx/tables.xlsx 与 manifest（标题和表值同策略，manifest 相对路径）；图表 label/subtitle 先 `scrubText`；路由错误改用 `sanitizeError`。
- **scale-desk 0.3.0（本轮未升版本号）**（`index.js`）：`scale_score` 只把计数/汇总（summary-cloud 含量表名与波次人数）交给 `agentProjection`，逐人分数、题目原始值与编号不出工具；工具参数不能改 privacyMode；路由错误脱敏。
- **study-ops 0.3.1（本轮未升版本号）**（`index.js`）：`materials_scan`、`prep_readiness`、`materials_decisions`(list) 文本摘要经 `agentProjection` 投影（材料目录/文件路径、逐人编号、联系信息去除）；路由错误脱敏。`materials_decisions` set 的“刚写入什么”确认仍回显 label，未改 06 材料解析/草案逻辑。
- 测试：新增 `tests/remediation-07.test.mjs` 10 例：P01-A（analysis_results/analysis_status、scale_score、materials 摘要的真实工具路径）、P01-B（summary-cloud 白名单/未知字段/超大载荷 + 真实工具）、P02-A（研究名/列名/表值/图注/错误 + 真实导出 HTML/JSON/manifest）、P02-B（ID001 与组 A/B 保留、敏感列过滤）、P03-A（unenforceable 且不伪造已阻止）、P03-B/P04 边界、策略读取与错误投影。`cd D:\dsh-plugins\research-core; node --test "tests/*.test.mjs"` → **193 tests / 193 pass / 0 fail**（基线 183 + 新增 10，未删改旧断言）。
- P03/P04 边界：strict-local 只保证插件工具返回最小化；当前通用会话存在 read/pwsh/附件/浏览器/MCP 旁路时返回 `enforceability.unenforceable=true`，没有工具清单时返回 `'unknown'`，不宣称“已阻止”。P04-A 需要宿主侧捕获真实模型请求/通知载荷，P03-B 需要断网本地模型/模板全链路，本轮没有伪造这两项；测试注释已写明。自由文本名称、图片元数据、自定义脚本表格仍可能需要人工审阅。
- 范围说明：未改 06 材料解析/绑定逻辑；未抓真实数据/凭证；未 git commit/push。

## 2026-11-10 · 06 页面工作区/标签绑定（U01/U02，页面身份侧）

- **research-core 1.4.0**（`client-identity.mjs`、`host.mjs`、`index.mjs`）
  - U01-A：新增共享 `client-identity.mjs`（浏览器可用、无 Node 依赖），四个 client bundle 由 `research-core/scripts/sync-client-identity.mjs` 嵌入同一实现；pageId 首次生成立即写入 sessionStorage 共享键 `dsh:research:page:v3` 与插件前缀键 `dsh:research:page:v3:plugin:<plugin>`，同标签四插件共用一个 pageId，不同标签不串；刷新读取已有 pageId 保持不变。
  - U01-B：没有 sessionStorage（隐私模式/禁用/为空）时使用本标签 window 上的进程内唯一 ID，不再共用 localStorage 的 `default` 常量；用 BroadcastChannel + 标签指纹握手检测克隆标签复制 sessionStorage，克隆标签改生成新身份并写回自己的存储，原标签不变。
  - U02-A：页面请求同时带 pageId、workspaceId（来自 `uiWorkspace` 当前会话所属工作区）与本地绑定代次；`host.mjs` 的 `pageActor` 只信宿主注入的 workspace/session，客户端 workspace 必须命中宿主工作区清单，页面自报 sessionId 直接拒绝，声明与注入不一致返回 `workspace_mismatch`；核心令牌增加工作区指纹，同一页面换工作区即使研究没变也推进 `bindingRevision`，旧令牌写入被 409 拒绝。
  - U02-A 客户端：每次请求 capture 页面/工作区/绑定代次，响应回来核对 pageId、workspace、bindingRevision、studyId、instanceId，晚到旧响应抛 `stale_response` 且不更新 activeBinding；同标签切换工作区清空旧令牌。
  - 草稿键：study-ops 焦点提示改为 `dsh:research:focus:v2:<instanceId>:<dataset>`；analysis-run 方案草稿改为 `analysis-plan:v2:<instanceId>:<studyId>:<dataPath>`；demographic-coder 数据集草稿改为 `dc:dataset:v3:<instanceId>:<studyId>:<dataset>`，同 studyId 的不同实例/数据集不再交叉恢复。
  - 保留“页面缺令牌则拒绝”（`binding_required` 409）与旧页面/会话绑定行为。
- **study-ops 0.3.1 / scale-desk 0.3.0 / demographic-coder 1.2.0 / analysis-run 0.5.0**（`client.js` 浏览器半）：统一改用共享身份模块；请求头带 `x-dsh-workspace`，请求体带 workspaceId/bindingRevision；连接/保存/重连走 `identity.newPage()`；scale-desk 只读取当前实例+数据集对应的焦点提示键。
- 测试：新增 `tests/remediation-06-binding.test.mjs` 6 例——两标签两工作区四插件 pageId 一致且不串、克隆/无 storage/空 storage 唯一身份、四插件切工作区后旧响应按 workspace/study/instance 拒绝、宿主旧 A 令牌写 B 被拒且同研究换工作区推进版本、草稿键含 instanceId+数据集、四份 client 预置段与共享模块同源；测试真实加载四个 `client.js` 并用真实 study-ops 路由 + 研究核心。`cd D:\dsh-plugins\research-core; node --test "tests/*.test.mjs"` → **183 tests / 183 pass / 0 fail**（基线 177 + 新增 6，未删改旧断言）。
- 范围说明：本轮只做页面身份与绑定（U01/U02）；未改 07 隐私边界，未改材料侧扫描/草案逻辑，未写真实研究数据。

## 2026-11-10 · 06 材料扫描与可审阅草案（材料侧）

- **research-core 1.4.0**（`materials.mjs`）
  - M01：中文/特殊字符标签不再被 slug 成 `-`；访视/任务 ID 改为 `visit-<sha12>` / `task-<sha12>`（类型前缀 + 来源/candidate 稳定 hash），label 保留原文；同名不同来源 ID 不同，显式改 label 不改既有 ID；任务默认 `visits: []`、`required: false`、`visitMapping: 'pending'`，只给 `suggestedVisits` 建议，不自动进入必需矩阵。
  - M02：扫描记录 attempted/notScanned 与 complete/incompleteReasons；file/byte/time/depth 上限或 permission 失败时 `complete=false`、`truncated` 同步；上一轮已知但本轮未遍历的文件标 `not_scanned`，不判 `removed`；覆盖率分母含已知未尝试文件（`coverage.files`，另给 `attemptedCoverageRatio`），报告显式声明扫描是否完整。
  - M03：解析缓存键加入 parser 版本、解析脚本/能力指纹（Python 路径、PDF 库）、规则与 parse limits；环境补齐后缓存键变化，自动重试同一文件的旧失败/未解析状态；新增 `retryUnparsed`/`retryPaths`/`retry` 显式重试。
  - M04：候选新增确认/拒绝/待映射状态（默认 `pending`，observed 不自动算接受）；`decisions.json` 持久化，重新扫描按来源 sha 保留有效决定，来源变化标 `needs_review`；preview 生成 `draftId` + `revision` 并保存快照，save 接受同一 `draftId`/`expectedRevision`、不重新随机；缺 studyId 时用材料目录指纹保证 preview→save 身份一致；更新以现有定义为基础合并，保留 `plugins`/`dataRoot`/`participantId`/已有访视与任务，列出草案未提到的行。
  - M05：`assessReadiness` 按 import/scoring/run/analysis 四阶段分别给出 state/blockers/pending；dryRun 非 `passed` 时 run 与 analysis 阻断，统计后端缺失时 analysis 阻断；`canStart` 只有在所有阶段 ok/not_applicable 时为真；支持 `analysisNotRequired`/`statisticsNotRequired` 让不需要统计的项目仅对相应任务就绪；统计环境优先读取真实配置后端，缺配置时才退回 Python 依赖探测。
- **study-ops 0.3.1**（`index.js` 路由）
  - `materials_scan` 应用持久候选决定并汇总扫描完整性与决定计数；新增 `retry` 参数。
  - 新增 `materials_decisions` 工具（list/set），提供可发现的候选确认入口。
  - `study_draft_preview` 返回/持久化 draftId+revision，更新预览先与现有定义合并并展示删除项；`study_draft_save` 支持 `draftId`，校验预览内容与现有文件版本后再写，更新同样走合并。
  - `prep_readiness` 输出四阶段状态与阶段阻断原因；路由读取 `config.statisticsBackend` / `config.dryRun`。
- 测试：新增 `tests/remediation-06.test.mjs` 5 例（M01-A/M02-A/M03-A/M04-A/M05-A，全合成材料，含 study-ops 路由级 M04/M05）；`cd D:\dsh-plugins\research-core; node --test "tests/*.test.mjs"` → **177 tests / 177 pass / 0 fail**（基线 172 + 新增 5，未改旧断言）。
- 范围说明：本轮只做材料侧 M01–M05；U01/U02 页面工作区/标签绑定与 07 隐私边界留给下一轮，本轮未改 `study-ops/client.js` 的页面绑定逻辑。

## 2026-11-10 · 05 自动分析与缓存

- **analysis-run 0.5.0 / engine 2.4.0**
  - A01：外部脚本字节在准备阶段冻结进 `plan.script.code` 与 fingerprint，快照写 `code/<name>`，执行只用快照。
  - A02：表文件记录 sha256；`cache_artifacts_ok` 校验 input 与所有表存在且 hash 一致，坏缓存跳过；新增 `forceRecompute`。
  - A03：自动请求指纹改为 study + 完整 plan + dataset hash；失败暂停键改为完整指纹。
  - A04：interval/初始 timeout/debounce 登记 disposers，`ctx.effect` 卸载时清理。
  - 测试：`tests/remediation-05.test.mjs` 4 例；全套 168/168。
- 记录：`05-完成记录.md`（A05 未做，A03/A04 调度测试未做）。

## 2026-11-10 · 04 量表分数与发布

- **scale-desk 0.3.0**：recordId 带 submissionId；`scores` 数据集；save/import/answer/score/export 后自动发布；outbox + `publishRetry`。
- **research-core 1.3.0**：analysis 支持 `type:'score'` 变量，缺失带 `missingReason`；manifest 记录 scores 代次。
- 测试：`tests/remediation-04.test.mjs` 4 例；全套 164/164。

## 2026-11-08 · 03 图表与 Office

- **analysis-run 0.4.0 / engine 2.3.0**：Office 小数不再归零；XLSX 数值类型 + number_format；图读 `meta.charts`；每表 analysisSet/types；`"001"` 保真。
- **research-core**：`tableFromGrid` 支持声明类型；箱线须取围栏内真实极值。
- 测试：`tests/remediation-03.test.mjs` 7 例；全套 160/160。

## 2026-11-08 · 02 统计输入与推断

- **analysis-run 0.3.0 / engine 2.2.0**：`module_columns` + `prepare_frame` 统一输入；每 scope 门槛；偏相关 df；Table1 按人去重；信度声明量尺与 corrected 题总；零方差 t 明确失败；节点 `analysisSet`。
- 测试：`tests/remediation-02.test.mjs` 10 例；全套 153/153。

## 2026-11-08 · 01 数据身份锁与健康

- **research-core 1.2.0**：实例断言、锁状态机、提交指针、`commitMany`、`reconcile`、复合人口学提交、健康错误区分。
- 测试：`tests/remediation-01.test.mjs` 11 例；core 143/143。

## 2026-11-10 · 05 补充（A05 句柄捕获）

- **analysis-run 0.5.0**：scheduleDebounced 在排队时捕获 studyState（cfg/context），回调与失败/成功状态都写到捕获的研究目录，不再用执行时的 current()；eadAutoState/writeAutoState 显式接收 cfg。A05 仍缺双研究交错集成测试。
- 验证：
ode --check + 全套 168/168。

## 2026-11-10 · 05 补充（自动调度 seam 与 A03/A04/A05 测试）

- **analysis-run 0.5.0**
  - 新增 `analysis-run/scheduler.mjs`：`createScheduler({ config, current, run, analysis, readAutoState, writeAutoState, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn })` 与纯函数 `requestedKey()`；requestedKey = sha256(JSON.stringify({ studyId, plan, datasetHash }))。
  - tick 只读一次 `current()` 并把快照用到结束；auto-state 键未变直接返回；否则比较最新 run 的 dataset hash 与 plan，去抖排一次 run；失败暂停键为完整 requestedKey，成功后写 auto-state。
  - 排队回调只用排队时捕获的 studyState（含 cfg.outputDir 与 context），不在回调里读 current()（A05）；dispose 清 interval、初始 timeout、debounce 并清空 disposer，之后 tick/schedule 不再启动任务（A04）。
  - `index.js` 改为注入 `createScheduler`，run 前 LOCKS/WRITES guard 与旧 `startAuto()` 接口保留，`autoTick` 动作与 status 的 autoError/autoTicks 不变；`runs(cfg, study)` 显式接收捕获的 context。
  - 新增测试 `research-core/tests/remediation-05-scheduler.test.mjs` 4 例，只测 scheduler 模块并用假时钟：A03-A（同 dataset 改 plan 触发一次、plan 不变不触发）、A03-B（失败暂停、plan 变后恢复）、A04-A（dispose 后推进假时钟不运行且无新 timer、新实例才工作）、A05-A（A 排队后 current 切 B，回调仍用 A 的 cfg.outputDir/context）。
  - 验证：`node --test "tests/*.test.mjs"` → 172 通过 / 0 失败（原 168 + 新增 4）；`node --check analysis-run/index.js`、`node --check analysis-run/scheduler.mjs` 通过。

## 2026-11-11 · 09 独立安装（B01）

- 四个业务插件改为 @local/research-core 包名导入（exports 子路径），package.json 声明 file:../research-core；开发/测试用 D:\dsh-plugins\node_modules\@local\research-core junction。
- 新增 tests/remediation-09.test.mjs：干净临时目录 + 包名依赖真实 import 两个入口。
- analysis-run 导出常量同步 0.5.0；npm pack dry-run 27 files/48.6MB，含 vendor/wheels。
- 验证：remediation-09 通过；全量 194/194。
- 未完成：scale-desk 旧测试 19/28 失败、GUI 验收、迁移演练、跨平台 wheel。

## 2026-11-11 · 09/T01 scale-desk 旧测试夹具升级

- **scale-desk 0.3.0（仅测试/夹具）**：新增 `tests/support/host.mjs`（临时研究 store、workspaceRegistry/sessions/workingDirectory 宿主入口、每页随机 pageId + `studyConnect` 令牌）；`tests/batch1.test.mjs`、`tests/study.test.mjs`、`tests/smoke.mjs` 改为临时 `study.json`（含 tasks/visits/plugins，dataRoot 指回原临时 lab）+ 真实 Host 路由 + `x-dsh-page`/`x-dsh-workspace` 头与绑定令牌。未删测试、未弱化断言；只在旧契约处更新期望并写明原因：Excel 式 `12345.0` 按 `normalizeId` 归一为 `12345`；07 严格本地投影不再返回逐人 duplicate 原因，改断言 `status missing`/`records 0`；`resolveImport` 会自动换编号列重试，旧“后段 pattern 拒绝”不可达，改用同样写前抛出的未知波次验证导入原子性；A-B-A 旧页面拒绝改用旧 binding token，并以 store 不可写模拟连接失败验证研究定义回滚。
- 根因分类：19 个失败全部是夹具身份过时（同一类，两个来源）——旧夹具 apply 只给 `{projectRoot,labDir}`，没有 study.json、没有 pageId/令牌，写请求被识别为 probe 并报 `study_missing`；同时进程级默认 store 残留“probe → 已删除临时研究”的记录，使失败在多次运行间复现。`tests/study.test.mjs` 里旧 `researchSelection` peer-busy 机制已被 06 绑定层取代，按当前契约用核心持久化失败验证回滚。
- 验证：`cd D:\dsh-plugins\scale-desk; node --test tests/*.test.mjs` → **28 tests / 28 pass / 0 fail**；`node tests/smoke.mjs` → 通过；`cd D:\dsh-plugins\research-core; node --test "tests/*.test.mjs"` → **194 tests / 194 pass / 0 fail**（未改 research-core 共享代码；此前两次全量分别因 PDF 渲染与 autoRun 去抖在并发负载下超时，单文件复跑与第三次全量均通过）。
- 范围：未写真实研究数据，未 git commit/push。

## 2026-11-11 · 09 私有副本迁移与回退演练（M09）

- **research-core 1.4.0（仅新增测试，未改生产代码）**（新增 `tests/remediation-09-migration.test.mjs`）
  - M09-A：mkdtemp 合成研究写入 2 名参与者、人口学、2 条观察与 2 条分数；记录四数据集 revision/contentHash/generationId 与来源健康（ok），并记分析表基线（2 行、hash）。
  - M09-B：`backup` 到临时目录，核对 backup.json 的数据集清单与 revision/contentHash、逐文件 sha256/bytes、可由清单重算的 digest，以及 `restorePreflight.ok`。
  - M09-C：数据根整体复制到另一临时目录、研究定义复制到影子根；同 instanceId 从新路径读取 revision/contentHash/health 与分析表 hash 均与备份前一致；原数据根逐文件 hash 不变。副本继承实例身份，换新 instanceId 打开返回 `wrong_instance`（<2s）。
  - M09-D：影子副本新增 P-003、一条观察与一条分数，只出现在影子；原根人数/revision/hash 不变。回退前把切换后数据单独 backup；旧备份 restore 到另一个干净根，恢复 2 人旧数据、健康 ok、新增数据不在其中；再用切换后备份 restore，P-003/观察/分数可重放；restore 不删除新增代次。
  - M09-E：`restorePreflight` 对错误实例、schemaVersion=2、不同 studyId、缺 backup.json、篡改数据文件（hash/digest）均返回 ok=false 且 <2s；`restore` 对预检失败抛 `source_invalid`（committed=false），不写当前数据根。
  - M09-F：记录同根就地 restore 的真实限制：只写 current.json，不更新 `transactions/study-pointer.json`；`head()` 取指针与 current 中较大的 revision，因此 restore 返回 `restored:true` 后读取仍是指针指向的切换后更高代次，`reconcile()` 会把 current 补回该代次。回退需另根恢复或先停写后换根，当前 API 没有重置提交指针的入口。
- 验证：`cd D:\dsh-plugins\research-core; node --test "tests/*.test.mjs"` → **200 tests / 200 pass / 0 fail**（基线 194 + 新增 6，未改旧断言）；新文件单跑 6/6。
- 范围：全部 mkdtemp/os.tmpdir 合成数据，`assertInsideTemp` 拒绝真实研究路径字样；未打开/复制/写入 D:\yyh-lab 或真实 study；未改生产代码；未 git commit/push。

## 2026-11-11 · 09 合成端到端脚本（E2E）

- **research-core 1.4.0（仅新增测试，未改生产代码）**（新增 `tests/remediation-09-e2e.test.mjs`）
  - E2E-01 材料：临时目录写中文基线/随访、两份互斥计分规则与中文任务；`materials_scan` → `materials_decisions` 确认 2 访视 2 任务 → `study_draft_preview` → `study_draft_save` → `prep_readiness`。断言访视 ID 为 `visit-<sha12>`、保存与重扫预览 ID 不漂移、同名不同来源不合并、`decisions.json` 保留 kind/label/sourcePath/sourceSha256/reason；计分冲突与未知 dryRun 如实阻断准备度。
  - E2E-02 登记/人口学/入组：先 `participants_manage` 登记 2 人，再用 `flow.demographics.commit` 在同一事务里登记 P-003/P-004 并提交 4 行人口学；核对 participants 只递增一代、demographics revision=1，入组后总男女 2/2，arm=A/B 各 2 人且各 1 男 1 女。
  - E2E-03 量表两波次：基线 4 行（P-001 重复提交 + 修正、P-002 缺一题、P-003 正常）与随访 3 行；首轮计分 P-001 为 conflict、两行 duplicate/null，缺题按比例得 2.67；核心 `observations.adjudicate` 选中修正 submission 后重计分，scores 只给选中行 4.25，被拒行仍保留 null/duplicate/reason；分析表未裁决时为缺失。
  - E2E-04 任务 CSV：同内容提交两次幂等（来源 1 个、观察不重复）；同名不同内容成为第 2 来源版本并只新增本次观察；缺日期列的损坏源提交被拒绝，来源与观察均不增加。
  - E2E-05 source=core 分析：`variables` 含 `type:'score'`（GARDEN baseline/followup）；3 人时 ttest 因 `eligibleSubjects=3 < gate 4` 为 not_run，加 P-004 后 executed；改方案新增 sample、排除 P-002 均产生新 runId/指纹，旧 run 标 stale；脚本同代码复用缓存，改代码生成新 runId 且不复用。
  - E2E-06 导出读回：真实运行 descriptives+ttest 后 `export`，用 python-docx/openpyxl 读回 tables.docx/tables.xlsx：ttest 表 n=8、meanDiff=-6.50、CI 与运行表一致，XLSX 数值类型与 `0.00` 格式正确，DOCX 两位小数一致；分组估计图存在；本机 input.csv 保留 P-001，而 results.json/manifest/HTML/DOCX/XLSX 均不含逐人编号、绝对路径或外部 URL。
  - E2E-07 双研究交错：A/B 使用相同编号 P-001…P-003 与相同量表定义，交错 score A→B→A；A 的 P-001=2、B 的 P-001=4，submissionId 各自归属；页面绑定、`study_status`/`flow_projection` 后台读取均不串研究。
  - E2E-08 锁/崩溃/重启：持锁时另一实例提交在 <2s 内 `dataset_conflict` 且无半成品；坏锁 <2s 返回 `recovery_required` 且不静默删除；修复后可提交；死进程锁被归档到 `transactions/stale` 并继续提交；重新打开数据根后 participants/demographics/tasks revision 与值正确、无待恢复锁。
  - E2E-09 断网/本地：把 `globalThis.fetch` 换成抛错函数后仍完成本地分析与导出（fetch 调用 0 次）；report.html/results.json/manifest.json 无外部 URL、无逐人编号、无本机路径；Agent `analysis_status` 摘要同样不带路径/编号；静态核对三个业务插件未引入 fetch/node:http(s)。
  - SKIP-09-9：提醒创建/改期/解除/回执与手机状态属于 08 阶段、需要官方 gateway，按任务说明 skip 并写明原因，不用本地 stub 伪造。
- **发现的问题（记录，不擅自改语义）**：`research-core/analysis.mjs` 的 `scoreByKey` 对同一 `(participantId, scaleId, waveId, subscaleKey)` 只保留第一条分数行；当重复提交的两行同 key 且被拒行（numericValue=null）在前时，即使核心已裁决选中另一 submission，分析表仍读到缺失。E2E-03 用 `t.diagnostic` 与显式断言记录该现状；E2E-05 用无歧义单一 submission 覆盖 source=core score 变量。修复建议：优先选 `selectedSubmissionId` 对应行或 numericValue 非空行，但本轮未改生产代码。
- 验证：`cd D:\dsh-plugins\research-core; node --test "tests/*.test.mjs"` → **210 tests / 209 pass / 1 skipped / 0 fail**（基线 200 + 新增 10：9 pass + 1 skip）；新文件单跑同结果。未改旧断言，未删旧测试。
- 范围/未覆盖：全部 mkdtemp 合成数据，`assertInsideTemp` 拒绝真实研究路径字样；未打开/复制/写入 D:\yyh-lab 或真实 study；未改生产代码；未 git commit/push。未覆盖实际 GUI 视觉/交互验收、真实提醒 gateway/手机端与真实跨进程 kill 崩溃（E2E-08 用坏锁与“同主机同启动实例、进程已退出”的锁记录模拟）。

## 2026-11-11 · 09 E2E 发现并修复分数选择缺陷

- research-core/analysis.mjs：scoreByKey 不再按文件顺序取第一条；同一 (participant, scale, wave, subscale) 优先 selectedSubmissionId 对应行，其次优先有数值行。修复裁决后被拒行在前导致分析表读成缺失的问题。
- tests/remediation-09-e2e.test.mjs：E2E-03 改为断言裁决后分析层取到 4.25。
- 验证：全量 210 tests / 209 pass / 1 skipped（skip=08 gateway 提醒）。
- 提交：research-core 本次推送。
## 2026-11-11 · 09 B02 支持矩阵

- analysis-run README（中/英）增加支持矩阵与统计后端准备说明。
- 证据：node vendor/install.mjs --check → exit 0；平台限 Windows x64 + CPython 3.12。
- 未验证：macOS/Linux、py3.13、ARM。
## 2026-11-11 · 09 V01 证据与人工清单

- live 检查：Host 工具全部可发现；client slot 未见研究插件专用条目；bsk browsers=[]。
- 新增 reports/.../09-V01-人工验收清单.md（含证据与逐项清单）。
- 未完成：真实页面视觉/交互验收（需浏览器扩展或人工走查）。
## 2026-11-11 · 09 V01 浏览器连接与认证边界

- bsk 扩展实测已连接（实例 ccb9e4a1，Chrome 157 / 扩展 0.4.2 / 协议 1.8）；上一轮未连接是我停掉了 daemon。
- 受控 Chrome 打开 127.0.0.1:55322 被要求认证；DSH 应用窗口自带启动 token，受控 Chrome 没有该 cookie。
- 未提取 token/凭证；需用户提供完整认证 URL 或人工走查 09-V01-人工验收清单.md。
- 其余 09 项不受影响（210 tests / 209 pass / 1 skipped）。
## 2026-11-11 · 09 V01 桌面应用真实验收（部分）

- 用 Windows UIAutomation + 窗口截图在 DSH 桌面应用窗口完成真实验收（浅色、1941x1243）：
  资料板、量表计分（真实计数 72/72、1607 份）、分析直通（本机私有研究、数据已找到）渲染正常；
  侧栏四个插件入口齐全。截图存 reports/.../09-V01-证据/。
- 发现待查：实验运行台显示研究连接·
## 2026-11-11 · 09 V01 键盘遍历

- Tab 顺序覆盖 资料板/人口学录入/实验运行台/量表计分/分析直通，均有可读名称，无焦点陷阱。
- 剩余：深色、长表、PDF/Office、分享审阅（需用户授权）。
## 2026-11-12 · 修复页面写入不携带绑定令牌（P0）

- 根因：06 的共享 client-identity ody() 只发 pageId/workspace/revision，没发 inding 令牌；
  四个服务端 assertWrite 都从 payload.binding 取 token，导致页面写入永远 binding_required，
  横幅一直显示绑定已过期，点重新加载研究只 newPage 不重新 studyConnect，也会复发。
- 修复：ody() 在已记住令牌时发送 inding；重新加载研究改为 newPage → studyConnect(研究路径) → load。
- 新增 tests/remediation-09-binding-token.test.mjs（2 例：body 带 token、四个 bundle 同源）。
- 验证：binding/token 测试 8/8；remediation-06-binding 通过。
- 说明：全量测试在本机并行负载下出现 autoRun/ANA/lock 时序性失败，单跑均通过（见 09-完成记录）。
## 2026-11-12 · 真正根因：客户端用 ticket.token 覆盖了 binding

- study-ops/scale-desk/demographic-coder/analysis-run 的 call() 在 body 里写
  inding: ticket.token，而 ticket 只有 {snapshot,headers,body}，	icket.token 恒为 undefined；
  它把 body() 里正确的 inding 覆盖掉，导致页面写入永远 binding_required。
- 修复：删除四个 client.js 的 inding:ticket.token 覆盖，信任 ticket.body 的 binding。
- 回归：remediation-09-binding-token 增加不得用
## 2026-11-12 · 09 V01 深色主题

- 设置→通用设置→外观→深色，应用整体深色渲染正常；截图 09-V01-证据/设置-深色.png。
- 插件面板未单独深色截图（UIA 点击受 DPI 影响），浅色下已验证；主题可随时改回跟随系统。
## 2026-11-12 · 09 文案与版本一致性

- study-ops 客户端：区分 binding_required（页面绑定已失效，点重新加载研究）与研究变化（binding_conflict/study_missing），
  不再把所有写入失败都显示成研究已变化；记录 staleKind。
- analysis-run：内部 VERSION 常量为 0.2.0 已同步为 0.5.0（与 package/export 一致）。
- 验证：node --check 通过；绑定/路由测试此前 8/8。
## 2026-11-12 · 09 V01 发现分组卡片与核心投影不一致

- 运行台分组卡合计 89，核心 flow_projection 已入组 63、分组合计 63；来源/分母不一致，列 P1 待修。
- 另记录：102? 实际 100 参与者 = 63 入组 + 37 登记未入组；性别 10/43/0/10/0。
## 2026-11-12 · 09 修复分组卡分母

- 运行台分组进度在 core 视图下改用已提交代次的 enrolled 分组与性别，不再混用旧文件分母（89 → 63）。
- study-ops client 修复；node --check 通过；需重启确认。
## 2026-11-12 · 09 V01 合成长表导出与分享泄漏修复

- 120 人合成分析经真实路由导出：correlation 105 行；DOCX 106 行、XLSX 110 行；PDF 6 页。
- 修复分享包泄漏：privacy 过滤 subjectIds 等逐人集合；新增 P02-C 回归测试（11/11 隐私测试通过）。
- 证据：reports/.../09-V01-证据/合成-长表导出/。
## 2026-11-12 · 09 启动一致性回退与测试存储隔离

- 新增 core.legacyStudy()（host 暴露）：无页面/显式路径时，analysis-run/scale-desk/demographic-coder
  回退到 study-ops 注册的 legacy 研究，不再各自落到 study-<空根hash>。
- readCapabilities 自愈：能力查询把各插件 prepareSwitch 到当前页面/会话绑定，未打开过的面板不再误报不一致；busy 时保持原状并如实报告。
- 测试隔离：harness.mjs 默认给每个测试进程 mkdtemp 的 DSH_RESEARCH_STORE，防止测试把临时研究写进用户 store。
- 清理历史测试污染：instances 193→2、bindings 17→13（备份 *.bak-20261112）。
- 测试：新增 remediation-09-fallback 2 例；全量 214 tests / 213 pass / 0 fail / 1 skipped。
## 2026-11-13 · 09 重启后最终验证

- 四插件一致绑定 local-private-research；运行台入组 63、分组 12/15/18/18 合计 63，无绑定过期横幅。
- 证据：reports/.../09-V01-证据/运行台-重启后.png；全量 214/213/0/1。
## 2026-11-13 · followup 01 继续修复（A1—A7）

- core 1.5.0：connect(create:true) 真正创建、已有冲突不覆盖；restore 同根有已提交数据时
  unsupported_restore_target；analysis 依据当前裁决校验分数（撤销=adjudication_revoked，
  改选未重算=score_pending）；flow 裁决版本单调递增。
- analysis-run 0.5.1 / engine 2.5.0：排除内容进入自动运行指纹；缓存要求完整 artifactHashes
  并拒绝缺 hash/篡改/越界；list 分支表格补 analysisSet；engine 直调自加载 vendor 统计后端。
- scale-desk 0.3.1：发布分数冻结 observationId/adjudicationVersion/taskId/visitId。
- 测试：followup-01 6 例、FIX-02 scheduler 1 例、analysis-auto 真实排除补跑、FIX-07 迁移用例；
  全量 222 tests / 221 pass / 0 fail / 1 skipped；scale 28/28。
- 限制：裁决后需手动重新计分；legacy scores 未标记 unverified；创建入口仅 study-ops（02 统一）。
## 2026-11-13 · followup 02 共享研究选择器（B1—B5）

- core 1.6.0：studyChoices（最近研究/作用域/缺失状态）、discoverStudy（三处约定配置）、
  relocateStudy（同数据根才允许移动，复制/分叉冲突）、lastOpenedAt/openCount。
- 四插件路由新增 studyChoices/studyDiscover/studyCreate/studyRelocate；demographic 创建改走核心。
- 客户端：新增共享 client-study-picker.mjs 与 sync 脚本，四插件顶部统一“研究：名称 ▾”入口，
  最近研究、选择文件夹、新建、高级路径、缺失重定位、页面/工作区/会话语义。
- 测试：followup-02 B1/B2/B3/relocate/B4/B5 六例；B6 实际 GUI 验收待重启后进行。
- 限制：未实现“在此研究工作区打开会话”；切换后不自动刷新他插件面板；整体移动身份事务未做。
## 2026-11-14 · 02 选择器可用性修复

- 修复 headers
## 2026-11-14 · 选择器入口始终可见

- 去掉“只在研究面板显示”的可见性门控：此前选择器可能因面板类名判断失败而整块 display:none，
  表现为重启后按钮消失。现在入口始终显示，只保留“离开研究页自动关闭面板”。
## 2026-11-14 · 运行台内“研究切换”入口（v2）

- 浮动入口在部分启动顺序下未挂载，改为同时在运行台头部提供“研究切换”按钮；
  点击时按需创建选择器并打开，失败弹窗显示具体错误（便于定位 client bundle 是否加载）。
## 2026-11-14 · 四插件面板内研究切换入口

- scale-desk / demographic-coder / analysis-run 头部也加入“研究切换”，与运行台一致；
  点击按需创建共享选择器，失败弹窗显示具体错误。
- 浮动按钮不再作为主入口（会被壳层挂载清掉）；正文入口随面板渲染，稳定可见。