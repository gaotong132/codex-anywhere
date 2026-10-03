import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { ConversationScroll } from './conversation-scroll';

export function useConversationScroll(
  rootRef: RefObject<HTMLDivElement | null>, contentRef: RefObject<HTMLDivElement | null>,
  scope: string, bootstrapPending: boolean,
) {
  const controllerRef = useRef<ConversationScroll | null>(null);
  const controller = controllerRef.current ??= new ConversationScroll();
  useLayoutEffect(() => { controller.reset(); }, [controller, scope]);
  // Correct React updates before paint; ResizeObserver covers deferred images,
  // diagrams and composer resizing without a second, stale animation-frame jump.
  useLayoutEffect(() => {
    if (rootRef.current) controller.restore(rootRef.current);
  });
  useEffect(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content) return undefined;
    const pauseOnWheel = (event: WheelEvent) => { if (event.deltaY < 0) controller.pause(root); };
    const pauseOnKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) controller.pause(root);
    };
    let touchY: number | null = null;
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
    const touchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (next == null || touchY == null) return;
      if (next - touchY > 2) controller.pause(root);
      touchY = next;
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') controller.suspend(root);
      else controller.resume(root);
    };
    const pageHide = () => controller.suspend(root);
    const pageShow = () => { if (document.visibilityState === 'visible') controller.resume(root); };
    const observer = typeof ResizeObserver === 'undefined' ? null
      : new ResizeObserver(() => controller.restore(root));
    observer?.observe(root);
    observer?.observe(content);
    root.addEventListener('wheel', pauseOnWheel, { passive: true });
    root.addEventListener('keydown', pauseOnKey);
    root.addEventListener('touchstart', touchStart, { passive: true });
    root.addEventListener('touchmove', touchMove, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    visibility();
    return () => {
      observer?.disconnect();
      root.removeEventListener('wheel', pauseOnWheel);
      root.removeEventListener('keydown', pauseOnKey);
      root.removeEventListener('touchstart', touchStart);
      root.removeEventListener('touchmove', touchMove);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
    };
  }, [bootstrapPending, contentRef, controller, rootRef, scope]);
  return controller;
}
