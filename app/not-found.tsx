import Link from "next/link";
import { StateMessage } from "@/app/components/ui/StateMessage";

export default function NotFound() {
  return (
    <StateMessage
      icon="🧭"
      title="页面不存在"
      description="你访问的地址没有对应的内容，可能是链接失效或输入有误。"
      action={
        <Link
          href="/"
          className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-[var(--brand-fg)] hover:bg-[var(--brand-strong)]"
        >
          返回首页
        </Link>
      }
    />
  );
}
