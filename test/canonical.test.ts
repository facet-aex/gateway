import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";

describe("canonical JSON used for runner proof", () => {
  it("sorts Unicode keys by JavaScript code unit order", () => {
    expect(canonicalJson({ ä: 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"ä":1}');
  });
});
