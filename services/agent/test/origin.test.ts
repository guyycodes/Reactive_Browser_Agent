import { describe, it, expect } from "vitest";
import { isOriginAllowed } from "../src/events/stream.js";

const ALLOW = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:6080",
  "http://127.0.0.1:6080",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

describe("isOriginAllowed — allowlist behavior", () => {
  it("accepts an exact match", () => {
    expect(isOriginAllowed("http://localhost:3000", ALLOW)).toBe(true);
  });

  it("accepts the 127.0.0.1 variant (VS Code port forwarding)", () => {
    expect(isOriginAllowed("http://127.0.0.1:3000", ALLOW)).toBe(true);
  });

  it("accepts the noVNC viewer origin", () => {
    expect(isOriginAllowed("http://localhost:6080", ALLOW)).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:6080", ALLOW)).toBe(true);
  });

  it("normalises uppercase host", () => {
    expect(isOriginAllowed("http://LOCALHOST:3000", ALLOW)).toBe(true);
  });

  it("ignores a trailing slash", () => {
    expect(isOriginAllowed("http://localhost:3000/", ALLOW)).toBe(true);
  });

  it("rejects a missing origin", () => {
    expect(isOriginAllowed(undefined, ALLOW)).toBe(false);
    expect(isOriginAllowed(null, ALLOW)).toBe(false);
    expect(isOriginAllowed("", ALLOW)).toBe(false);
  });

  it("rejects a wrong port", () => {
    expect(isOriginAllowed("http://localhost:9999", ALLOW)).toBe(false);
  });

  it("rejects a wrong scheme (http vs https)", () => {
    expect(isOriginAllowed("https://localhost:3000", ALLOW)).toBe(false);
  });

  it("rejects an unrelated origin", () => {
    expect(isOriginAllowed("http://evil.example.com", ALLOW)).toBe(false);
  });

  it("rejects a file:// or null origin", () => {
    expect(isOriginAllowed("null", ALLOW)).toBe(false);
    expect(isOriginAllowed("file://", ALLOW)).toBe(false);
  });
});
