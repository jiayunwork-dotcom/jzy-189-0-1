# b 值与完整性震级估计方法说明

## 1. 震级换算与分档

AE 撞击事件只携带峰值幅度（dB）。按实验室声发射的通行做法：

```
m = A_dB / 20
```

幅度按 **1 dB 向下取整**分档（采集卡本身也是整数 dB 阈值判决），因此震级档宽
`Δm = 0.05`。所有估计都先在 dB 整数档上完成，再换算成震级。

## 2. b 值最大似然估计

对完整性震级以上的事件，离散档的 MLE（Aki 1965；Utsu 1966；
Woessner & Wiemer, 2005, 式(6)，含 Utsu 分档修正）直接在 dB 上写成：

```
d = mean(A_bin − A_c) + 0.5        # 0.5 dB 为分档修正
b = 20 / ( ln 10 · d )
```

标准误用 Shi & Bolt（1982）（Woessner & Wiemer 2005 式(9)）：

```
se = b · sqrt( (s_X² + 1/12) / n ) / d
```

`s_X` 为整数档偏移 `X_i = A_bin − A_c` 的样本标准差，`1/12` 是 1 dB 档宽修正。

该公式只依赖相对档偏移，因此所有幅度加同一整数常数，`b` 与 `se` 严格不变
（本仓库测试逐位相等）。合成数据（n=3000，b∈{0.8,1.0,1.5,2.0}，100 个固定
种子）上偏差 <0.01，2 倍标准误覆盖率 96–97%，解析 se 与经验标准误吻合。

## 3. 完整性震级 Mc：默认 MAXC

完整性震级必须从数据本身估计。提供两种方法，默认 **MAXC**：

### MAXC（Maximum Curvature，默认）

取非累积频度分布最高的幅度档。G-R 分布的频度本身随震级指数下降，
频度曲线的"拐点"就是检测能力开始完整的位置；在分档直方图上即最高计数档。

并列时取**最低**的并列档：小样本抖动容易让相邻两档计数相等，取低值保留更多
事件，避免一次抖动就把 Mc 推高、人为缩小样本。

**为什么默认它：**
- 无参数、无拟合，不依赖残差阈值或分布渐近假设；
- 只要直方图众数稳定就能用，**事件少时仍给出确定结果**；
- 对 G-R 纯净数据它就是无偏的（众数恰在 Mc 档）；
- 计算结果是频度的确定性函数，同批数据永远给出同一 Mc，
  对"重启前后完全一致"的要求最友好。

**样本少时的表现：** MAXC 不做统计检验，因此在 n 很小时也不"失配回退"，
但它估计出的 Mc 可能偏低、把少量检测不全的事件纳入 MLE，使 b 略偏大。
这一问题用 `minEventsForB` 兜底——Mc 以上有效事件不足时窗口直接标
`insufficient`，不出 b 值，而不是给一个不可信的数。

### GFT（Goodness-of-Fit Test，可选 `mcMethod: "GFT"`）

Wiemer & Wyss（2000）：对每个候选 Mc 做 MLE，生成 G–R 合成频度，
比较观测与合成的非累积与累积频度残差：

```
R = 100% − ( Σ|O − S| / ΣO ) × 100%
```

取第一个 `R ≥ 95%` 的档；达不到取第一个 `R ≥ 90%`；都达不到回退 MAXC。

**样本少时的表现：** 候选档太少、每档计数抖动大，拟合优度几乎必然不达标，
GFT 会系统性回退到 MAXC——这是有意的保守行为，不会在小样本上给出
激进的高 Mc。事件量充足（数千以上）且检测率在 Mc 附近渐变时，GFT 通常
比 MAXC 略保守（Mc 略高、b 略低偏差更小），适合事后精细分析；
实时预警默认仍建议 MAXC。

## 4. 窗口、乱序与迟到

- 窗口固定包含 `windowEvents` 个事件，按 `stepEvents` 滑动；
  事件全局次序严格按 `(timestampUs, eventId)` 排序定义。
- **事件时间水印**：`watermark = max(已见时间戳) − allowedDelayUs`。
  `timestamp < watermark` 的事件才可能被后续数据"挤过"窗口边界，
  因此判迟到、丢弃并计数；其余事件（无论先到后到）都进入有序序列。
- 窗口只在其全部事件都严格早于水印（**已定稿/冻结**）时计算并落库，
  之后不再改变。故：
  - 允许延迟内任意乱序 ⇒ 定稿窗口与顺序到达逐字段相同；
  - 同一事件重发只算一次（`(experimentId,eventId)` 唯一约束）；
  - 服务重启从库中回放，定稿窗口、预警与未中断完全一致。
- 定稿时刻用水印跨越的事件时间（窗口末事件时间）记录，不用墙钟，
  保证结果确定性。
- 结束试验（`POST /stop`）时水印视为无穷，定稿尾部所有窗口。

## 5. 基线与预警

- 基线时段 `[开始+baselineStartUs, 开始+baselineEndUs)`：
  水印越过基线终点后（保证基线数据已冻结），对该时段全部事件做一次
  池化 MLE，得到 `b0` 与其完整性震级。基线有效事件不足
  （< `minEventsForB`）时标记 `insufficient`，该试验全程不出预警，
  窗口结果照常给出。
- 窗口越限判据（**严格**小于）：

```
b_w < b0 − alertMultiplier · se_w
```

- 状态机：
  - `normal` 下连续 `persistenceWindows`（P）个越限窗口 → 拉起 `raised`；
  - `alarm` 下连续 P 个未越限的有效窗口 → 解除 `cleared`；
  - 样本不足窗口为**中性**：既不算越限也不算恢复，不打断已有计数
    （宁可晚一点解除，也不因一次掉数据静默解除报警）；
  - 拉起/解除都落库为预警事件，带窗口编号、窗口 b、se、基线 b、
    当时阈值 `b0 − k·se` 和窗口末事件时间。
- 基线判定之前不定稿窗口：基线就绪后一次性追赶定稿。这样
  "无中断运行"与"重启回放"两条路径的每个窗口都经历完全相同的
  判定过程，是重启一致性的关键。

## 参考文献

- Aki, K. (1965). Maximum likelihood estimate of b in the formula log N = a − bM.
  *Bull. Earthq. Res. Inst.*, 43, 237–239.
- Utsu, T. (1966). マグニチュードの幾何学的表現について（英文摘要）. *Geophys. Bull. Hokkaido Univ.*, 13, 99–102.
- Shi, Y., & Bolt, B. A. (1982). The standard error of the magnitude-frequency b value.
  *BSSA*, 72(5), 1677–1687.
- Wiemer, S., & Wyss, M. (2000). Minimum magnitude of completeness in earthquake catalogs:
  examples from Alaska, the western US, and Japan. *BSSA*, 90(4), 859–869.
- Woessner, J., & Wiemer, S. (2005). Assessing the quality of earthquake catalogues:
  estimating the magnitude of completeness and its uncertainty. *BSSA*, 95(2), 684–698.
