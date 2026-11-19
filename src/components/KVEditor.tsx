/**
 * 键值对编辑器：环境变量 / 自定义请求头等键值对的通用编辑控件，输出 JSON 对象字符串。
 * 供 Server 配置表单与环境编辑弹窗共用。
 *
 * 可选支持「敏感条目」标记（仅调用方传入 sensitiveKeys 时启用）：勾选的行值以
 * 密码框形式打码显示（眼睛可临时切换明文），标记随 key 改名/删行自动跟随；
 * 敏感标记只影响展示，真实值仍原样写回 JSON，连接时使用真实值。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";

/** 键值对编辑器属性 */
interface KVProps {
  title: string;
  /** JSON 对象字符串 */
  json: string;
  onChange: (json: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** 敏感条目的 key 列表（受控）。不传 = 关闭敏感标记能力（不渲染 checkbox） */
  sensitiveKeys?: string[];
  /** 敏感标记变化回调：勾选/取消/改名跟随/删行移除时触发，调用方负责持久化 */
  onSensitiveKeysChange?: (keys: string[]) => void;
}

/** 键值对编辑器：环境变量 / 自定义请求头用，输出 JSON 对象字符串 */
export function KVEditor({
  title,
  json,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  sensitiveKeys,
  onSensitiveKeysChange,
}: KVProps) {
  /** 从 JSON 解析出键值行（非法 JSON 时显示为空，合法性由父级提交校验提示） */
  const parsed: Array<[string, string]> = useMemo(() => {
    if (!json.trim()) return [];
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      return Object.entries(obj).map(([k, v]) => ([k, String(v)]));
    } catch {
      return [];
    }
  }, [json]);

  /**
   * 草稿行：承载「已添加但 key 尚未填写」的空行。
   * 空行不能写回 JSON（写回时必须过滤空 key），而展示行又由 json 派生，
   * 纯受控会让空行刚加上就消失——故用本地草稿保存，外部 json 变化时丢弃。
   */
  const [draft, setDraft] = useState<Array<[string, string]> | null>(null);
  /** 最近一次本组件写出的 JSON；用于区分自身写回与外部变化（避免误清草稿） */
  const lastWritten = useRef<string | null>(null);
  /** 已切换为明文显示的敏感行（按 key 记录；仅勾选敏感的行受其影响） */
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  /** 敏感能力是否启用（调用方传了 sensitiveKeys 才渲染 checkbox） */
  const sensitiveOn = sensitiveKeys != null && onSensitiveKeysChange != null;

  useEffect(() => {
    if (lastWritten.current !== null && lastWritten.current === json) return;
    lastWritten.current = null;
    setDraft(null);
  }, [json]);

  /** 展示行：优先草稿（含待填写的空行），否则为 JSON 解析结果 */
  const rows = draft ?? parsed;

  /** 行变化：有效行写回 JSON；含空 key 行时保留在草稿中供继续填写 */
  const setRows = (next: Array<[string, string]>) => {
    const valid = next.filter(([k]) => k.trim() !== "");
    const out = valid.length === 0 ? "" : JSON.stringify(Object.fromEntries(valid));
    lastWritten.current = out;
    onChange(out);
    setDraft(next.some(([k]) => k.trim() === "") ? next : null);
  };

  /** 某行当前是否标记为敏感（空 key 行视为否） */
  const isSensitive = (k: string) => !!k.trim() && !!sensitiveKeys?.includes(k);

  /** 切换某行的敏感标记 */
  const toggleSensitive = (k: string) => {
    if (!sensitiveKeys || !onSensitiveKeysChange) return;
    const next = sensitiveKeys.includes(k)
      ? sensitiveKeys.filter((s) => s !== k)
      : [...sensitiveKeys, k];
    if (!sensitiveKeys.includes(k)) {
      // 标记为敏感：默认打码显示
      setRevealed((r) => {
        const n = new Set(r);
        n.delete(k);
        return n;
      });
    }
    onSensitiveKeysChange(next);
  };

  /** 行 key 改名：敏感标记集合里同步替换，标记跟随新名称 */
  const renameInSensitive = (oldK: string, newK: string) => {
    if (!sensitiveKeys || !onSensitiveKeysChange) return false;
    if (!sensitiveKeys.includes(oldK)) return false;
    onSensitiveKeysChange(sensitiveKeys.map((s) => (s === oldK ? newK : s)));
    return true;
  };

  /** 行删除：敏感标记集合里移除对应 key */
  const removeFromSensitive = (k: string) => {
    if (!sensitiveKeys || !onSensitiveKeysChange) return;
    if (!sensitiveKeys.includes(k)) return;
    onSensitiveKeysChange(sensitiveKeys.filter((s) => s !== k));
  };

  /** 切换某敏感行的明文/打码显示 */
  const toggleReveal = (k: string) => {
    setRevealed((r) => {
      const next = new Set(r);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="label !mb-0">{title}</label>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-inksoft hover:bg-panel2 hover:text-ink"
          onClick={() => setRows([...rows, ["", ""]])}
        >
          <Plus size={12} /> 添加
        </button>
      </div>
      <div className="space-y-1.5">
        {rows.length === 0 && (
          <div className="rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-inksoft/70">
            暂无条目，点击「添加」新增。
          </div>
        )}
        {rows.map(([k, v], i) => {
          const sensitive = isSensitive(k);
          /** 该行值框当前实际展示形态：敏感且未点眼睛时用密码框打码 */
          const masked = sensitive && !revealed.has(k);
          return (
            <div key={i} className="flex items-center gap-1.5">
              <input
                className="field font-mono !py-1"
                placeholder={keyPlaceholder}
                value={k}
                onChange={(e) => {
                  const newK = e.target.value;
                  const next = [...rows];
                  next[i] = [newK, v];
                  setRows(next);
                  renameInSensitive(k, newK);
                }}
              />
              <input
                className={`field font-mono !py-1 ${masked ? "!pr-1 tracking-widest" : ""}`}
                placeholder={valuePlaceholder}
                type={masked ? "password" : "text"}
                value={v}
                onChange={(e) => {
                  const next = [...rows];
                  next[i] = [k, e.target.value];
                  setRows(next);
                }}
              />
              {sensitive && (
                <button
                  className="shrink-0 rounded p-0.5 text-inksoft transition-colors hover:bg-panel2 hover:text-ink"
                  title={masked ? "值已脱敏显示，点击查看明文" : "点击恢复脱敏显示"}
                  onClick={() => toggleReveal(k)}
                >
                  {masked ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              )}
              {sensitiveOn && (
                <label
                  className={`flex shrink-0 items-center gap-0.5 text-[11px] ${
                    sensitive ? "text-primarystrong" : "text-inksoft"
                  } ${!k.trim() ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                  title="敏感信息：值在配置摘要与编辑器中打码显示（眼睛可临时查看明文），连接仍使用真实值"
                >
                  <input
                    type="checkbox"
                    className="accent-primarystrong"
                    disabled={!k.trim()}
                    checked={sensitive}
                    onChange={() => toggleSensitive(k)}
                  />
                  敏感
                </label>
              )}
              <button
                className="rounded p-1 text-inksoft hover:bg-err/10 hover:text-err"
                title="删除"
                onClick={() => {
                  setRows(rows.filter((_, idx) => idx !== i));
                  removeFromSensitive(k);
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
