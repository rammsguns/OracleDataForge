import { type ReactNode, useEffect, useRef } from "react";
import { Loader2, X } from "lucide-react";
import type { MenuItem } from "../types";

export function Btn({
  children,
  onClick,
  variant = "ghost",
  title,
  disabled,
  className = "",
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "outline" | "danger" | "toolbar";
  title?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-md px-2.5 h-7 text-[12px] font-medium transition-colors select-none disabled:opacity-40 disabled:pointer-events-none";
  // SQL Developer's code-editor toolbar: square icon-only buttons carrying no chrome of their
  // own until pointed at, so a row of them reads as one strip rather than a row of pills. The
  // label lives in `title`, which also becomes the aria-label below — never omit it here.
  const toolbarBase =
    "inline-flex items-center justify-center rounded w-7 h-7 shrink-0 border border-transparent text-soft transition-colors select-none hover:bg-accentdim hover:text-accenthi hover:border-accent/40 disabled:opacity-40 disabled:pointer-events-none";
  const styles = {
    primary: "bg-accent text-white hover:bg-accenthi shadow-sm",
    ghost: "text-soft hover:text-ink hover:bg-panel3",
    outline: "border border-bdr text-soft hover:text-ink hover:border-accent/60 hover:bg-accentdim",
    danger: "bg-err/10 text-err border border-err/30 hover:bg-err/20",
    toolbar: "",
  };
  return (
    <button
      type="button"
      className={`${variant === "toolbar" ? toolbarBase : `${base} ${styles[variant]}`} ${className}`}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** Hairline rule between groups of toolbar buttons, as SQL Developer separates its own. */
export function ToolbarSep() {
  return <span aria-hidden className="w-px h-5 bg-bdr mx-0.5 shrink-0" />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "err" | "accent" }) {
  const tones = {
    neutral: "bg-panel3 text-soft",
    ok: "bg-ok/12 text-ok",
    warn: "bg-warn/12 text-warn",
    err: "bg-err/12 text-err",
    accent: "bg-accentdim text-accenthi",
  };
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide ${tones[tone]}`}>{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-soft text-[12px]" role="status" aria-live="polite">
      <Loader2 size={14} className="df-spin text-accent" />
      {label ?? "Working…"}
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-center p-8 df-fade">
      <div className="text-mute [&>svg]:w-8 [&>svg]:h-8">{icon}</div>
      <div className="text-[13px] font-semibold text-soft">{title}</div>
      {hint && <div className="text-[12px] text-mute max-w-72">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // mount-only: re-running this on renders would re-focus the dialog and steal
  // focus from inputs mid-typing (onClose changes identity on every parent render)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px] df-fade" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="bg-panel border border-bdr rounded-xl shadow-2xl max-h-[85vh] flex flex-col outline-none"
        style={{ width, maxWidth: "94vw" }}
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-bdrsoft shrink-0">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog" className="text-mute hover:text-ink p-1 rounded">
            <X size={15} />
          </button>
        </div>
        <div className="overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <div className="text-[11px] font-semibold text-soft mb-1 uppercase tracking-wider">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-mute mt-1">{hint}</div>}
    </label>
  );
}

export const inputCls =
  "w-full h-8 px-2.5 rounded-md bg-panel2 border border-bdr text-[12.5px] text-ink placeholder:text-mute focus:border-accent focus:outline-none transition-colors";

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(x, vw - 210);
  const top = Math.min(y, vh - items.length * 30 - 20);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-48 bg-panel border border-bdr rounded-lg shadow-2xl py-1 df-fade"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it.divider ? (
          <div key={i} className="h-px bg-bdrsoft my-1" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-panel3 transition-colors ${it.danger ? "text-err" : "text-ink"}`}
            onClick={() => {
              it.action?.();
              onClose();
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  );
}
