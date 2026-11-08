# 实验运行台

配置驱动的参与者进度、访视任务矩阵、数据异常、预约和随访。默认是空研究；查询只读，不扫描个人目录，不创建数据目录。通过 `studyPath` 显式加载 schemaVersion 1 的研究 JSON，与其他研究插件共享 `study:{id,name,path,dataRoot,revision}`。

## 来源

参与者 CSV 由研究定义的 `participants.path`、`idColumn`、`statusColumn`、`enrolledValues` 和 `groupColumns` 指定。编号是任意符合 participantId.pattern 的非空字符串，前导零保留，姓名不决定入组。重复编号隔离并提示，不静默覆盖。

`plugins.ops.recordsPath` 指向长表 CSV，必需列为 `participantId,visitId,taskId,status,date,recordId`。状态为 complete、pending、failed、unknown。记录必须关联参与者表、已定义访视和适用任务，日期为有效 YYYY-MM-DD，recordId 非空唯一。重复记录编号不采用；同参与者×访视×任务多份记录标为冲突，等待来源表明确裁决。

`visits` 按 order 排序；任务可设 `visits`、`required:false` 和 `appliesTo:{group:["A","B"]}`。不适用任务显示“不适用”，可选任务缺失不报错。必需任务缺失、失败、未知和多份观测产生异常；complete 表示来源表确认完成，运行台不推断具体任务质量。

随访由 `followups:[{id,label,anchorVisit,offsetDays,earlyDays,lateDays}]` 驱动。锚点访视的全部必需适用任务必须唯一完成且日期有效，取最晚完成日期。纯预约、缺席不会生成访视完成或随访锚点。访视可配置 date 或 dateColumn；未来日期或已排未来预约的缺记录显示“待到期”。没有任何时间定义时，已入组者的必需任务按预期记录检查；当前未实现任意相对访视时间窗。

## 状态与写入

状态写到 `<dataRoot>/ops/<studyId>/state.json`。快照带 `stateRevision`，每次写入必须携带当前版本，旧页面或并发修改返回 409；同路径写入排队，并用独占锁防止其他进程同时写。临时文件使用 UUID 并原子替换；失败不覆盖原状态。进程异常退出留下的 `.lock` 应由操作者确认进程结束后移除，查询不自动修复它。

异常忽略绑定具体观测和规则指纹；新内容重新提示。导出 JSON 与异常 CSV 包括 active/dismissed、时间、备注、规则和观测指纹。来源健康区分未配置、缺失、空与读取失败。

预约校验真实日历日期、00:00–23:59、结束晚于开始，并检查相同参与者或资源重叠。数据状态按预约的参与者、访视和日期匹配；未来预约不自动完成。UI 保存成功才清空草稿，失败保留输入。

## 接口与研究切换

同源 `/api/study-ops`，请求头 `x-study-ops: 1`。GET 仅 `status` / `subject`。POST action 支持 `refresh`、`schedule`、`attendance`、`followup`、`dismiss`、`restore`、`export`、`studyConnect`。所有变更、导出、重新检查与研究切换均携带当前 `studyId`、`studyRevision` 和 `selectionRevision`；状态修改还需 `stateRevision`。`studyConnect` 接收 `studyPath`，通过共享 selector 同步切换已注册研究插件；任一忙或校验失败不会部分切换。status 包含 selection 一致性状态。研究定义在外部修改时，普通读写返回409，使用原活动身份重新连接后采用新定义。

私有兼容通过 config 或研究 `plugins.ops.adapterPath` 显式加载，模块导出 `createAdapter({study,config})`，返回 `snapshot(options)`、`mutate(action,payload)`、可选 `export(snapshot)`。通用包无自动私有路径发现，也不内置研究专属解析器/规则/默认材料。适配器须返回与通用动态矩阵相同的快照结构，纯查询保持只读。

## 测试

```powershell
node --test tests/*.test.mjs
```

测试仅使用临时合成研究，不调用已安装插件或真实研究目录。通用发布文件由 package files 白名单列出，私有历史实现、旧测试与研究配置均在插件目录以外。
