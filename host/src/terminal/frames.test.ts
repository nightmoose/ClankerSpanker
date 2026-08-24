import { describe, expect, it } from "vitest";
import {
  FrameParser,
  TYPE_ERR,
  TYPE_EXIT,
  TYPE_IN,
  TYPE_OUT,
  TYPE_RESIZE,
  encodeFrame,
  encodeInput,
  encodeResize,
} from "./frames.js";

describe("terminal frames", () => {
  it("round-trips a payload", () => {
    const framed = encodeInput("hello");
    const parser = new FrameParser();
    const frames = parser.push(framed);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe(TYPE_IN);
    expect(frames[0]!.payload.toString("utf8")).toBe("hello");
  });

  it("reassembles split headers and bodies", () => {
    const a = encodeFrame(TYPE_OUT, Buffer.from("abc"));
    const b = encodeFrame(TYPE_EXIT, Buffer.from([0, 0, 0, 7]));
    const blob = Buffer.concat([a, b]);
    const parser = new FrameParser();
    const first = parser.push(blob.subarray(0, 3));
    expect(first).toEqual([]);
    const rest = parser.push(blob.subarray(3));
    expect(rest.map((f) => f.type)).toEqual([TYPE_OUT, TYPE_EXIT]);
    expect(rest[0]!.payload.toString("utf8")).toBe("abc");
  });

  it("encodes resize as rows then cols", () => {
    const framed = encodeResize(24, 80);
    const parser = new FrameParser();
    const [frame] = parser.push(framed);
    expect(frame!.type).toBe(TYPE_RESIZE);
    expect(frame!.payload.readUInt16BE(0)).toBe(24);
    expect(frame!.payload.readUInt16BE(2)).toBe(80);
  });

  it("rejects oversized frames", () => {
    const parser = new FrameParser();
    const header = Buffer.alloc(5);
    header.writeUInt8(TYPE_ERR, 0);
    header.writeUInt32BE(2_000_000, 1);
    expect(() => parser.push(header)).toThrow(/too large/);
  });
});
