type Anchor = { id: string; offset: number; part?: { index: number; signature: string } };
const READING_PARTS = 'p, pre, li, figure, table, .message-image-state';
const signature = (node: HTMLElement) => `${node.tagName}:${(node.textContent || '').slice(0, 160)}`;

/** Own scroll corrections so layout changes cannot masquerade as user scrolling. */
export class ConversationScroll {
  following = true;
  forceBottom = false;
  private anchors: Anchor[] = [];
  private lastTop: number | null = null;
  private suspended = false;

  reset() {
    this.following = true;
    this.forceBottom = false;
    this.anchors = [];
    this.lastTop = null;
  }

  capture(root: HTMLElement) {
    if (this.suspended || root.clientHeight <= 0) return;
    const top = root.getBoundingClientRect().top;
    this.anchors = [];
    for (const node of root.querySelectorAll<HTMLElement>('[data-timeline-id]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= top) continue;
      // A single reply can contain an image above the currently read paragraph.
      // Its outer top stays fixed when that image loads; anchor the paragraph.
      const parts = [...(node.querySelectorAll?.<HTMLElement>(READING_PARTS) || [])];
      const index = parts.findIndex((part) => part.getBoundingClientRect().bottom > top);
      if (index >= 0) this.anchors.push({
        id: node.dataset.timelineId!, offset: parts[index].getBoundingClientRect().top - top,
        part: { index, signature: signature(parts[index]) },
      });
      this.anchors.push({ id: node.dataset.timelineId!, offset: rect.top - top });
      if (this.anchors.length >= 3) break;
    }
    this.lastTop = root.scrollTop;
  }

  pause(root: HTMLElement) {
    this.following = false;
    this.forceBottom = false;
    this.capture(root);
  }

  onScroll(root: HTMLElement) {
    if (this.suspended || root.clientHeight <= 0) return false;
    if (this.lastTop !== null && Math.abs(root.scrollTop - this.lastTop) < 1) return false;
    // Resume only at the bottom, not while reading within the old 180px zone.
    this.following = root.scrollHeight - root.scrollTop - root.clientHeight <= 2;
    this.forceBottom = false;
    this.capture(root);
    return true;
  }

  restore(root: HTMLElement) {
    if (this.suspended || root.clientHeight <= 0) return;
    if (this.forceBottom || this.following) {
      this.forceBottom = false;
      this.following = true;
      root.scrollTop = root.scrollHeight;
    } else {
      const nodes = new Map([...root.querySelectorAll<HTMLElement>('[data-timeline-id]')]
        .map((node) => [node.dataset.timelineId, node]));
      const top = root.getBoundingClientRect().top;
      for (const anchor of this.anchors) {
        let node = nodes.get(anchor.id);
        if (!node) continue;
        if (anchor.part) {
          const parts = [...node.querySelectorAll<HTMLElement>(READING_PARTS)];
          const candidate = parts[anchor.part.index];
          node = candidate && signature(candidate) === anchor.part.signature ? candidate
            : parts.find((part) => signature(part) === anchor.part!.signature);
          if (!node) continue;
        }
        const delta = node.getBoundingClientRect().top - top - anchor.offset;
        if (Math.abs(delta) >= 1) root.scrollTop += delta;
        break;
      }
    }
    this.capture(root);
  }

  suspend(root: HTMLElement) {
    this.capture(root);
    this.suspended = true;
  }

  resume(root: HTMLElement) {
    this.suspended = false;
    this.restore(root);
  }
}
