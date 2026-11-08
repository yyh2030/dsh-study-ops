# @local/study-ops

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)写的研究插件:实验运行台。把参与者表、访视任务记录、预约与随访规则读成一块可以每天盯着看的进度板。

版本 0.3.0 · 需要 DSH ≥ 0.2.2-rc.1 · MIT 许可 · 依赖 [`@local/research-core`](https://github.com/yyh33028-netizen/dsh-research-core)

## 为什么需要它

跑一项纵向研究,真正花时间的往往不是分析,而是每天那几件琐事:谁今天该来、哪一格的记录还没落、某个编号为什么出现了两份互相矛盾的作答、下周该提醒谁回来。这些信息在真实项目里通常散在几个 CSV、一张 Excel 主表和某人的记忆里。

运行台把它们放在同一个视图下:一张按访视展开的参与者×任务矩阵,加上异常列表、随访到期列表和预约日历。它只读来源表并记录人工判断,不替你改原始记录,也不推断"这个人其实做完了"。

## 能做什么

- **参与者进度矩阵**:按访视组织任务列,单元格显示采集状态与质量状态;支持「全部 / 有异常 / 待随访」筛选,点击单元格可看来源、状态依据与冲突记录。
- **重复作答裁决**:同一参与者×访视×任务下有多份记录时标为冲突,由你在核对后选一份并留理由,可撤销。
- **分组与汇总**:按研究定义里的组别列出分组卡片,给出总人数、入组人数、任务完成份数、异常与随访计数。
- **随访提醒**:由 `followups` 规则驱动,锚点取该访视全部必需且适用任务中唯一有效完成的最晚日期,区分到期与逾期;可人工标记完成并保留理由。
- **预约管理**:录入日期、起止时间、资源或地点,校验真实日历日期、结束晚于开始,并检查同参与者或同资源的重叠。
- **异常处理**:异常绑定具体观测与规则指纹,忽略后内容变化会重新提示;导出 JSON 与异常 CSV 时带上 active/dismissed、时间、备注、规则与观测指纹。
- **材料接入检查**:扫描材料目录得到清单、解析状态、覆盖率、候选与缺项;`prep_readiness` 把材料覆盖、配置草案、统计环境、演练四块分开判定,列出阻断项与待核实项。
- **研究草案**:从已扫描候选生成研究定义草案并预览 diff,只采用已确认且非待映射的候选,不自动批准计分冲突。
- **核心读取**:可以从核心投影读,也可以读研究定义指定的兼容平面文件;界面上会标明当前用的是哪一路来源。

### Agent 工具

插件注册 13 个工具,查询类默认只返回编号与计数,不含逐人明细:

| 工具 | 用途 |
|---|---|
| `study_binding` | 当前会话绑定的研究身份、解析来源、各插件是否一致 |
| `study_status` | 参与者进度、来源健康、异常与随访计数 |
| `study_data_health` | 各数据集已提交代次与兼容平面文件的状态、大小与版本 |
| `flow_projection` | 总人数与入组、性别构成、分组卡片、任务状态汇总、异常与随访计数、来源健康 |
| `participants_manage` | 登记参与者、改状态(不自动入组)、改号(保留旧号与历史) |
| `observations_manage` | 发布标准 observation、裁决重复作答、撤销裁决 |
| `task_import` | 导入任务 CSV/TSV/XLSX:preview 显示列映射,commit 发布为 observation |
| `followup_manage` | 查看随访到期与完成情况,或人工标记完成 |
| `study_schedule` | 为当前研究添加或删除访视预约 |
| `materials_scan` | 扫描材料目录并保存派生索引 |
| `prep_readiness` | 材料接入与实验准备度判定 |
| `study_draft_preview` / `study_draft_save` | 生成研究配置草案、预览 diff、保存 |

工具和界面走同一条 `binding.read` / `binding.write` 路径,所以工具改完的面板会看到最新状态,版本冲突的判定也一致。

## 安装

研究插件套件用同一套安装方式:五个仓库放在同一层目录,业务插件用 `link:` 装进 profile。

```powershell
git clone https://github.com/yyh33028-netizen/dsh-research-core.git
git clone https://github.com/yyh33028-netizen/dsh-study-ops.git
dsh plugin --profile <profile> add link:<父目录>\dsh-study-ops
```

也可以直接用 git 形式:

```powershell
dsh plugin --profile <profile> add git+https://github.com/yyh33028-netizen/dsh-study-ops.git
```

两种方式都要求 `research-core` 与本插件同级 —— 插件用相对路径 `../research-core/host.mjs` 引用共享核心。仓库是私有的,安装前需要有访问权限。装完重启承载 `dsh web` 的进程;客户端面板改动还需要刷新页面。

## 配置

插件配置项:

| 键 | 默认 | 说明 |
|---|---|---|
| `studyPath` | 空 | 研究定义 JSON 路径;为空时界面显示空研究并允许接入 |
| `projectRoot` | 会话工作目录 | 相对路径的基准,也是未配置研究时的默认根 |
| `pythonPath` | 运行时 Python | 读 `.xlsx` 材料时用;也可用 `DSH_MATERIALS_PYTHON` 覆盖 |

研究定义(`schemaVersion: 1`)里与运行台相关的部分:

```json
{
  "schemaVersion": 1,
  "studyId": "sample-study",
  "name": "示例研究",
  "dataRoot": "./data",
  "participantId": { "pattern": "" },
  "participants": {
    "path": "./participants.csv",
    "idColumn": "participantId",
    "statusColumn": "status",
    "enrolledValues": ["enrolled", "completed"],
    "groupColumns": ["group"]
  },
  "visits": [{ "id": "v1", "label": "基线", "order": 1 }],
  "tasks": [{ "id": "t1", "label": "问卷", "visits": ["v1"], "required": true }],
  "followups": [{ "id": "f1", "label": "一周随访", "anchorVisit": "v1", "offsetDays": 7, "earlyDays": 1, "lateDays": 3 }],
  "plugins": { "ops": { "recordsPath": "./records.csv" } }
}
```

- 记录表是长表,必需列 `participantId,visitId,taskId,status,date,recordId`,状态取值 `complete` / `pending` / `failed` / `unknown`。记录必须关联到参与者表、已定义访视与适用任务;`date` 为有效 `YYYY-MM-DD`;`recordId` 非空且唯一。
- 任务可设 `visits`、`required: false`、`appliesTo: { "group": ["A", "B"] }`。不适用的任务显示"不适用",可选任务缺失不算异常。
- 运行台自己的状态写在 `<dataRoot>/ops/<studyId>/state.json`,带 `stateRevision`。每次写入必须携带当前版本,旧页面或并发修改返回 409;同路径写入排队,并用独占锁防止其他进程同时写。进程异常退出留下的 `.lock` 需要由操作者在确认进程结束后手动移除,查询不会自动修复它。

### 私有研究适配器

需要兼容既有私有目录结构时,在配置或研究定义的 `plugins.ops.adapterPath` 里显式指定一个模块。它导出 `createAdapter({ study, config })`,返回 `snapshot(options)`、`mutate(action, payload)` 和可选的 `export(snapshot)`,快照结构必须与通用矩阵一致。通用包不做私有路径自动发现,也不内置任何研究专属解析器、规则或默认材料。

## 接口

同源 `/api/study-ops`,请求头 `x-study-ops: 1`。GET 只有 `status` 与 `subject`;POST 的 action 支持 `refresh`、`schedule`、`attendance`、`followup`、`dismiss`、`restore`、`export`、`studyConnect`。所有变更、导出、重新检查与研究切换都携带当前 `studyId`、`studyRevision` 与 `selectionRevision`;状态修改还要带 `stateRevision`。

研究切换通过共享协调器传播到其他已注册的研究插件:任一插件忙或校验失败时整次切换不生效,不会出现一半插件在新研究、一半在旧研究的状态。

## 数据与隐私

- 本地优先:不联网,不发外部请求;材料扫描只读目录,不移动、不改写文件。
- 不存姓名与联系方式:编号是任意符合 `participantId.pattern` 的非空字符串,前导零保留,姓名不决定入组。
- 汇总工具默认不返回逐人明细;`flow_projection` 只给人数、分组、状态与计数。
- 材料解析失败的条目会明确列为未覆盖,不会用猜测内容填充。

## 已知限制

- 不做统计,也不改原始记录;`complete` 只表示来源表确认完成,不评价任务质量。
- 尚未实现任意相对访视时间窗:没有时间定义时,已入组者的必需任务按"应记录"检查,不按天数推算。
- 纯预约与缺席不会生成访视完成或随访锚点。
- 状态锁只保证同进程排队加跨进程独占,`.lock` 残留需要人工确认后清理。
- 私有适配器的历史与阶段规则由适配器自己维护,插件只负责展示。
- 仓库内没有独立测试目录;涉及本插件路由的测试在 `research-core/tests/study-ops-routes.test.mjs`。

## 许可

MIT。仓库里还没有放 `LICENSE` 文件,公开发布前需要补上。
