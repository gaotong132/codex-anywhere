// Touch/drag movement scrolls a menu; it must not paint a hovered option.
export function isHoverPointer(event: Pick<PointerEvent, 'pointerType' | 'buttons'>) {
  return (event.pointerType === 'mouse' || event.pointerType === 'pen') && event.buttons === 0;
}
