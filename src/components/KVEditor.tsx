/**
 * 键值对编辑器：环境变量 / 自定义请求头等键值对的通用编辑控件，输出 JSON 对象字符串。
 * 供 Server 配置表单与环境编辑弹窗共用。
 *
 * 可选支持「敏感条目」标记（仅调用方传入 sensitiveKeys 时启用）：勾选的行值以
 * 密码框形式打码显示（眼睛可临时切换明文），标记随 key 改名/删行自动跟随；
 * 敏感标记只影响展示，真实值仍原样写回 JSON，连接时使用真实值。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { GrowTextarea } from "./ui";
import { copyText } from "../lib/clipboard";

/** 键值对编辑器属性 */
interface KVProps {
  title: string;
  /** JSON 对象字符串 */
  json: string;
  /**
   * 内容写回回调。
   * @param json JSON 对象字符串（空串 = 无有效条目；存在键名重复的行时不写回、保持原值）
   * @param error 内容错误文案（null/缺省 = 无错误）。目前唯一错误是键名重复——
   *             重名条目无法用 JSON 对象表达，编辑器不写回并保留草稿行，
   *             调用方应据此禁用保存，避免静默合并丢数据
   */
  onChange: (json: string, error?: string | null) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** 敏感条目的 key 列表（受控）。不传 = 关闭敏感标记能力（不渲染 checkbox） */
  sensitiveKeys?: string[];
  /** 敏感标记变化回调：勾选/取消/改名跟随/删行移除时触发，调用方负责持久化 */
  onSensitiveKeysChange?: (keys: string[]) => void;
  /** 可引用的环境变量名列表（当前激活环境）。传入时在编辑器底部渲染提示条，
   *  点击变量chip复制 {{变量名}} 引用；传空数组时提示去环境管理里添加 */
  availableVars?: string[];
}

/**
 * 找出键值行中的重复键名（按去首尾空格后的名称判重，区分大小写）。
 *
 * @param rows 键值行
 * @returns 重复键名列表（去重、按首现顺序）；无重复返回 null
 *
 * @example
 * findDuplicateKeys([["API", "1"], ["API", "2"], ["X", ""]]); // => ["API"]
 * findDuplicateKeys([["A", "1"]]);                            // => null
 */
function findDuplicateKeys(rows: Array<[string, string]>): string[] | null {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const [k] of rows) {
    const t = k.trim();
    if (!t) continue;
    if (seen.has(t)) dups.add(t);
    else seen.add(t);
  }
  return dups.size > 0 ? [...dups] : null;
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
  availableVars,
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

  /** 当前重复键名（渲染期派生：行标红与底部提示始终与行内容一致） */
  const dupKeys = useMemo(
    () => findDuplicateKeys(rows.filter(([k]) => k.trim() !== "")),
    [rows],
  );

  /**
   * 值输入框内 `{{变量名}}` 的补全状态（availableVars 非空时启用）：
   * 光标前存在未闭合的 `{{` 即触发下拉提示，选择项后按 braceStart/cursor
   * 切割替换为 `{{变量名}}` 完整引用。
   */
  const [suggest, setSuggest] = useState<{
    /** 触发补全的行下标 */
    row: number;
    /** 值中 `{{` 的起始位置（含两个花括号） */
    braceStart: number;
    /** 触发时的光标位置 */
    cursor: number;
    /** 已输入的过滤前缀（`{{` 之后到光标的原文） */
    prefix: string;
  } | null>(null);
  /** 补全下拉的高亮项下标（↑↓ 移动、Enter 确认） */
  const [suggestIdx, setSuggestIdx] = useState(0);

  /** 检测光标前是否有未闭合的 `{{`：有则打开/更新补全，否则关闭 */
  const detectSuggest = (row: number, text: string, cursor: number | null) => {
    if (!availableVars?.length || cursor == null) {
      setSuggest(null);
      return;
    }
    const before = text.slice(0, cursor);
    const idx = before.lastIndexOf("{{");
    if (idx < 0) {
      setSuggest(null);
      return;
    }
    const rest = before.slice(idx + 2);
    if (rest.includes("}}")) {
      // 已闭合：关闭补全（引用已写完）
      setSuggest(null);
      return;
    }
    setSuggest({ row, braceStart: idx, cursor, prefix: rest });
    setSuggestIdx(0);
  };

  /** 当前补全候选（按前缀不区分大小写过滤；前缀空 = 全部变量） */
  const suggestCandidates = suggest
    ? (availableVars ?? []).filter((name) =>
        name.toLowerCase().includes(suggest.prefix.trim().toLowerCase()),
      )
    : [];
  const suggestVisible =
    suggest != null &&
    rows[suggest.row] != null &&
    suggestCandidates.length > 0;

  /** 应用补全：把触发区间替换为 `{{变量名}}` 完整引用并关闭下拉 */
  const applySuggest = (name: string) => {
    if (!suggest) return;
    const next = [...rows];
    const [k, v] = next[suggest.row];
    next[suggest.row] = [
      k,
      v.slice(0, suggest.braceStart) + `{{${name}}}` + v.slice(suggest.cursor),
    ];
    setRows(next);
    setSuggest(null);
  };

  /**
   * 行变化：有效行写回 JSON；含空 key 行时保留在草稿中供继续填写。
   * 存在键名重复的行时**不写回**——JSON 对象无法表达重复键，直接序列化会静默
   * 合并覆盖丢行（如 API1 改名为 API）；此时保持上一份合法 JSON 与完整草稿行，
   * 错误文案经 onChange 第二参数通知调用方禁用保存。
   */
  const setRows = (next: Array<[string, string]>) => {
    const valid = next.filter(([k]) => k.trim() !== "");
    const dups = findDuplicateKeys(valid);
    if (dups) {
      // 重名：json 保持原值（不产生合法写回），仅上报错误；草稿保留全部行
      onChange(json, `存在重复的键名：${dups.join("、")}`);
      setDraft(next);
      return;
    }
    const out = valid.length === 0 ? "" : JSON.stringify(Object.fromEntries(valid));
    lastWritten.current = out;
    onChange(out, null);
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
          /** 值框共用事件：{{变量}} 补全检测与键盘导航（打码/明文两态行为一致） */
          const valueEvents = {
            onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
              const next = [...rows];
              next[i] = [k, e.target.value];
              setRows(next);
              detectSuggest(i, e.target.value, e.target.selectionStart);
            },
            onKeyUp: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
              // 打字/移动光标都可能改变 {{ 触发区（onChange 覆盖不了纯移动光标）
              detectSuggest(i, e.currentTarget.value, e.currentTarget.selectionStart);
            },
            onBlur: () => setSuggest(null),
            onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
              if (!suggestVisible) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSuggestIdx((n) => Math.min(n + 1, suggestCandidates.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSuggestIdx((n) => Math.max(n - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                applySuggest(suggestCandidates[suggestIdx]);
              } else if (e.key === "Escape") {
                setSuggest(null);
              }
            },
          };
          return (
            <div key={i} className="flex items-center gap-1.5">
              <input
                className={`field min-w-0 flex-1 font-mono !py-1 ${
                  dupKeys?.includes(k.trim()) ? "!border-err/60" : ""
                }`}
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
              {/* 值输入框：relative 容器承载 {{变量}} 补全下拉。
                  打码行用密码 input（textarea 无法打码），其余用可增高文本框看长值 */}
              <span className="relative flex min-w-0 flex-1">
                {masked ? (
                  <input
                    {...valueEvents}
                    className="field font-mono !py-1 !pr-1 tracking-widest"
                    placeholder={valuePlaceholder}
                    type="password"
                    value={v}
                  />
                ) : (
                  <GrowTextarea
                    {...valueEvents}
                    className="field font-mono !py-1"
                    placeholder={valuePlaceholder}
                    value={v}
                  />
                )}
                {/* {{变量}} 补全下拉：mousedown 阻止默认以保持输入框焦点 */}
                {suggestVisible && (
                  <span className="absolute left-0 top-full z-20 mt-1 max-h-[150px] w-full overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-lg">
                    {suggestCandidates.map((name, ci) => (
                      <button
                        key={name}
                        className={`flex w-full items-center px-2.5 py-1 text-left font-mono text-[12px] transition-colors ${
                          ci === suggestIdx ? "bg-hover text-ink" : "text-inksoft hover:bg-hover hover:text-ink"
                        }`}
                        // mousedown 先于 blur：preventDefault 保住输入框焦点，点击后主动关闭
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applySuggest(name);
                        }}
                      >
                        <span className="truncate text-primarystrong">{"{{"}{name}{"}}"}</span>
                      </button>
                    ))}
                  </span>
                )}
              </span>
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
        {/* 键名重复提示：重名条目不写回（不会静默合并），调用方据此禁用保存 */}
        {dupKeys && (
          <p className="text-[11.5px] leading-relaxed text-err">
            存在重复的键名：{dupKeys.join("、")}——重复条目不会被保存，请修改名称后再保存。
          </p>
        )}
        {/* 环境变量引用提示条：点击 chip 复制 {{变量名}}，粘贴到任意值框即可引用 */}
        {availableVars != null && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-inksoft">
            <span className="shrink-0">可引用：</span>
            {availableVars.length > 0 ? (
              <>
                <span className="shrink-0 text-inksoft/60">（输入 {"{{"} 可弹出提示）</span>
                {availableVars.map((name) => <VarChip key={name} name={name} />)}
              </>
            ) : (
              <span className="text-inksoft/70">
                暂无可引用变量：在顶栏「环境」中选择环境并添加变量后，值里输入 {"{{"} 即可弹出提示。
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 变量引用 chip：展示 {{变量名}}，点击复制引用文本（复制成功短暂显示「已复制」） */
function VarChip({ name }: { name: string }) {
  /** 复制成功的短暂反馈态 */
  const [copied, setCopied] = useState(false);
  /** 反馈恢复计时器（重复点击时重置） */
  const timer = useRef<number | null>(null);

  return (
    <button
      className="rounded border border-line bg-panel2 px-1.5 py-0.5 font-mono text-primarystrong transition-colors hover:bg-primarysoft"
      title={`点击复制 {{${name}}}，粘贴到值输入框即可引用`}
      onClick={() => {
        void copyText(`{{${name}}}`).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current != null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "已复制 ✓" : `{{${name}}}`}
    </button>
  );
}
