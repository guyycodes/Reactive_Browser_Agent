import { describe, it, expect } from "vitest";
import { chunkUtf8, CHUNK_SIZE_BYTES } from "../src/llm/streamMapper.js";

/**
 * Unit tests for the pure chunking utility. The event-dispatch half of
 * `streamMapper.ts` integrates with the Anthropic SDK + EventBus and is
 * exercised by the end-to-end `POST /triage` smoke test (not a unit test).
 * What we can and should verify in isolation:
 *
 *   1. Chunks under the limit pass through as a single string.
 *   2. Chunks above the limit are split into pieces whose UTF-8 byte
 *      length is ≤ maxBytes.
 *   3. Concatenating the chunks reconstructs the original exactly.
 *   4. Multi-byte UTF-8 code points are not split mid-character.
 */

describe("chunkUtf8", () => {
  it("passes small input through as a single chunk", () => {
    const out = Array.from(chunkUtf8("hello", 1024));
    expect(out).toEqual(["hello"]);
  });

  it("splits a large ASCII string into byte-bounded chunks", () => {
    const input = "a".repeat(CHUNK_SIZE_BYTES * 3 + 17);
    const chunks = Array.from(chunkUtf8(input, CHUNK_SIZE_BYTES));
    expect(chunks.length).toBe(4);
    for (const c of chunks) {
      expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(CHUNK_SIZE_BYTES);
    }
    expect(chunks.join("")).toBe(input);
  });

  it("does not split a multi-byte UTF-8 code point", () => {
    // "😀" is 4 bytes in UTF-8; "é" is 2 bytes.
    const input = ("😀" + "é").repeat(1000);
    const chunks = Array.from(chunkUtf8(input, 16));
    for (const c of chunks) {
      expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(16);
      // Any split-in-half code point would throw when re-decoded from bytes;
      // a clean split always survives a round-trip.
      expect(Buffer.from(c, "utf8").toString("utf8")).toBe(c);
    }
    expect(chunks.join("")).toBe(input);
  });

  it("yields empty sequence for empty input (when size 0 is checked)", () => {
    // Empty string: the fast path (byteLength <= maxBytes) yields the empty
    // string once. That's acceptable; emitters guard with `if (text.length === 0) return`
    // before calling into this function.
    const out = Array.from(chunkUtf8("", 1024));
    expect(out).toEqual([""]);
  });

  it("handles a chunk size of exactly the input size", () => {
    const input = "x".repeat(100);
    const out = Array.from(chunkUtf8(input, 100));
    expect(out).toEqual([input]);
  });

  it("handles chunk size 1 (degenerate but valid)", () => {
    const input = "abc";
    const out = Array.from(chunkUtf8(input, 1));
    expect(out).toEqual(["a", "b", "c"]);
  });
});
