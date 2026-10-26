import { describe, expect, it } from "vitest";
import { whitespaceParts } from "./fix-preview";

describe("whitespaceParts", () => {
  it("shows tabs and trailing spaces", () => {
    expect(whitespaceParts("a\tb  ")).toEqual([
      { text: "a", whitespace: false },
      { text: "→\t", whitespace: true },
      { text: "b", whitespace: false },
      { text: "··", whitespace: true },
    ]);
    expect(whitespaceParts("\tx")).toEqual([
      { text: "→\t", whitespace: true },
      { text: "x", whitespace: false },
    ]);
  });

  it("leaves inner spaces and plain text alone", () => {
    expect(whitespaceParts("a b")).toEqual([{ text: "a b", whitespace: false }]);
    expect(whitespaceParts("")).toEqual([]);
    expect(whitespaceParts(" \t ")).toEqual([{ text: "·→\t·", whitespace: true }]);
  });
});
