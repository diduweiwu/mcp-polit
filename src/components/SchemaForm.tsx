/**
 * JSON Schema → 表单渲染器：第三栏根据工具的 inputSchema 自动生成参数表单。
 *
 * 支持：string（含 enum 下拉、密码框）、number/integer、boolean、
 * 基础类型数组、嵌套对象；复杂结构回退为 JSON 文本编辑。
 */
import { Plus, Trash2 } from "lucide-react";
import type { JsonSchema } from "../types";

/** 表单值（与 schema 对应的树形对象） */
export type FormValue = Record<string, unknown>;

/**
 * 按 schema 生成初始值：应用 default 字段，其余标量留空。
 *
 * @example
 * const v = buildDefaults(tool.input_schema); // { name: "预填", count: undefined }
 */
export function buildDefaults(schema: JsonSchema): FormValue {
  const out: FormValue = {};
  if (schema.type !== "object" || !schema.properties) return out;
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.default !== undefined) {
      out[key] = prop.default;
    } else if (isEnumSchema(prop)) {
      out[key] = undefined;
    } else {
      switch (resolveType(prop)) {
        case "string":
          out[key] = "";
          break;
        case "boolean":
          out[key] = false;
          break;
        case "array":
          out[key] = [];
          break;
        case "object":
          out[key] = {};
          break;
        default:
          out[key] = undefined;
      }
    }
  }
  return out;
}

/**
 * 裁剪入参：去掉未填（undefined）的项；非必填的空串也一并去掉。
 *
 * @example
 * const args = pruneArgs(value, schema); // 只保留用户实际填写/必填的字段
 */
export function pruneArgs(value: FormValue, schema: JsonSchema): FormValue {
  const required = new Set(schema.required ?? []);
  const out: FormValue = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (v === "" && !required.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 取 schema 的主类型（type 可能是数组） */
function resolveType(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) return schema.type[0] ?? "";
  return schema.type ?? "";
}

/** 是否为枚举 schema */
function isEnumSchema(schema: JsonSchema): boolean {
  return Array.isArray(schema.enum) && schema.enum.length > 0;
}

/** 值更新回调类型 */
type OnChange = (v: unknown) => void;

/** 单个字段渲染入口（递归） */
function SchemaField({
  name,
  schema,
  value,
  onChange,
  required,
  depth,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: OnChange;
  required: boolean;
  depth: number;
}) {
  const type = resolveType(schema);
  const label = schema.title || name;

  /* 枚举 → 下拉 */
  if (isEnumSchema(schema)) {
    return (
      <Row label={label} required={required} desc={schema.description}>
        <select
          className="field"
          value={value === undefined || value === "" ? "" : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange(undefined);
            const num = Number(raw);
            onChange(schema.enum!.some((x) => typeof x === "number") ? num : raw);
          }}
        >
          <option value="">（未选择）</option>
          {schema.enum!.map((opt, i) => (
            <option key={i} value={String(opt)}>
              {schema.enumNames?.[i] ?? String(opt)}
            </option>
          ))}
        </select>
      </Row>
    );
  }

  switch (type) {
    case "string": {
      const secret = /token|secret|key|password|credential/i.test(name);
      if (secret) {
        return (
          <Row label={label} required={required} desc={schema.description}>
            <input
              className="field font-mono"
              type="password"
              autoComplete="off"
              placeholder={schema.description}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
            />
          </Row>
        );
      }
      return (
        <Row label={label} required={required} desc={schema.description}>
          <input
            className="field"
            placeholder={schema.description || "字符串"}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </Row>
      );
    }
    case "number":
    case "integer": {
      return (
        <Row label={label} required={required} desc={schema.description}>
          <input
            className="field"
            type="number"
            step={type === "integer" ? 1 : "any"}
            min={schema.minimum}
            max={schema.maximum}
            placeholder={schema.description || (type === "integer" ? "整数" : "数字")}
            value={typeof value === "number" ? value : ""}
            onChange={(e) => {
              const raw = e.target.value;
              onChange(raw === "" ? undefined : Number(raw));
            }}
          />
        </Row>
      );
    }
    case "boolean": {
      return (
        <Row label={label} required={required} desc={schema.description}>
          <button
            className={`flex h-[30px] w-14 items-center rounded-full border px-0.5 transition-colors ${
              value ? "justify-end border-primary bg-primarysoft" : "justify-start border-line bg-panel2"
            }`}
            onClick={() => onChange(!value)}
          >
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
                value ? "bg-primarystrong text-white" : "bg-panel text-inksoft border border-line"
              }`}
            >
              {value ? "是" : "否"}
            </span>
          </button>
        </Row>
      );
    }
    case "array": {
      const itemType = schema.items ? resolveType(schema.items) : "";
      const primitive = ["string", "number", "integer", "boolean"].includes(itemType);
      if (!primitive || depth > 3) {
        return <JsonSubEdit label={label} required={required} desc={schema.description} value={value} onChange={onChange} />;
      }
      const arr = Array.isArray(value) ? value : [];
      return (
        <Row label={label} required={required} desc={schema.description}>
          <div className="space-y-1.5">
            {arr.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  className="field !py-1"
                  value={item === undefined || item === null ? "" : String(item)}
                  onChange={(e) => {
                    const next = [...arr];
                    next[i] = itemType === "number" || itemType === "integer"
                      ? e.target.value === "" ? undefined : Number(e.target.value)
                      : e.target.value;
                    onChange(next.filter((x) => x !== undefined));
                  }}
                />
                <button
                  className="rounded p-1 text-inksoft hover:bg-err/10 hover:text-err"
                  title="移除"
                  onClick={() => onChange(arr.filter((_, idx) => idx !== i))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <button
              className="flex items-center gap-1 rounded border border-dashed border-line px-2 py-1 text-[12px] text-inksoft hover:border-primary hover:text-primarystrong"
              onClick={() => onChange([...arr, itemType === "boolean" ? true : ""])}
            >
              <Plus size={12} /> 添加一项
            </button>
          </div>
        </Row>
      );
    }
    case "object": {
      if (!schema.properties || depth > 3) {
        return <JsonSubEdit label={label} required={required} desc={schema.description} value={value} onChange={onChange} />;
      }
      const obj = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
      return (
        <fieldset className="rounded-md border border-line p-2.5">
          <Row label={label} required={required} desc={schema.description}>
            <span />
          </Row>
          <div className="mt-1 space-y-2.5">
            {Object.entries(schema.properties).map(([k, sub]) => (
              <SchemaField
                key={k}
                name={k}
                schema={sub}
                value={obj[k]}
                required={(schema.required ?? []).includes(k)}
                depth={depth + 1}
                onChange={(v) => onChange({ ...obj, [k]: v })}
              />
            ))}
          </div>
        </fieldset>
      );
    }
    default:
      return <JsonSubEdit label={label} required={required} desc={schema.description} value={value} onChange={onChange} />;
  }
}

/** 字段行：label + 控件 + 描述 */
function Row({
  label,
  required,
  desc,
  children,
}: {
  label: string;
  required: boolean;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label">
        <span className="font-mono">{label}</span>
        {required ? (
          <span className="ml-1 text-err">*</span>
        ) : (
          <span className="ml-1 text-[11px] text-inksoft/60">可选</span>
        )}
      </label>
      {children}
      {desc && (
        <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-inksoft/80">{desc}</div>
      )}
    </div>
  );
}

/** 复杂子结构：JSON 文本编辑（带校验提示） */
function JsonSubEdit({
  label,
  required,
  desc,
  value,
  onChange,
}: {
  label: string;
  required: boolean;
  desc?: string;
  value: unknown;
  onChange: OnChange;
}) {
  const text = value === undefined || value === null ? "" : JSON.stringify(value);
  return (
    <Row label={`${label}（JSON）`} required={required} desc={desc}>
      <textarea
        className="field font-mono !text-[12px]"
        rows={3}
        placeholder='例如：{"nested": 1} 或 [1, 2]'
        value={text}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return onChange(undefined);
          try {
            onChange(JSON.parse(raw));
          } catch {
            /* 输入中：暂时保留旧值，运行前会整体校验 */
          }
        }}
      />
    </Row>
  );
}

/** 表单整体：渲染 schema.properties 的全部字段 */
export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: FormValue;
  onChange: (v: FormValue) => void;
}) {
  if (resolveType(schema) !== "object" || !schema.properties) {
    return (
      <div className="text-[12px] leading-relaxed text-inksoft">
        该工具的入参不是对象类型，请使用「JSON 模式」编辑。
      </div>
    );
  }
  const required = new Set(schema.required ?? []);
  return (
    <div className="space-y-3">
      {Object.entries(schema.properties).map(([k, sub]) => (
        <SchemaField
          key={k}
          name={k}
          schema={sub}
          value={value[k]}
          required={required.has(k)}
          depth={0}
          onChange={(v) => onChange({ ...value, [k]: v })}
        />
      ))}
      {Object.keys(schema.properties).length === 0 && (
        <div className="text-[12px] text-inksoft">该工具无需参数，直接点击「运行」即可。</div>
      )}
    </div>
  );
}
