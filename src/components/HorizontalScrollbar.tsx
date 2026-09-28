import { useEffect, useRef, type RefObject } from "react";

/** A persistent bottom scrollbar synchronized with a scrollable viewport. */
export default function HorizontalScrollbar({ target, contentKey }: {
  target: RefObject<HTMLElement>;
  contentKey?: unknown;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = target.current;
    const scrollbar = bar.current;
    const spacer = track.current;
    if (!viewport || !scrollbar || !spacer) return;
    const measure = () => {
      spacer.style.width = `${viewport.scrollWidth}px`;
      scrollbar.scrollLeft = viewport.scrollLeft;
    };
    const sync = () => { scrollbar.scrollLeft = viewport.scrollLeft; };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    viewport.addEventListener("scroll", sync);
    measure();
    return () => { observer.disconnect(); viewport.removeEventListener("scroll", sync); };
  }, [target, contentKey]);
  return (
    <div ref={bar} tabIndex={0} aria-label="Horizontal scroll" className="horizontal-scrollbar shrink-0 min-w-0 border-t border-bdrsoft"
      onScroll={() => {
        if (target.current && bar.current && target.current.scrollLeft !== bar.current.scrollLeft)
          target.current.scrollLeft = bar.current.scrollLeft;
      }}>
      <div ref={track} style={{ height: 1 }} />
    </div>
  );
}
