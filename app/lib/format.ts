/**
 * 前端展示用的格式化工具
 */

/** 配速：秒/公里 → "5:30" 或 "5:30 /km" */
export function formatPace(secondsPerKm: number | null | undefined, withUnit = true): string {
  if (secondsPerKm == null || Number.isNaN(secondsPerKm)) return '--';
  const min = Math.floor(secondsPerKm / 60);
  const sec = Math.round(secondsPerKm % 60);
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

/** 日期时间：ISO 字符串 → 本地日期时间 YYYY/MM/DD HH:MM（确定性格式, 不依赖系统 locale） */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${h}:${min}`;
}

/** 仅日期：YYYY/MM/DD（确定性格式, 不依赖系统 locale） */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 列表项日期时间：YYYY/MM/DD(周x) HH:MM */
export function formatListDateTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const week = WEEKDAY_ZH[d.getDay()];
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
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
