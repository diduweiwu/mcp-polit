/**
 * 键值对编辑器：环境变量 / 自定义请求头等键值对的通用编辑控件，输出 JSON 对象字符串。
 * 供 Server 配置表单与环境编辑弹窗共用。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

/** 键值对编辑器属性 */
interface KVProps {
  title: string;
  /** JSON 对象字符串 */
  json: string;
  onChange: (json: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

/** 键值对编辑器：环境变量 / 自定义请求头用，输出 JSON 对象字符串 */
export function KVEditor({ title, json, onChange, keyPlaceholder, valuePlaceholder }: KVProps) {
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
        {rows.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className="field font-mono !py-1"
              placeholder={keyPlaceholder}
              value={k}
              onChange={(e) => {
                const next = [...rows];
                next[i] = [e.target.value, v];
                setRows(next);
              }}
            />
            <input
              className="field font-mono !py-1"
              placeholder={valuePlaceholder}
              value={v}
              onChange={(e) => {
                const next = [...rows];
                next[i] = [k, e.target.value];
                setRows(next);
              }}
            />
            <button
              className="rounded p-1 text-inksoft hover:bg-err/10 hover:text-err"
              title="删除"
              onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
