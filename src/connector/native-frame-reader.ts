// Copy fragmented frames once instead of repeatedly concatenating the entire
// partial payload. Reject the length before allocating the body.
export class NativeFrameReader {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | null = null;
  private bodyBytes = 0;
  constructor(private maxBytes: number) {}
  clear() { this.headerBytes = 0; this.body = null; this.bodyBytes = 0; }
  push(chunk: Buffer, consume: (body: Buffer) => boolean) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count; offset += count;
        if (this.headerBytes < 4) return;
        const length = this.header.readUInt32LE(0);
        if (!length || length > this.maxBytes) { this.clear(); throw new Error('invalid frame size'); }
        this.body = Buffer.allocUnsafe(length);
      }
      const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + count);
      this.bodyBytes += count; offset += count;
      if (this.bodyBytes === this.body.length) {
        const body = this.body;
        this.clear();
        if (!consume(body)) return;
      }
    }
  }
}
