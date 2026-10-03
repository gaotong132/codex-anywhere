type Anchor = { id: string; offset: number };

/** Own scroll corrections so layout changes cannot masquerade as user scrolling. */
export class ConversationScroll {
  following = true;
  forceBottom = false;
  private anchors: Anchor[] = [];
  private lastTop: number | null = null;

  reset() {
    this.following = true;
    this.forceBottom = false;
    this.anchors = [];
    this.lastTop = null;
  }

  capture(root: HTMLElement) {
    const top = root.getBoundingClientRect().top;
    this.anchors = [];
    for (const node of root.querySelectorAll<HTMLElement>('[data-timeline-id]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= top) continue;
      this.anchors.push({ id: node.dataset.timelineId!, offset: rect.top - top });
      if (this.anchors.length === 3) break;
    }
    this.lastTop = root.scrollTop;
  }

  pause(root: HTMLElement) {
    this.following = false;
    this.forceBottom = false;
    this.capture(root);
  }

  onScroll(root: HTMLElement) {
    if (this.lastTop !== null && Math.abs(root.scrollTop - this.lastTop) < 1) return false;
    // Resume only at the bottom, not while reading within the old 180px zone.
    this.following = root.scrollHeight - root.scrollTop - root.clientHeight <= 2;
    this.forceBottom = false;
    this.capture(root);
    return true;
  }

  restore(root: HTMLElement) {
    if (this.forceBottom || this.following) {
      this.forceBottom = false;
      this.following = true;
      root.scrollTop = root.scrollHeight;
    } else {
      const nodes = new Map([...root.querySelectorAll<HTMLElement>('[data-timeline-id]')]
        .map((node) => [node.dataset.timelineId, node]));
      const top = root.getBoundingClientRect().top;
      for (const anchor of this.anchors) {
        const node = nodes.get(anchor.id);
        if (!node) continue;
        const delta = node.getBoundingClientRect().top - top - anchor.offset;
        if (Math.abs(delta) >= 1) root.scrollTop += delta;
        break;
      }
    }
    this.capture(root);
  }
}
