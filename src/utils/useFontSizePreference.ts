import { useCallback, useState } from "react";

export const MIN_UI_FONT_SIZE = 3;
export const MAX_UI_FONT_SIZE = 18;

export function useFontSizePreference(key: string, defaultSize: number) {
  const [size, setSize] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(key));
      return Number.isInteger(stored) && stored >= MIN_UI_FONT_SIZE && stored <= MAX_UI_FONT_SIZE ? stored : defaultSize;
    } catch { return defaultSize; }
  });
  const update = useCallback((value: number) => {
    if (!Number.isFinite(value)) return;
    const next = Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(value)));
    setSize(next);
    try { localStorage.setItem(key, String(next)); }
    catch { /* Keep the preference for this session when storage is unavailable. */ }
  }, [key]);
  return [size, update] as const;
}
