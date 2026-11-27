import { useEffect, useId, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { MAX_UI_FONT_SIZE, MIN_UI_FONT_SIZE } from "../utils/useFontSizePreference";

type Props = {
  label: string;
  value: number;
  defaultSize: number;
  onChange: (size: number) => void;
  align?: "left" | "right";
};

export default function FontSizeControl({ label, value, defaultSize, onChange, align = "left" }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={root} className="font-size-control relative shrink-0" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <button type="button" aria-label={`${label} font size`} title={`${label} font size (${value} px)`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)} className="rounded border border-bdr text-mute hover:text-soft">
        <svg className="font-size-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 20 7 5l5 15M4 14h6M15 7h7M18.5 3.5v7M15 17h7" />
        </svg>
      </button>
      {open && <div id={id} role="group" aria-label={`Adjust ${label.toLowerCase()} font size`} className={`font-size-control-popup absolute top-full mt-1 z-50 flex items-center gap-1 rounded border border-bdr bg-panel p-1 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
        <button type="button" aria-label={`Decrease ${label.toLowerCase()} font size`} title="Decrease font size" disabled={value <= MIN_UI_FONT_SIZE} onClick={() => onChange(value - 1)}><Minus aria-hidden="true" /></button>
        <output className="whitespace-nowrap tabular-nums" aria-live="polite" aria-label={`Current ${label.toLowerCase()} font size`}>{value} px</output>
        <button type="button" aria-label={`Increase ${label.toLowerCase()} font size`} title="Increase font size" disabled={value >= MAX_UI_FONT_SIZE} onClick={() => onChange(value + 1)}><Plus aria-hidden="true" /></button>
        <button type="button" aria-label={`Reset ${label.toLowerCase()} font size to ${defaultSize} pixels`} title={`Reset to default (${defaultSize} px)`} onClick={() => onChange(defaultSize)}><RotateCcw aria-hidden="true" /></button>
      </div>}
    </div>
  );
}
