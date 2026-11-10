/**
 * 通用 UI 原语：模态框、下拉菜单、状态点、空态占位。
 * 保持零第三方 UI 依赖，风格与整体设计一致。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
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
}

/** 通用模态框 */
export function Modal({ open, title, onClose, children, footer, width = 520 }: ModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
      <div
        className="card max-h-[85vh] w-full overflow-hidden shadow-2xl"
        style={{ maxWidth: width }}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-[14px] font-semibold">{title}</div>
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink"
            onClick={onClose}
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[62vh] overflow-y-auto px-4 py-3">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line bg-panel2 px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
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
          className={`card absolute top-full z-40 mt-1 min-w-[180px] overflow-hidden py-1 shadow-xl ${
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
