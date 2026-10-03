# 声发射 b 值实时计算后端

岩样单轴加载声发射试验的实时后端：接收采集端推送的撞击事件，按固定事件数
滑动窗口实时估计 G–R **b 值**（最大似然，含标准误），以基线时段为参照做
**b 值下降预警**。事件、窗口结果、预警状态全部落库；服务重启后从已存数据
恢复，继续接收得到的结果与未中断时完全一致。

- 运行时：Node.js 20 + TypeScript（ESM）+ Express 4
- 数据库：MongoDB 7（原生驱动 v6）
- 测试：Vitest（41 个用例）

方法学细节（MLE 公式、Mc 方法选择与样本少表现、预警状态机、
乱序/迟到的水印语义）见 [`docs/methods.md`](docs/methods.md)。

## 快速启动

```bash
docker compose up -d --build
# mongo:7 + 后端（node:20-bookworm 多阶段构建），后端监听 http://localhost:3000
```

本地开发：

```bash
npm ci
npm test            # Vitest
npm run typecheck   # tsc 严格模式
npm run dev         # tsx watch，需自行提供 MongoDB（MONGO_URI）
```

环境变量：`MONGO_URI`（默认 `mongodb://mongo:27017`）、`MONGO_DB`（默认
`ae_bvalue`）、`PORT`（默认 3000）。

## 数据模型集合

| 集合 | 内容 | 关键约束 |
| --- | --- | --- |
| `experiments` | 试验编号、开始时间、样品信息、分析设置 | `id` 唯一 |
| `events` | 已接受撞击事件 | `(experimentId,eventId)` 唯一（重发去重）；`(experimentId,timestampUs,eventId)` 索引 |
| `late_events` | 超延迟被丢弃事件的审计 | `(experimentId,eventId)` 唯一（重发仍判重） |
| `windows` | 定稿窗口 b 值结果 | `(experimentId,windowIndex)` 唯一（upsert 幂等） |
| `alerts` | 预警拉起/解除事件 | `(experimentId,kind,windowIndex)` 唯一 |
| `engine_meta` | 水印、计数、基线、预警状态机状态 | `experimentId` 唯一，每批次整体替换 |

## API

### 创建试验

`POST /experiments`

```json
{
  "experimentId": "SAND-2026-10-03-A",
  "startedAtUs": 1759449600000000,
  "sample": { "name": "细砂岩", "lithology": "砂岩" },
  "settings": {
    "windowEvents": 200,
    "stepEvents": 50,
    "allowedDelayUs": 5000000,
    "baselineStartUs": 0,
    "baselineEndUs": 600000000,
    "alertMultiplier": 2,
    "persistenceWindows": 3,
    "minEventsForB": 50,
    "mcMethod": "MAXC",
    "amplitudeMinDb": 0,
    "amplitudeMaxDb": 120
  }
}
```

字段都可部分省略（除 `experimentId`、`startedAtUs`），缺省值取服务端默认
（见 `src/service/registry.ts` 的 `DEFAULT_SETTINGS`）。非法时 `400`，
错误体 `fieldErrors` 逐项指出字段，例如：

```json
{
  "error": "参数校验失败",
  "fieldErrors": [
    { "field": "settings.windowEvents", "message": "窗口事件数必须为正整数" },
    { "field": "settings.persistenceWindows", "message": "持续窗口数必须为不小于 1 的整数" }
  ]
}
```

### 推送撞击事件

`POST /experiments/:id/events`，请求体为单条事件对象或数组（建议成批推送）。

```json
[
  { "eventId": "AE-000001", "timestampUs": 1759449600123456, "amplitudeDb": 57.3, "channel": 2 },
  { "eventId": "AE-000002", "timestampUs": 1759449600256789, "amplitudeDb": 61.0, "channel": 0 }
]
```

- 乱序：允许延迟（`allowedDelayUs`，微秒）内的乱序事件自动归位，不影响结果；
  超出延迟的迟到事件丢弃，计入 `lateDropped`，并写入 `late_events`。
- 重发：同一 `eventId` 再送达只计一次，计入 `duplicates`（迟到事件重发也算重）。
- 非法事件返回 `422`，错误精确到 `events[i].字段`；同批合法事件**照常接收**。
  时间戳早于试验开始、幅度非有限（NaN/Infinity）或超出量程、通道为负等
  分别指出对应字段。

```json
{
  "accepted": 200,
  "duplicates": 0,
  "lateDropped": 1,
  "rejected": 0,
  "finalizedWindows": [12, 13],
  "alerts": [{ "kind": "raised", "windowIndex": 13 }],
  "watermarkUs": 1759449615000000
}
```

### 查询

| 方法/路径 | 说明 |
| --- | --- |
| `GET /experiments/:id` | 试验信息 + 引擎状态（水印、计数、基线、预警态） |
| `GET /experiments/:id/windows` | 已定稿窗口：`bValue`、`bStdError`、`completenessDb/Magnitude`、`nTotal`、`nEffective`、`status` |
| `GET /experiments/:id/alerts` | 当前 `state`（`normal`/`alarm`）及拉起/解除事件 |
| `POST /experiments/:id/stop` | 结束试验，定稿全部尾部窗口 |
| `GET /health` | 健康检查 |

样本不足的窗口 `status` 为 `insufficient`，`bValue`/`bStdError` 为 `null`，
前端应显示"样本不足"而非零。

## 行为约定（对应验收项）

- **合成数据**：固定种子、已知 b 的几何分布幅度，n=3000 时
  `|b̂−b| ≤ 2·se`（b=0.8/1.0/1.5/2.0 均验证）。
- **平移不变**：所有幅度加同一整数常数，b 与 se 逐位不变（测试断言）。
- **乱序一致**：允许延迟内任意打乱（含跨批），定稿窗口与顺序输入逐字段相等。
- **重发幂等**：整批重发只增加 `duplicates`，窗口与库内事件数不变。
- **预警时机**：两段不同 b 的合成数据，第一个越限窗口必在第二段开始之后，
  且恰在连续第 P 个越限窗口拉起；第一段窗口无越限。
- **重启一致**：测试中每若干批丢弃内存引擎、按库重建（等价进程重启），
  最终窗口、预警与计数和一次不中断运行深度相等。

## 目录结构

```
src/
  config.ts              # 环境配置
  index.ts               # 启动：连接 Mongo、建索引、恢复试验、起 HTTP
  domain/
    types.ts             # 领域类型
    bvalue.ts            # 直方图、MAXC、GFT、分档 MLE + Shi–Bolt 标准误
    validation.ts        # 试验/事件字段校验（精确字段路径）
    engine.ts            # 水印、窗口定稿、基线、预警状态机
  repo/
    types.ts             # 仓储接口
    memory.ts            # 内存实现（测试用，语义与 Mongo 一致）
    mongo.ts             # MongoDB 7 实现（唯一索引幂等）
  service/registry.ts    # 引擎注册表、同试验串行、启动恢复
  http/app.ts            # Express 路由与错误映射
tests/                   # Vitest：bvalue / validation / engine-ordering / alert / http
docs/methods.md          # 方法学说明
```

## 已知边界

- 每试验在单实例内串行处理（水印语义依赖到达顺序）；多实例水平扩展需要
  按 `experimentId` 分片，当前版本单实例足够覆盖试验台机器场景。
- 内存中只保留下一个待定稿窗口起点之后的事件后缀，稳态内存与窗口大小
  同阶；全量事件在 MongoDB 中。
