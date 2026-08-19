import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useStudio } from "../state/store";

const ICONS = {
  success: <CheckCircle2 size={15} className="text-ok" />,
  error: <XCircle size={15} className="text-err" />,
  warning: <AlertTriangle size={15} className="text-warn" />,
  info: <Info size={15} className="text-accenthi" />,
};

export default function Toasts() {
  const { toasts, dismissToast } = useStudio();
  return (
    <div className="fixed bottom-10 right-4 z-50 flex flex-col gap-2 items-end" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-2.5 bg-panel border border-bdr rounded-lg shadow-xl px-3.5 py-2.5 text-[12.5px] df-fade max-w-96"
        >
          {ICONS[t.kind]}
          <span className="text-ink">{t.text}</span>
          <button onClick={() => dismissToast(t.id)} aria-label="Dismiss notification" className="text-mute hover:text-ink ml-1">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
