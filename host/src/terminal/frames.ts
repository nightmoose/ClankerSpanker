/** Binary frames between Node and pty-bridge.py */

export const TYPE_IN = 1;
export const TYPE_OUT = 2;
export const TYPE_RESIZE = 3;
export const TYPE_EXIT = 4;
export const TYPE_ERR = 5;

export const MAX_PAYLOAD = 1_000_000;

export interface Frame {
  type: number;
  payload: Buffer;
}

export function encodeFrame(type: number, payload: Buffer): Buffer {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error("frame too large");
  }
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function encodeResize(rows: number, cols: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(Math.max(1, Math.min(512, rows)), 0);
  payload.writeUInt16BE(Math.max(1, Math.min(512, cols)), 2);
  return encodeFrame(TYPE_RESIZE, payload);
}

export function encodeInput(data: Buffer | string): Buffer {
  return encodeFrame(TYPE_IN, typeof data === "string" ? Buffer.from(data, "utf8") : data);
}

export class FrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];
    while (this.buf.length >= 5) {
      const type = this.buf.readUInt8(0);
      const length = this.buf.readUInt32BE(1);
      if (length > MAX_PAYLOAD) {
        this.buf = Buffer.alloc(0);
        throw new Error("frame too large");
      }
      if (this.buf.length < 5 + length) break;
      const payload = this.buf.subarray(5, 5 + length);
      this.buf = this.buf.subarray(5 + length);
      out.push({ type, payload: Buffer.from(payload) });
    }
    return out;
  }
}
