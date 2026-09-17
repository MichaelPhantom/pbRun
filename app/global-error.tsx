"use client";

/**
 * 全局错误边界 —— 捕获根 layout 自身的渲染错误。
 * 注意: 此文件替换根 layout, 必须自带 <html>/<body>, 且不依赖全局样式类
 * (globals.css 可能未加载), 故使用内联样式保证可读。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#0b0d10",
          color: "#e6e8eb",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem", maxWidth: 420 }}>
          <div style={{ fontSize: 40 }} aria-hidden>
            ⚠️
          </div>
          <h1 style={{ fontSize: 18, margin: "0.75rem 0 0.5rem" }}>应用出错了</h1>
          <p style={{ fontSize: 14, color: "#9aa4af" }}>
            页面无法渲染，请重试。若持续出现请检查服务日志。
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, color: "#6b7681" }}>错误编号: {error.digest}</p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #2a313a",
              background: "#161b22",
              color: "#e6e8eb",
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </div>
      </body>
    </html>
  );
}
