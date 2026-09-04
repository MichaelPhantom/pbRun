import Link from 'next/link';

export default function ActivityNotFound() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-[var(--crit-soft)] bg-[var(--crit-soft)] px-4 py-3 text-[var(--crit)]">
        活动不存在
      </div>
      <Link
        href="/list"
        className="text-[var(--brand)] hover:underline"
      >
        返回运动记录
      </Link>
    </div>
  );
}
