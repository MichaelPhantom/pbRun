/**
 * AI 教练请求的服务端准入控制 —— **速率 + 并发**双闸门（唯一实现）。
 *
 * ## 为什么需要（features.md §4.2 待办）
 *
 * 两个教练端点（`/api/insight/coach`、`/api/activities/{id}/analysis`）此前
 * 无任何服务端限流，完全依赖本机网关与模型回退。单用户场景下这也有真实风险：
 * 前端重试循环 / 多个标签页同时发起分析，会把长耗时（60–150s）的流式请求
 * 堆到本地网关上。多用户部署前则必须有按 IP 的速率限制。
 *
 * ## 口径
 *
 * - **速率**：滑动窗口，每个 key 在 `COACH_RATE_WINDOW_SEC`（默认 60s）内
 *   最多 `COACH_RATE_LIMIT`（默认 20）次。超限 → 429 + `Retry-After`。
 * - **并发**：全局同时进行的流最多 `COACH_MAX_CONCURRENT`（默认 2）个。
 *   流结束（完成/取消/出错）即释放槽位；释放幂等。
 * - **key**：nginx 门户后的真实客户端 IP（`x-forwarded-for` 首跳 /
 *   `x-real-ip`），取不到时回落 `local`。单用户部署下等价于全局窗口。
 * - 两个阈值都可用环境变量覆盖；**设 0 关闭对应闸门**（测试/e2e 用）。
 *
 * ## 为什么放在出流层而不是路由
 *
 * `runCoachStream` 是两个端点**唯一共用**的出流策略层（见 coach-stream.ts
 * 头注）——准入控制放在这里，两个端点自动同口径，不会出现「一个限了一个没限」。
 * 与「窗口逻辑只能有一份实现」（lap-zones）同一纪律。
 *
 * 模块级状态在 `next start` 单进程内共享；dev 热重载会重置（可接受）。
 */

export interface CoachLimitConfig {
  /** 窗口内最大请求数；0 = 关闭速率闸门。 */
  maxRequests: number;
  /** 滑动窗口长度（毫秒）。 */
  windowMs: number;
  /** 全局最大并发流数；0 = 关闭并发闸门。 */
  maxConcurrent: number;
}

export const DEFAULT_COACH_LIMITS: CoachLimitConfig = {
  maxRequests: 20,
  windowMs: 60_000,
  maxConcurrent: 2,
};

/** 并发被拒时的 Retry-After 提示（秒）——流可能长达 90s+，只给短提示。 */
export const CONCURRENT_RETRY_AFTER_SEC = 5;

export type Admission =
  | { admitted: true; release: () => void }
  | { admitted: false; retryAfterSec: number; error: string };

/** 每个 key 的窗口内请求时刻（升序）。 */
const hits = new Map<string, number[]>();
/** 当前进行中的流数（全局）。 */
let concurrent = 0;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 每次调用时读 env —— 测试与运维改档无需重启模块。 */
export function coachLimitConfig(): CoachLimitConfig {
  return {
    maxRequests: envInt('COACH_RATE_LIMIT', DEFAULT_COACH_LIMITS.maxRequests),
    windowMs: envInt('COACH_RATE_WINDOW_SEC', DEFAULT_COACH_LIMITS.windowMs / 1000) * 1000,
    maxConcurrent: envInt('COACH_MAX_CONCURRENT', DEFAULT_COACH_LIMITS.maxConcurrent),
  };
}

/**
 * 从请求头取限流 key：门户 nginx 会带 `x-forwarded-for` / `x-real-ip`；
 * 直连（开发/测试）取不到时回落 `local`。
 */
export function coachRateLimitKey(headers: { get(name: string): string | null }): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip');
  if (real && real.trim()) return real.trim();
  return 'local';
}

/**
 * 申请一次准入。通过时返回 `release`（流结束/失败时调用，幂等）；
 * 拒绝时给出 429 语义的 `retryAfterSec` 与中文错误文案。
 *
 * `now` 可注入（测试用），生产用 Date.now()。
 */
export function admitCoachRequest(key: string, now: number = Date.now()): Admission {
  const cfg = coachLimitConfig();

  // 速率闸门（滑动窗口）
  if (cfg.maxRequests > 0) {
    const cutoff = now - cfg.windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= cfg.maxRequests) {
      const oldest = recent[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + cfg.windowMs - now) / 1000));
      hits.set(key, recent);
      return {
        admitted: false,
        retryAfterSec,
        error: 'AI 请求过于频繁，请稍后再试',
      };
    }
    recent.push(now);
    hits.set(key, recent);
  }

  // 并发闸门（全局）
  if (cfg.maxConcurrent > 0 && concurrent >= cfg.maxConcurrent) {
    return {
      admitted: false,
      retryAfterSec: CONCURRENT_RETRY_AFTER_SEC,
      error: '已有 AI 分析正在进行，请等待当前分析完成或点击停止',
    };
  }

  concurrent++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    concurrent = Math.max(0, concurrent - 1);
  };
  return { admitted: true, release };
}

/** 仅供测试：清空窗口与并发状态。 */
export function __resetCoachRateLimit(): void {
  hits.clear();
  concurrent = 0;
}