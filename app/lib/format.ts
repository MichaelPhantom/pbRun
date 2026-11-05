/**
 * 前端展示用的格式化工具
 */
import { toBusinessWallClock } from './timezone';

/** 配速：秒/公里 → "5:30" 或 "5:30 /km" */
export function formatPace(secondsPerKm: number | null | undefined, withUnit = true): string {
  if (secondsPerKm == null || Number.isNaN(secondsPerKm)) return '--';
  // 先整体取整再拆分, 否则 Math.round(秒%60) 可能得到 60 (如 359.6 → "5:60")。
  const total = Math.round(secondsPerKm);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  const s = `${min}:${sec.toString().padStart(2, '0')}`;
  return withUnit ? `${s} /km` : s;
}

/** 距离：公里 → "10.05 km"（保留 2 位小数，入参已是 km） */
export function formatDistance(km: number | null | undefined): string {
  if (km == null || Number.isNaN(km)) return '--';
  return `${Number(km).toFixed(2)} km`;
}

/** 距离：米 → "10.05 km"（用于分段等接口仍返回米的场景） */
export function formatDistanceFromMeters(meters: number | null | undefined): string {
  if (meters == null || Number.isNaN(meters)) return '--';
  return `${(meters / 1000).toFixed(2)} km`;
}

/** 时长：秒 → "1:02:30" 或 "42:30" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/** 时长：秒 → "00:07:04"（个人纪录用，始终 HH:MM:SS） */
export function formatDurationRecord(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * 日期时间：ISO 字符串 → 本地日期时间 YYYY/MM/DD HH:MM（确定性格式, 不依赖系统 locale）
 *
 * 时区契约 (2026-11-06): 不读进程/设备时区。带时区标记的输入 (UTC `start_time`)
 * 换算到业务时区 (+480); 无标记的输入按项目契约已是本地墙钟 (`start_time_local`)
 * 直接透传 —— 两种情况在 TZ=UTC 的服务器与 CST 的用户浏览器上结果一致。
 * 旧实现 `new Date(iso).getHours()` 在 UTC 服务器上会把 UTC 时刻原样展示。
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const wall = toBusinessWallClock(iso);
  if (!wall) return '--';
  const [datePart, timePart] = wall.split('T');
  const [y, m, day] = datePart.split('-');
  const h = timePart.slice(0, 2);
  const min = timePart.slice(3, 5);
  return `${y}/${m}/${day} ${h}:${min}`;
}

/** 仅日期：YYYY/MM/DD（确定性格式, 不依赖系统 locale）。时区契约同 formatDateTime。 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '--';
  const wall = toBusinessWallClock(iso);
  if (!wall) return '--';
  const [y, m, day] = wall.slice(0, 10).split('-');
  return `${y}/${m}/${day}`;
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 列表项日期时间：YYYY/MM/DD(周x) HH:MM。时区契约同 formatDateTime。 */
export function formatListDateTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const wall = toBusinessWallClock(iso);
  if (!wall) return '--';
  const [y, m, day] = wall.slice(0, 10).split('-');
  // 星期由业务时区日期决定: 用 Date.UTC 构造再读 getUTCDay, 避免进程 TZ
  const week = WEEKDAY_ZH[new Date(Date.UTC(Number(y), Number(m) - 1, Number(day))).getUTCDay()];
  const h = wall.slice(11, 13);
  const min = wall.slice(14, 16);
  return `${y}/${m}/${day}(${week}) ${h}:${min}`;
}

/** 配速简短形式：4'57''（分'秒''） */
export function formatPaceShort(secondsPerKm: number | null | undefined): string {
  if (secondsPerKm == null || Number.isNaN(secondsPerKm)) return '--';
  const min = Math.floor(secondsPerKm / 60);
  const sec = Math.round(secondsPerKm % 60);
  return `${min}'${sec.toString().padStart(2, '0')}''`;
}

/** 月份标题：2026年2月 */
export function formatMonthYear(yearMonth: string): string {
  const [y, m] = yearMonth.split('-');
  if (!y || !m) return yearMonth;
  return `${y}年${parseInt(m, 10)}月`;
}

/** 心率等整数 */
export function formatInt(value: number | null | undefined, unit = ''): string {
  if (value == null || Number.isNaN(value)) return '--';
  return unit ? `${Math.round(value)} ${unit}` : String(Math.round(value));
}

/** 步频：步/分钟 */
export function formatCadence(spm: number | null | undefined): string {
  return formatInt(spm, '步/分');
}

/** 温度 */
export function formatTemp(c: number | null | undefined): string {
  if (c == null || Number.isNaN(c)) return '--';
  return `${c.toFixed(1)} °C`;
}

/** 恢复时间（Garmin 官方 `recovery_time`，单位**分钟**）拆成「数值 + 单位」。 */
export interface RecoveryDisplay {
  value: string;
  unit: '分' | '小时' | '天';
}

/**
 * 恢复时间 → 可读的「数值 + 单位」。
 *
 * 真实库 348 条活动的 `recovery_time` 分布：`0` 13 条、`1–59 分钟` 3 条、
 * `1–23 小时` 152 条、`≥24 小时` 180 条（最长 5020 分钟 ≈ 3.5 天）。因此三档都必须
 * 支持 —— 只用「小时」会把 3.5 天渲染成「84 小时」，只用「分钟」会出现「5020 分钟」。
 *
 * 为什么不写进 `llm.ts`：AI 数据块用分钟（便于模型做跨活动算术），UI 用可读单位，
 * 两者共用同一份阈值判定，避免「UI 说 3.5 天、prompt 说 84 小时」的口径漂移。
 */
export function formatRecoveryTime(minutes: number | null | undefined): RecoveryDisplay | null {
  if (minutes == null || Number.isNaN(minutes) || minutes < 0) return null;
  if (minutes < 60) return { value: String(Math.round(minutes)), unit: '分' };
  if (minutes < 1440) return { value: String(Math.round(minutes / 60)), unit: '小时' };
  return { value: (minutes / 1440).toFixed(1), unit: '天' };
}
