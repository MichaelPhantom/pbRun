/**
 * 分段展示标签的唯一实现 —— **「一段」不等于「一公里」，`lap_index` 也不是展示序号**。
 *
 * ## 这一类缺陷是怎么产生的
 *
 * `activity_laps.lap_index` 是**从 0 开始的存储键**（生产库 287/287 个活动都是
 * `0..N-1` 连续）。它只保证「同一活动内可排序」，不保证任何距离含义。但旧实现
 * 在四处把它当成了别的量：
 *
 * | 位置 | 旧写法 | 实际含义 | 后果 |
 * |------|--------|----------|------|
 * | 分段表 `#` 列 | `lap.lap_index` | 0 基序号 | 表格第一行显示 **0** |
 * | 「最快 K{n}」徽章 | `最快 K${bestLapIndex}` | 0 基序号 | 徽章写 **K0**（18/242 条活动），读起来是「第 0 公里」 |
 * | 深度分析 hint | `第 ${bestLapIndex} 段` | 0 基序号 | 「第 0 段」 |
 * | AI 数据块 | `K${lapIndex}=Z…` | 0 基序号 | 模型收到 `K0=Z2`，当成第 0 公里 |
 *
 * 更严重的是 **K 这个字母本身**：它宣称「第 N 公里」，而真实库跑步 lap 里只有
 * **57.8%**（1714/2967）落在 950–1050 m。间歇课的 lap 是手表按**时间**切的
 * （`lap_trigger='time'`，870/2967 段），长度可以是 0.48 km / 0.08 km。
 * 于是 `650375691`（8.31 km / 16 段）的徽章写「最快 K11」，而第 11 段实际是
 * **5.81–6.81 km** —— 序号与公里数差了 5 公里，且这次跑步根本没有「第 11 公里」。
 * `651707081` 更极端：徽章「最快 K9」指向 **3.63–3.72 km** 的 90 m 短段。
 *
 * 同一份数据在 `app/lib/llm.ts` 里早就改对了（用累计距离区间 `0.0-1.0km` 而非
 * 序号，注释写明「K1..Kn 会误导模型以为每段恰为 1 公里」），但 UI 侧从未跟进 ——
 * 同一个概念两份实现，一份对一份错。本模块把它收成一份。
 *
 * ## 三条纪律
 *
 * 1. **展示序号 = 在有序列表中的位置 + 1**，由位置推导，不由 `lap_index` 推导。
 *    这样无论存储键是 0 基还是 1 基（历史夹具用过 1 基），显示都不会错位。
 * 2. **只有每一段都约等于 1 公里，才允许出现「每公里」/「K{n}」字样**。否则
 *    标题、表名、徽章必须中性化 —— 这是「标签是对外契约」的直接推论：
 *    `每公里分段数据` 在间歇课上是一句假话。
 * 3. **默认用累计距离区间**（`5.8-6.8km`），因为它与表里的「距离」列、与活动
 *    总距离都能自证；序号只在「确实是每公里切段」时作为紧凑写法保留。
 *
 * ## 为什么入参同时接受两种距离字段名
 *
 * 同一批分段数据在两层里叫法不同：DB/`ActivityLap` 用 `distance`（米），
 * `ActivityLapAnalysis['laps']` 用 `distanceMeters`（米）。若本模块只认其中一种，
 * 调用点就会各自写 `.map(l => ({ distance: l.distanceMeters }))` —— 又回到
 * 「同一个概念多份实现」。故用一个归一化读取函数 `lapDistanceMeters()` 吃掉差异。
 */

/** 分段标签所需的最小输入形状（两种距离字段名都接受，单位均为米）。 */
export type LapLabelInput = {
  distance?: number | null;
  distanceMeters?: number | null;
};

/**
 * 归一化读取分段距离（米）。
 *
 * 两种字段名都接受，`distance` 优先（DB 侧字段，`distanceMeters` 只出现在
 * 派生结构里）。两者都缺失 → null（**不猜 0**：0 会让「每公里」判定误判为
 * 「非 1 km」，而 null 在 `isOneKmLap` 里同样返回 false，但语义更诚实）。
 */
export function lapDistanceMeters(lap: LapLabelInput): number | null {
  const v = lap.distance ?? lap.distanceMeters;
  return v == null ? null : v;
}

/**
 * 判定「这一段约等于 1 公里」的容差（米）。
 *
 * 为什么不是精确 1000：设备按距离切段时 `total_distance` 有采样误差，实测
 * 跑步 lap 里 1714 段落在 950–1050 m，而 ±20 m 只能覆盖其中一部分。
 * 取 ±50 m 后，`distance` 触发的 1710 段里 1691 段被判为「约 1 公里」，
 * 同时不会把 0.9 km 的段落也算进来。
 */
export const ONE_KM_LAP_TOLERANCE_M = 50;

/**
 * 该分段是否约等于 1 公里。
 *
 * 距离缺失/非正 → false（**不猜**：宁可把表名中性化，也不要声称「每公里」）。
 */
export function isOneKmLap(distanceMeters: number | null | undefined): boolean {
  if (distanceMeters == null || !Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return false;
  }
  return Math.abs(distanceMeters - 1000) <= ONE_KM_LAP_TOLERANCE_M;
}

/**
 * 是否**每一段**都约等于 1 公里。
 *
 * 空数组 → false：没有分段就谈不上「每公里分段」。
 *
 * 实测（242 条跑步活动）：严格全 1 km 的只有 **1 条**。原因是几乎每次跑步都有
 * 一个不满整段的收尾段（`session_end`，242 段里 237 段 < 950 m）。所以「每公里」
 * 这个说法在真实数据里**几乎从不成立** —— 这正是旧文案最普遍的错。
 */
export function allLapsOneKm(laps: readonly LapLabelInput[]): boolean {
  if (laps.length === 0) return false;
  return laps.every((l) => isOneKmLap(lapDistanceMeters(l)));
}

/**
 * 分段表的 caption（也是无障碍名）。
 *
 * 只有每段都约 1 公里才写「每公里分段数据」；否则写中性的「分段明细数据」。
 * 调用方必须把它传给 `DataTable` 的 `caption`，不得在页面里另写一份。
 *
 * 为什么不写成「分段数据」：那与区块标题 `SectionCard title="分段数据"` 完全
 * 相同，读屏会连续念两遍同一句，且测试里 `getByText` 会撞到两个节点（无法
 * 判断断言命中的是标题还是表格）。表名必须能与标题区分。
 */
export function lapTableCaption(laps: readonly LapLabelInput[]): string {
  return allLapsOneKm(laps) ? '每公里分段数据' : '分段明细数据';
}

/**
 * AI 数据块的分段标题。
 *
 * 非跑步恒为「分段明细」：那类活动的 lap 常是泳池池长/回合，且配速不展示，
 * 「每公里」既无意义也无必要。跑步则按实际切段粒度派生。
 *
 * 后缀「（区间为累计距离，非序号）」保留：它是模型理解 `0.0-1.0km` 这类标签
 * 的唯一提示，删掉会让模型把区间当序号。
 */
export function lapSectionTitle(laps: readonly LapLabelInput[], running: boolean): string {
  const base = running && allLapsOneKm(laps) ? '每公里分段' : '分段明细';
  return `【${base}】（区间为累计距离，非序号）`;
}

/**
 * 列表位置 → 展示序号（1 基）。
 *
 * `position` 是**有序数组的下标**（0 基），返回值是给人看的序号（1 基）。
 * 单独成函数是为了让「+1 只在一个地方发生」，避免各处手写 `idx + 1` 后
 * 有人忘了加。
 */
export function lapOrdinalAt(position: number): number {
  return position + 1;
}

/**
 * 有序分段列表 → 每段的起点累计距离（米），与列表等长。
 *
 * 单份实现：UI 徽章、AI 数据块都用它，避免各自手写 `cum += l.distance`
 * 后有人忘了把首段算成 0。
 */
export function lapStartDistancesMeters(laps: readonly LapLabelInput[]): number[] {
  const out: number[] = [];
  let cum = 0;
  for (const l of laps) {
    out.push(cum);
    cum += lapDistanceMeters(l) ?? 0;
  }
  return out;
}

/**
 * 该 lap 的**累计距离区间**标签，如 `2.0-3.0km`。
 *
 * 为什么不用序号：`lap_index` 是存储键，且 lap 长度可以是 0.08 km（时间切段的
 * 间歇课）。写 `K9` 会让读者以为「第 9 公里」，而真实位置可能是 3.63–3.72 km。
 * 累计区间是**唯一自证**的标签 —— 它与表里的「距离」列、与活动总距离都能对上。
 *
 * **精度自适应**：固定一位小数有两个失真方向 ——
 *
 *  - **零宽**：真实库有 7 条活动的「最快段」是 45–92 m（如 `633654536` 的 45.34 m
 *    落在 8.0–8.05 km），一位小数渲染成 `8.0-8.0km`，读起来像「零距离」；
 *  - **虚胖**：同一条段加到两位小数后是 `3.2-3.3km`（74 m 的段看起来像 100 m，
 *    放大 35%）—— 加位能消除零宽，却会重新引入「比实际宽」的失真。
 *
 * 故判据是「**打印宽度 ≤ 真实宽度 × 1.2**」：从一位小数起逐级加位，第一个满足
 * 该条件且两端可区分的精度胜出；三位仍不满足（段 < 0.5 m）时返回 null ——
 * 不打印一个自我矛盾的区间。
 *
 * `startMeters` 是该段起点累计距离（米），`distanceMeters` 是段长（米）。
 * 任一侧非法（NaN/负）时返回 null，调用方必须省略标签而不是打印 `NaN-NaNkm`。
 */
export function lapRangeLabel(
  startMeters: number,
  distanceMeters: number | null | undefined,
): string | null {
  if (!Number.isFinite(startMeters) || startMeters < 0) return null;
  if (distanceMeters == null || !Number.isFinite(distanceMeters) || distanceMeters < 0) return null;
  const from = startMeters / 1000;
  const to = (startMeters + distanceMeters) / 1000;
  const actualKm = to - from;
  for (let decimals = 1; decimals <= 3; decimals++) {
    const a = from.toFixed(decimals);
    const b = to.toFixed(decimals);
    if (a === b) continue; // 零宽，不可接受
    const printedKm = Number(b) - Number(a);
    // 打印宽度不得超过真实宽度的 1.2 倍：否则 74 m 的段会显示成
    // `3.2-3.3km`（看似 100 m），把「这一段多长」说大了 35%。
    if (printedKm <= actualKm * 1.2) return `${a}-${b}km`;
  }
  // 三位小数仍无法既区分两端又不虚胖 → 该段 < 0.5 m，标签没有意义。
  return null;
}

/**
 * 在有序分段列表里定位某个 `lapIndex`（存储键）的**下标**。
 *
 * 返回 null 的语义是「这条 lap 不在列表里」—— 调用方必须据此**隐藏标签**，
 * 而不是打印 `#-1` / `第 -1 段` 之类的脏值。
 *
 * 同时接受 `lapIndex`（派生结构）与 `lap_index`（DB 行）两种字段名：否则调用点
 * 又会各自写一遍 `findIndex`，正是本模块要消灭的那类重复。
 */
export function lapPositionOf(
  laps: readonly { lapIndex?: number; lap_index?: number }[],
  lapIndex: number | null | undefined,
): number | null {
  if (lapIndex == null || !Number.isFinite(lapIndex)) return null;
  const position = laps.findIndex((l) => (l.lapIndex ?? l.lap_index) === lapIndex);
  return position < 0 ? null : position;
}

/**
 * 「最快段」徽章文案 —— 唯一实现。
 *
 * - 每段都约 1 km：`最快 K3`（紧凑，且此时「第 3 公里」是真的）
 * - 否则：`最快段 5.8-6.8km`（自证，不与公里数撒谎）
 *
 * 找不到该 lap 或没有可信最快段时返回 null —— 调用方据此**不渲染徽章**。
 */
export function lapBestBadgeLabel(
  laps: readonly LapLabelInput[],
  bestPosition: number | null,
): string | null {
  if (bestPosition == null || bestPosition < 0 || bestPosition >= laps.length) return null;
  if (allLapsOneKm(laps)) return `最快 K${lapOrdinalAt(bestPosition)}`;
  const starts = lapStartDistancesMeters(laps);
  const range = lapRangeLabel(starts[bestPosition], lapDistanceMeters(laps[bestPosition]));
  return range == null ? null : `最快段 ${range}`;
}

/**
 * 「最快段」在深度分析卡片上的 hint —— 唯一实现。
 *
 * 与徽章同一份判据，但用词不同（卡片旁是「最快分段」这个指标名，hint 只需
 * 指出是哪一段）：
 * - 每段都约 1 km：`第 3 公里`
 * - 否则：`5.8-6.8km`
 */
export function lapBestHintLabel(
  laps: readonly LapLabelInput[],
  bestPosition: number | null,
): string | null {
  if (bestPosition == null || bestPosition < 0 || bestPosition >= laps.length) return null;
  if (allLapsOneKm(laps)) return `第 ${lapOrdinalAt(bestPosition)} 公里`;
  const starts = lapStartDistancesMeters(laps);
  return lapRangeLabel(starts[bestPosition], lapDistanceMeters(laps[bestPosition]));
}

/**
 * 分段强度分布的标签（AI 数据块用），与 `llm.ts` 的分段行**同一写法**。
 *
 * 旧实现用 `K${lapIndex}=Z2`，模型会读成「第 N 公里」。改用累计区间后，
 * 「分段主区间 5.8-6.8km=Z4」与「5.8-6.8km 4:25 168bpm」两行能直接对上 ——
 * 这是模型判断「主课段是否真的在目标强度」的前提。
 *
 * 入参是**已算好的起点累计距离**（由 `lapStartDistancesMeters` 一次算出），
 * 避免每个 lap 重算前缀和（O(n²) 且容易在过滤后错位）。
 */
export function lapZoneSpreadLabel(
  startMeters: number | undefined,
  distanceMeters: number | null | undefined,
): string | null {
  if (startMeters == null) return null;
  return lapRangeLabel(startMeters, distanceMeters);
}
