import { useEffect, useState, type RefObject } from "react";

/** Always-visible horizontal navigation, independent of OS overlay scrollbars. */
export default function HorizontalScrollbar({ target, contentKey }: {
  target: RefObject<HTMLElement>;
  contentKey?: unknown;
}) {
  const [maximum, setMaximum] = useState(0);
  const [position, setPosition] = useState(0);
  useEffect(() => {
    const viewport = target.current;
    if (!viewport) return;
    const measure = () => {
      setMaximum(Math.max(0, viewport.scrollWidth - viewport.clientWidth));
      setPosition(viewport.scrollLeft);
    };
    const sync = () => setPosition(viewport.scrollLeft);
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    viewport.addEventListener("scroll", sync);
    measure();
    return () => { observer.disconnect(); viewport.removeEventListener("scroll", sync); };
  }, [target, contentKey]);
  return (
    <div className="horizontal-scrollbar shrink-0 min-w-0 border-t border-bdrsoft">
      <input type="range" aria-label="Horizontal scroll" min={0} max={maximum} step={1}
        value={Math.min(position, maximum)} disabled={maximum === 0}
        onChange={(e) => {
          const next = Number(e.currentTarget.value);
          if (target.current) target.current.scrollLeft = next;
          setPosition(next);
        }} />
    </div>
  );
}
