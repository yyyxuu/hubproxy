// ---------- JSON 响应工具 ----------

/** 统一的 JSON 响应（带 UTF-8 与短缓存头） */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/** 解析正整数查询参数；缺失或非法回退默认值 */
export function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null || !/^\d+$/.test(raw.trim())) return fallback
  const n = Number(raw.trim())
  return n > 0 ? n : fallback
}
