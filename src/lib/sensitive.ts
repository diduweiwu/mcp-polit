/**
 * 敏感请求头标记的序列化工具：sensitive_headers 字段（JSON 数组字符串，如
 * '["Authorization"]'）与 string[] 之间的互转。解析失败一律按空列表处理。
 */

/**
 * 解析敏感头名称列表 JSON 字符串。
 *
 * @param raw sensitive_headers 字段原文（JSON 数组字符串；空/非法均视为未标记）
 * @returns 敏感头名称数组
 *
 * @example
 * parseSensitiveKeys('["Authorization"]'); // => ["Authorization"]
 * parseSensitiveKeys(null);                // => []
 */
export function parseSensitiveKeys(raw?: string | null): string[] {
  const s = raw?.trim();
  if (!s) return [];
  try {
    const arr = JSON.parse(s) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 序列化敏感头名称列表为 JSON 字符串（空列表归一为空串，与其它可空字段惯例一致）。
 *
 * @param keys 敏感头名称数组
 * @returns JSON 数组字符串；空列表返回空串
 *
 * @example
 * stringifySensitiveKeys(["Authorization"]); // => '["Authorization"]'
 * stringifySensitiveKeys([]);                // => ""
 */
export function stringifySensitiveKeys(keys: string[]): string {
  return keys.length ? JSON.stringify(keys) : "";
}

/**
 * 判断某 key 是否被标记为敏感。
 *
 * @param keys 敏感头名称数组
 * @param k 待判断的条目名称
 * @returns 是否敏感
 *
 * @example
 * isSensitiveKey(["Authorization"], "Authorization"); // => true
 */
export function isSensitiveKey(keys: string[], k: string): boolean {
  return !!k.trim() && keys.includes(k);
}
