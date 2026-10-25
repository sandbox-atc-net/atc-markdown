import { describe, expect, it } from "vitest";
import { decodeLabel, toUnicodeHost } from "./punycode";

describe("punycode", () => {
  it("decodes known labels", () => {
    expect(decodeLabel("bcher-kva")).toBe("bücher");
    expect(decodeLabel("pple-43d")).toBe("аpple"); // Cyrillic "а" + "pple"
    expect(decodeLabel("mnchen-3ya")).toBe("münchen");
    expect(decodeLabel("wgv71a119e")).toBe("日本語");
  });

  it("decodes whole hosts and leaves plain labels alone", () => {
    expect(toUnicodeHost("xn--pple-43d.com")).toBe("аpple.com");
    expect(toUnicodeHost("www.example.com")).toBe("www.example.com");
  });

  it("keeps invalid labels as they are", () => {
    expect(decodeLabel("!!!")).toBeUndefined();
    expect(toUnicodeHost("xn--!!!.com")).toBe("xn--!!!.com");
  });
});
