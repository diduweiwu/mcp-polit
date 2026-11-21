/**
 * 通用 UI 原语：模态框、下拉菜单、悬浮提示、状态点、空态占位。
 * 保持零第三方 UI 依赖，风格与整体设计一致。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search, X } from "lucide-react";
import type { ConnStatus } from "../types";

/** 点击元素外部时触发回调（用于下拉/弹窗关闭） */
export function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onOutside]);
  return ref;
}

/** 模态框属性 */
interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部按钮区 */
  footer?: ReactNode;
  width?: number;
  /**
   * 固定高度（px，可选）：设置后弹窗整体高度恒定，正文占满剩余空间（flex-1）内部滚动，
   * 适合内容长短不一的多页签弹窗（如设置页），切换页签时弹窗尺寸不跳变；
   * 不传时保持原有行为——高度随内容自适应，正文以 max-h 限高滚动。
   */
  height?: number;
  /**
   * 是否允许 Esc 关闭（默认 true）。嵌套弹窗场景（如管理列表内再弹删除确认）
   * 内层打开期间外层应传 false，避免按一次 Esc 把两层弹窗一起关闭；
   * 点击遮罩关闭不受影响——内层遮罩盖住外层，点击天然只落在最上层。
   */
  escClose?: boolean;
  /**
   * 内容滚动容器 ref（可选）：父组件可借此操作滚动位置，
   * 典型用途是校验错误出现在顶部时把内容滚回去，保证反馈可见。
   */
  bodyRef?: React.RefObject<HTMLDivElement | null>;
}

/** 通用模态框：带淡入/缩放入出场动画、Esc 关闭、点击遮罩关闭 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 520,
  height,
  escClose = true,
  bodyRef,
}: ModalProps) {
  /** 退出动画播放中标记（动画结束后才真正回调 onClose 卸载） */
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);

  /** 请求关闭：先播 150ms 退出动画，再交给父组件卸载 */
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(() => {
      closingRef.current = false;
      setClosing(false);
      onClose();
    }, 150);
  }, [onClose]);

  /* open 状态复位时重置内部状态 */
  useEffect(() => {
    if (!open) {
      closingRef.current = false;
      setClosing(false);
    }
  }, [open]);

  /* Esc 关闭（escClose=false 时跳过，供嵌套弹窗的外层禁用） */
  useEffect(() => {
    if (!open || !escClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, escClose, requestClose]);

  if (!open) return null;
  /* Portal 到 body：避免渲染在 Allotment 分栏子树内时被 pane 的绘制层盖住 */
  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] ${
        closing ? "anim-fade-out" : "anim-fade-in"
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className={`card flex max-h-[85vh] w-full flex-col overflow-hidden shadow-2xl ${
          closing ? "anim-zoom-out" : "anim-zoom-in"
        }`}
        style={{ maxWidth: width, ...(height ? { height } : {}) }}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-[14px] font-semibold">{title}</div>
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink"
            onClick={requestClose}
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>
        {/* selectable：弹窗正文（说明文字等）允许拖选复制；输入框本就可选中。
            固定高度时正文 flex-1 占满剩余空间内部滚动；否则沿用 max-h 自适应限高 */}
        <div
          ref={bodyRef}
          className={`selectable overflow-y-auto px-4 py-3 ${height ? "min-h-0 flex-1" : "max-h-[62vh]"}`}
        >
          {children}
        </div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line bg-panel2 px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 简单确认框属性 */
interface ConfirmProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 简单确认框（删除等操作用） */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "删除",
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={420}
      footer={
        <>
          <button className="btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm}>
            {confirmText}
          </button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-inksoft">{message}</p>
    </Modal>
  );
}

/** 连接状态点：灰=未连接，天蓝呼吸=连接中，绿=已连接，红=错误 */
export function StatusDot({ status }: { status: ConnStatus }) {
  const cls =
    status === "connected"
      ? "bg-ok"
      : status === "connecting"
        ? "bg-primary animate-pulse"
        : status === "error"
          ? "bg-err"
          : "bg-inksoft/40";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

/** 面板空态占位 */
export function EmptyState({
  icon,
  text,
  children,
}: {
  icon?: ReactNode;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      {icon && <div className="text-inksoft/50">{icon}</div>}
      <div className="max-w-[260px] text-[13px] leading-relaxed text-inksoft">{text}</div>
      {children}
    </div>
  );
}

/** 下拉菜单容器（带点击外部关闭） */
export function Dropdown({
  trigger,
  children,
  align = "left",
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(() => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      {trigger(open, () => setOpen((v) => !v))}
      {open && (
        <div
          className={`card anim-pop-in absolute top-full z-40 mt-1 min-w-[180px] overflow-hidden py-1 shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** 下拉菜单项 */
export function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-panel2 ${
        danger ? "text-err" : "text-ink"
      }`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

/** 悬浮提示属性 */
interface TooltipProps {
  /** 提示内容（较长时自动换行） */
  content: string;
  /** 触发元素（悬浮在其上时显示气泡） */
  children: ReactNode;
  /** 弹出方位：bottom 在触发元素下方 / top 在上方；默认 bottom */
  side?: "bottom" | "top";
  /** 水平对齐：start 左对齐 / end 右对齐（触发元素靠右缘时防气泡溢出窗口）；默认 start */
  align?: "start" | "end";
  /** 置 true 时禁用悬浮提示（如点击已弹出内容相同的面板时避免重复展示）；默认 false */
  disabled?: boolean;
}

/**
 * 悬浮提示气泡：替代原生 title 属性的自定义提示。
 *
 * 背景：macOS 的 WKWebView（Tauri）不渲染原生 title tooltip（WebKit 已知限制，
 * WebView2 正常），导致 title 写的信息全平台表现不一致，故用本组件统一实现。
 *
 * 实现：气泡通过 Portal 渲染到 body 并用 fixed 定位——Allotment 分栏容器有
 * overflow-hidden，absolute 气泡溢出栏宽会被裁剪（弹窗/右键菜单 Portal 的同一原因）。
 * 显示时按触发元素位置计算坐标，再用气泡自身 offsetWidth/offsetHeight（布局尺寸，
 * 不受入场 scale 动画影响）做视口边缘收拢，保证长文本不被窗口边缘截断。
 *
 * 交互：悬浮约 250ms 后显示（快速滑过不闪现），移开后约 120ms 隐藏（缓冲气泡
 * 与触发元素之间的间隙）；页面滚动/窗口缩放时气泡跟随触发元素重新定位
 * （fixed 定位不随文档滚动），触发元素滚出视口则隐藏；
 * 气泡为纯展示（pointer-events-none），不阻挡下方点击。
 *
 * 使用示例：
 * ```tsx
 * <Tooltip content="推送：导出当前配置并 commit + push">
 *   <button><Upload size={13} /></button>
 * </Tooltip>
 * ```
 */
export function Tooltip({
  content,
  children,
  side = "bottom",
  align = "start",
  disabled = false,
}: TooltipProps) {
  const [show, setShow] = useState(false);
  /** 气泡 fixed 定位坐标（显示后由布局 effect 按气泡实际尺寸精修） */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  /** 延迟显示定时器 */
  const showTimer = useRef<number | undefined>(undefined);
  /** 延迟隐藏定时器 */
  const hideTimer = useRef<number | undefined>(undefined);
  /** 触发元素包装层（测量锚点） */
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  /** 气泡元素（测量实际宽高用） */
  const bubbleRef = useRef<HTMLSpanElement | null>(null);

  /** 清理两个定时器 */
  const clearTimers = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  };

  /* 卸载时清理定时器，防止对已卸载组件 setState */
  useEffect(() => clearTimers, []);

  /**
   * 依据触发元素与气泡实际尺寸计算气泡坐标，并收拢进视口边缘。
   * 气泡未挂载时（显示前）宽高按最大宽度估算，挂载后的布局 effect 会精修。
   */
  const placeBubble = (): { top: number; left: number } | null => {
    const el = wrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const w = bubbleRef.current?.offsetWidth ?? 320;
    const h = bubbleRef.current?.offsetHeight ?? 40;
    let left = align === "end" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const top = side === "bottom" ? r.bottom + 5 : r.top - h - 5;
    return { top, left };
  };

  /* 显示后按气泡实际尺寸精修位置（挂载前布局 effect 先于绘制执行，无跳位） */
  useLayoutEffect(() => {
    if (!show) return;
    const p = placeBubble();
    if (p && (p.top !== pos?.top || p.left !== pos?.left)) setPos(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, side, align]);

  /* 气泡显示期间页面滚动/窗口缩放时跟随触发元素重新定位（fixed 定位不随文档滚动）；
     触发元素滚出视口则隐藏，避免气泡悬空指向不可见内容 */
  useEffect(() => {
    if (!show) return;
    const reposition = () => {
      const el = wrapRef.current;
      if (!el) return setShow(false);
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
        setShow(false);
        return;
      }
      setPos(placeBubble());
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, side, align]);

  /** 悬浮进入：清除待执行的隐藏后延迟显示（先按估算坐标放置，挂载后精修） */
  const handleEnter = () => {
    clearTimers();
    showTimer.current = window.setTimeout(() => {
      setPos(placeBubble());
      setShow(true);
    }, 250);
  };

  /** 悬浮离开：延迟隐藏（给滑过间隙留缓冲） */
  const handleLeave = () => {
    clearTimers();
    hideTimer.current = window.setTimeout(() => setShow(false), 120);
  };

  return (
    <span className="relative inline-flex" ref={wrapRef} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {show && !disabled && pos &&
        createPortal(
          <span
            role="tooltip"
            ref={bubbleRef}
            style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 45 }}
            className="anim-pop-in pointer-events-none w-max max-w-[320px] whitespace-pre-wrap rounded-md border border-line bg-panel px-2.5 py-1.5 text-[11.5px] leading-relaxed text-ink shadow-lg"
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** 可搜索下拉选择器的选项 */
export interface SearchSelectOption {
  /** 选项值（选中后回调给 onSelect） */
  value: string;
  /** 选项显示文本（同时参与关键字过滤） */
  label: string;
}

/** 可搜索下拉选择器属性 */
interface SearchSelectProps {
  /** 未选中时触发按钮上显示的占位文本 */
  placeholder: string;
  /** 选项列表（为空时触发按钮禁用） */
  options: SearchSelectOption[];
  /** 选中某个选项后的回调（value 为选项值） */
  onSelect: (value: string) => void;
  /** 触发按钮宽度（px），下拉面板宽度取 max(width, 220)；默认 220 */
  width?: number;
  /** 面板对齐方向：靠窗口/栏右缘的触发器传 right，防止面板溢出；默认 left */
  align?: "left" | "right";
}

/**
 * 可搜索下拉选择器：替代原生 <select> 的项目风格下拉，支持关键字过滤。
 *
 * 交互：点击触发按钮展开面板（顶部搜索框自动聚焦），输入即时过滤选项
 * （匹配 label/value，不区分大小写），点击选项回调并关闭；Esc / 点击
 * 外部关闭并清空过滤词。
 *
 * 使用示例：
 * ```tsx
 * <SearchSelect
 *   placeholder="选择 Case 带入…"
 *   options={[{ value: "a", label: "case-a" }]}
 *   onSelect={(v) => applyCase(v)}
 * />
 * ```
 */
export function SearchSelect({
  placeholder,
  options,
  onSelect,
  width = 220,
  align = "left",
}: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  /** 过滤关键字 */
  const [kw, setKw] = useState("");
  const ref = useClickOutside<HTMLDivElement>(() => setOpen(false));

  /** 关闭面板并清空过滤词（下次打开是完整列表） */
  const close = () => {
    setOpen(false);
    setKw("");
  };

  /** 按关键字过滤选项（匹配显示文本或值，不区分大小写） */
  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase();
    if (!k) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(k) || o.value.toLowerCase().includes(k),
    );
  }, [options, kw]);

  return (
    <div className="relative" ref={ref}>
      {/* 触发按钮：复用 .field 外观（与原 <select> 视觉一致）+ 旋转箭头 */}
      <button
        className="field flex h-7 items-center justify-between gap-1.5 !py-0 text-left text-[12px] disabled:cursor-default disabled:opacity-60"
        style={{ width }}
        disabled={options.length === 0}
        title={placeholder}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate text-inksoft">{placeholder}</span>
        <ChevronDown
          size={12}
          className={`shrink-0 text-inksoft transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          className={`card anim-pop-in absolute top-full z-40 mt-1 overflow-hidden shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
          style={{ width: Math.max(width, 220) }}
        >
          {/* 搜索框：打开即聚焦，直接输入即可过滤 */}
          <div className="relative border-b border-line p-1.5">
            <Search
              size={12}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-inksoft"
            />
            <input
              className="field h-6 !py-0 pl-7 text-[12px]"
              autoFocus
              placeholder="输入关键字过滤…"
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
              }}
            />
          </div>
          {/* 选项列表 */}
          <div className="max-h-[220px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-inksoft">无匹配的选项</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.value}
                  className="flex w-full items-center gap-2 truncate px-3 py-1.5 text-left font-mono text-[12px] text-ink hover:bg-panel2"
                  title={o.label}
                  onClick={() => {
                    onSelect(o.value);
                    close();
                  }}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
