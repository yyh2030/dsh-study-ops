# 实验运行台（@local/study-ops）

装在 DSH Web 界面左侧的「实验运行台」：一眼看出**谁入组了、谁缺哪一次、哪份数据可疑、该找谁随访、明天约了谁**。

只读扫描，不改原始数据。写入只发生在 `_lab/`：`state.json`（随访与 T0 覆盖）、`schedule.json`（安排）、`qc-cache.json`（质检缓存）、`export/`（报告）、`demographics.json`（由人口学录入镜像过来）。

## 它读什么

| 来源 | 权威内容 | 用途 |
|---|---|---|
| `Mortality 正式实验材料（主试用）/00_主试操作清单/被试分组名单_全局序号-编号-分组-音频.csv` | 姓名是否已填 = 当天是否已施测 | 入组名单、四格分配、待导入判断 |
| `正式实验数据/DDT/*.csv` | session 001/002/003、participant、date | 实际数据 |
| `正式实验数据/IDM/phase{1,2,3}/*.csv` | 三阶段是否完成 | IDM 进度 |
| `_lab/schedule.json` | 提前输入的编号 + 日期 + 时间段 | 今日/明日安排 |
| `_lab/demographics.json` | 人口学录入的数据集镜像 | 人口学完成度 |

一条硬规则：**名单里填了姓名就算已收，数据可以晚几天导入。** 所以「已入组」= 名单登记或数据到达；两者不一致时标「数据待导入」，不报缺失。

文件名只用来定位；编号与 session 一律以 CSV 里的 `participant` / `session` 两列为准。

## 面板

- **顶部**：已入组 / 目标、名单登记人数、数据待导入人数、近 7 天、速度、预计收完、人口学完成度、异常计数、随访待办。
- **四格**：11 / 12 / 21 / 22 各自的 n / 32（名单登记即计入）。
- **接下来两天的安排**：今天与之后两天的编号、时间段、备注；状态标签「已登记 / 数据已到 / 未到」由数据与名单自动判断，**点一下可手动切换**「已到 → 缺席 → 交回自动」，手动记录写在 `_lab/state.json` 的 `attendance`；可删除；下方表单直接加：编号、日期、开始、结束、备注。
- **矩阵**：一行一个被试，人口学、T0/T1/T2、IDM1–3、随访状态；点一行展开明细（试次数、超时、RT 中位、LL 比例、文件名、人口学已填项、T0 来源）。
- **异常**：每条右侧有「忽略」；忽略后收进「查看已忽略」，可单条恢复或全部恢复。忽略只写 `_lab/state.json`，不动数据，也不影响导出报告里的原始判断。
- **刷新**：右上角按钮绕过 30 秒缓存重扫；切回窗口自动重扫；面板停留时每分钟一次。只有新文件会重新质检。
- **筛选**：全部 / 有异常 / 待随访。
- **导出**：`_lab/export/被试进度与质控_YYYYMMDD.md` 与 `.csv`，含人口学列，不含姓名电话。

## 质检规则

| 检查 | 规则 | 级别 |
|---|---|---|
| 编号格式 | `^[12][12]\d{3}$` | 高 |
| 编号与名单分组码 | 前两位一致 | 高 |
| DDT 三次 | 001/002/003 各一份 | 高 |
| 试次数 | 每 session 60 | 高 |
| 每格试次 | 10 格 × 6 次 | 高 |
| 超时 | 超时试次 > 10% | 中 |
| 过快 | RT < 0.2 s 超过 5% | 中 |
| 过慢 | RT > 10 s 超过 5% | 中 |
| 同 session 多份 | 提示，全部参与统计 | 中 |
| IDM | 三阶段各一份，phase2 有 `_clean` | 中 |
| 名单登记后 3 天仍无数据 | 提示数据未导入 | 中 |
| 随访 | T0 + 7 天，窗口 5–9 天 | 提示 |

RT 口径直接复用 `03_延迟折扣任务与代码/Codes/ddt_extract_rt.py` 的 `parse_file`，不另写一套。4 s 限时是 2026-10-21 才加的，所以「过慢」用 10 s 而不是 4 s。

T0 来源优先级：DDT 的 T0 日期 → `state.json` 里手动填的日期 → 该被试在安排里的日期（今天或更早）。所以名单刚填、数据没到的人，也能算出随访到期日。

## 安装

源码在 `D:\dsh-plugins\study-ops`，用 `plugin_manager` 的 `install_bundle`（target 为这个目录）装进 desktop profile，不要手改 profile 的 `package.json`：pnpm 锁文件不会自动跟着 `link:` 改，会留下指向旧目录的 junction，重启后插件就「包不可用」。源码目录换过就先 `remove_bundle` 再 `install_bundle`。

配置写在插件自己的 `cordis.patch.yml`（`projectRoot` / `targetTotal` / `targetPerCell`；`stateDir` 默认 `<projectRoot>/_lab`）。

人口学录入的镜像目录（同一个 `_lab`）在 profile patch 里：

```yaml
- id: demographic-coder
  name: "@local/demographic-coder"
  config:
    labDir: "C:/Users/16787/OneDrive/Desktop/yyh硕士论文/_lab"
```

改 Host 代码要重启 app；改 client 在「设置 → 插件」里把本插件关掉再打开，然后刷新页面即可。

## 接口

`/api/study-ops`，同源 + 请求头 `x-study-ops: 1`：

- `GET  ?action=status` — 全量快照（30 秒内存缓存）
- `GET  ?action=refresh` — 强制重扫
- `GET  ?action=subject&id=11002` — 单人明细（含姓名电话，仅在展开时取）
- `POST {action:'followup', payload:{id, done}}` — 标记/撤销随访完成
- `POST {action:'schedule', payload:{op:'add', id, date, start, end, note}}` — 加安排
- `POST {action:'schedule', payload:{op:'remove', key}}` — 删安排
- `POST {action:'attendance', payload:{key, status}}` — 手动到场状态：`arrived` / `noshow` / 空（交回自动）
- `POST {action:'t0', payload:{id, date}}` — 手动指定 T0 日期
- `POST {action:'dismiss', payload:{key, note}}` — 忽略一条异常
- `POST {action:'restore', payload:{key}}` — 恢复一条；`key` 为空时恢复全部
- `POST {action:'export'}` — 写 md + csv
- `POST {action:'reveal'}` — 在资源管理器打开导出目录

Agent 工具：

- `study_status(focus)` — 进度、异常、随访、安排摘要，只含编号与计数。
- `study_schedule(op, id, date, start, end, note)` — 用一句话加/删安排。

## 隐私

- 原始数据只读；
- 面板默认只显示编号，姓名电话折叠在明细里；
- 导出默认脱敏；
- 不联网、不调模型。

## 测试

```powershell
node --test tests/scan.test.mjs     # 13 项：解析、日期、状态、随访、安排、人口学
node tests/smoke.mjs                # 对真实数据跑一遍全量扫描（会调用 Python）
```
