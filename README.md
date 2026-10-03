# 声发射实时 b 值后端

接收岩样单轴加载声发射撞击事件，按固定事件数滑窗实时计算 Gutenberg–Richter **b 值**（MLE，
幅度 1 dB 分档、M = A/20），基于试验基线自动判断 b 值持续异常下降并发出预警。
Node.js 20 + Express + TypeScript + MongoDB 7 + Vitest。

## 1. 快速开始

```bash
docker compose up --build
# 后端监听 http://localhost:8080
```

本地开发：

```bash
npm install
# 需要一个 mongo:7（compose 里只起 mongo）
docker compose up -d mongo
MONGO_URL=mongodb://localhost:27017 npm run dev     # 或 npm run build && npm start
npm test
```

环境变量：`MONGO_URL`（默认 `mongodb://mongo:27017`）、`MONGO_DB`（默认 `ae_bvalue`）、`PORT`（默认 8080）。

## 2. 接口

所有时间戳为**整数微秒**，幅度单位 dB。

### 试验

`POST /api/experiments`

```json
{
  "experimentId": "rock-2026-10-03-01",
  "startedAtUs": 1759449600000000,
  "sample": { "rockType": "花岗岩", "size": "50x100", "id": "S-17" },
  "settings": {
    "windowEvents": 400,
    "step": 200,
    "maxDelayUs": 5000000,
    "baselineDurationUs": 600000000,
    "alertSigmaMultiple": 3,
    "persistWindows": 3,
    "minEffectiveEvents": 50,
    "amplitudeMinDb": 0,
    "amplitudeMaxDb": 100,
    "mcMethod": "maxc"
  }
}
```

| 字段 | 含义 | 约束 |
|---|---|---|
| `windowEvents` | 每个窗口的事件数 | 正整数 |
| `step` | 窗口滑动步长（事件数） | 正整数，≤ windowEvents |
| `maxDelayUs` | 允许的乱序/迟到延迟（µs） | 非负整数 |
| `baselineDurationUs` | 基线时段长度（从 startedAtUs 起，µs） | 正整数 |
| `alertSigmaMultiple` | 预警倍数 k：阈值 = 基线b − k·基线σ | 正数 |
| `persistWindows` | 连续越限/恢复窗口数 | ≥1 整数 |
| `minEffectiveEvents` | 窗口内 Mc 以上有效事件少于此数则不给 b 值 | 正整数，≤ windowEvents；默认 50 |
| `amplitudeMinDb/MaxDb` | 幅度量程（含端点） | 默认 [0, 100] |
| `mcMethod` | 完整性震级方法 | 目前只支持 `maxc` |

其它试验接口：`GET /api/experiments`、`GET /api/experiments/:id`、`POST /api/experiments/:id/close`
（结束试验：尾部窗口全部补算，之后拒收事件）。

### 事件

`POST /api/experiments/:id/events`，请求体为单对象、数组或 `{"events":[...]}`：

```json
{ "eventId": "dev1-000123", "timestampUs": 1759449601000000, "amplitudeDb": 47.8, "channel": 2 }
```

响应（逐事件回执 + 本批定稿/预警结果）：

```json
{
  "experimentId": "...",
  "counters": { "accepted": 245, "duplicate": 5, "late": 1, "beforeStart": 0, "invalid": 0 },
  "receipts": [
    { "eventId": "dev1-000123", "status": "accepted" },
    { "eventId": "x", "status": "invalid", "field": "amplitudeDb",
      "reason": "not_finite", "message": "amplitudeDb 必须是有限数，收到 NaN" },
    { "eventId": "old", "status": "late", "reason": "exceeds_max_delay", "message": "..." }
  ],
  "finalizedWindowIndexes": [10, 11],
  "newAlerts": [],
  "maxTimestampUs": 1759449700000000,
  "watermarkUs": 1759449695000000
}
```

`counters` 是**试验累计计数**（重启后仍连续）；单条事件的本批结论看 `receipts`。

### 结果

- `GET /api/experiments/:id/state` — 基线、当前预警状态、连续计数、累计计数、水印
- `GET /api/experiments/:id/windows` — 全部窗口结果（见下）
- `GET /api/experiments/:id/alerts` — 预警变迁（`raised` / `cleared`）
- `GET /api/experiments/:id/events?limit=1000` — 已接受事件（排查用）
- `GET /healthz`

窗口结果示例：

```json
{
  "index": 11, "startRank": 2200, "endRankExclusive": 2600,
  "startTimeUs": 1759449651000000, "endTimeUs": 1759449689000000,
  "eventCount": 400,
  "mcDb": 30, "mcMagnitude": 1.5, "effectiveCount": 388,
  "b": 0.87, "sigmaB": 0.044,
  "insufficient": false, "degenerate": false
}
```

样本不足时 `b`/`sigmaB` 为 `null`，`insufficient: true`（全部有效事件挤在同一档导致 MLE 退化时
为 `degenerate: true`）。预警变迁带 `windowIndex`、`b`、`sigmaB`、`thresholdB`、`baselineB`、
`baselineSigmaB`。

错误响应统一为 `{ "error": "...", "errors": [{ "field", "reason", "message" }] }`，
非法请求 400、试验不存在 404、重复试验/已关闭试验 409。

## 3. 算法

### 3.1 b 值（Aki/Utsu MLE）

Gutenberg–Richter：`log10 N(≥M) = a − bM`，声发射峰值幅度换算震级 `M = A/20`，1 dB = 0.05 震级单位。

事件幅度按 1 dB 向下取整归档。取完整性档 Mc 后，对 Mc 及以上的事件：

```
b = 20·log10(e) / (mean(A_bin) − A_bin,c + 0.5)     ≈ 8.6859 / (Ā_bin − Ac + 0.5)
σ_b = b / sqrt(N_eff)                                （Utsu 1966）
```

`+0.5` 是分档 MLE 的半档修正（档内幅度未知，取档中位作为期望）；按档归并后按档排序求和，
**不同送达顺序得到逐位相同的浮点结果**。对估计器做过 2000 个独立 N=400 窗口的蒙特卡洛检验，
2σ 经验覆盖率约 0.95，无系统偏差；幅度整体加整数 dB 常数 b 不变。

### 3.2 完整性震级 Mc：为什么默认 MAXC

默认且目前唯一实现 `maxc`（Maximum Curvature / 频度最大档，并列取最低档）：
直接取频度最高的幅度档作为 Mc，不做拟合、不调参、不需要参数网格。

选它而不是拟合优度（GFT，逐级拟合到 KS/Anderson–Darling 残差满足阈值）或 EMR 等方法，
理由是**小样本稳健性**：

- MAXC 是**频度的模式**，5 个事件就能给出确定结果，失败模式温和（只可能低估 Mc，
  让 MLE 略偏保守而不是发散）；
- GFT 类方法要在每一级候选 Mc 上做拟合 + 显著性检验，N 小时 KS 临界值本身不稳定，
  残差/显著性随候选级剧烈波动，常常选出偏高的 Mc、把本来就不多的有效事件再砍掉一截；
- EMR 等联合拟合自由参数更多，小样本下可能不收敛。

代价：分布在低幅端没有明显“抬头”时 MAXC 会**系统性低估 Mc**，使 b 略偏低。这正是
预警应用可接受的方向（偏保守）。后续要加 GFT/EMR 时在 `src/domain/magnitude.ts` 增加方法、
在 settings.mcMethod 开放即可，窗口结果里已经保留 `mcDb` 便于事后对比。

### 3.3 滑窗定稿、乱序与迟到（水印）

事件全局秩按 `(timestampUs, eventId)` 升序，窗口 j 覆盖秩 `[j·step, j·step + windowEvents)`。

乱序/迟到/定稿用**事件时间水印**统一处理（微批模型，水印随批原子推进）：

```
watermark_new = max(watermark_old, min(批内最大事件时间, 墙上时钟) − maxDelayUs)
```

- 批内事件按**批前水印**裁决：`ts < watermark_old` 才算迟到丢弃（`counters.late`），
  同一批重连补洞的老事件随该批一起正常处理；
- 严格 `ts < watermark_new` 的事件秩不可能再被未来事件改变，据此定稿窗口；
- 水印只升不降；没有新事件时墙上时钟继续把它往前推，实时流里安静几秒窗口也会照常定稿；
- 已写出的窗口不可变。重复 `eventId`（库内唯一索引 + 批内去重）只计一次。

### 3.4 基线与预警

水印越过基线时段结束时刻后，用**基线时段内全部事件**独立估一次 Mc 与 b（同样的 MLE）。
基线有效事件不足时记 `status: "insufficient"`，本场试验永不报警（状态接口可见）。

阈值 `T = b_base − k·σ_base`。窗口 `b < T` 计一个越限窗口：

- 连续 `persistWindows` 个越限 → 写入一条 `raised` 变迁；
- 拉起后连续 `persistWindows` 个 `b ≥ T` → 写入一条 `cleared` 变迁；
- 样本不足/退化的窗口中断两侧连续计数（既不误报也不解除）。

## 4. 重启一致性

存储中的**事件、窗口结果、预警变迁是权威数据**，均带业务唯一键（事件 `(experimentId,eventId)`、
窗口 `(experimentId,index)`、变迁 `(experimentId,windowIndex,kind)`），写入全部幂等
（`$setOnInsert` upsert / `insertMany ordered:false` 忽略重复）。每批处理顺序固定为：
事件落库 → 补算窗口 → 基线定稿 → 推进预警并写变迁 → 更新引擎状态。

重启时 `restore()`：从事件集合重建水印水位与最大时间戳，按秩补算所有缺失窗口，
确定性重算基线（若已到时刻），再按 index 顺序重放窗口重建预警状态机与连续计数。
因此无论在批处理的哪一步崩溃，恢复后的窗口与变迁都与“没中断”逐窗口一致（测试
`tests/engine.test.ts > 重启续跑` 覆盖；对比时忽略仅与墙钟有关的 `createdAtUs`）。

注：为让恢复时仍可处理采集端重连后的在途重发，恢复瞬间水印以已见最大事件时间为观察前沿
（不直接引用墙上时钟）；同一 eventId 的重发先走重复过滤。

## 5. 数据集合

`experiments`、`events`（唯一：`(experimentId,eventId)`；秩索引：`(experimentId,timestampUs,eventId)`）、
`windows`（唯一：`(experimentId,index)`）、`alerts`（唯一：`(experimentId,windowIndex,kind)`）、
`engine_states`。

## 6. 目录

```
src/domain/   类型、MLE/Mc 算法、校验、引擎（水印/窗口/预警状态机）
src/app/      AppService（试验管理、单试验串行队列、恢复）
src/infra/    MongoStore
src/http/     Express 路由与启动
tests/        Vitest（算法、校验、引擎端到端：乱序等价/去重/迟到/预警时机/重启/样本不足）
```

## 7. 运行你的验收场景

合成数据生成器在 `tests/helpers/synth.ts`（固定种子 mulberry32 + Gutenberg–Richter 指数幅度、
严格有界的块内打乱）。对应验收点：

1. 真值在 2σ 内：`tests/magnitude.test.ts`（3 个固定种子 + 2000 窗口覆盖率）；
2. 加常数 b 不变：同文件“震级平移不变性”；
3. 延迟内乱序结果一致：`tests/engine.test.ts` “打乱顺序与按时间顺序”；
4. 重复发送不改变结果：同文件“重复发送（整批重发）”；
5. 两段数据预警不提前：同文件“不更早”（校验第一段无越限、且恰在第 persistWindows 个越限窗口拉起）；
6. 中途重启一致：同文件“重启续跑”。

实时墙上时钟默认取服务系统时间；事件接入层若有采集网关时钟，也可在
`AppService.ingest(id, events, wallClockUs)` 显式传入。
