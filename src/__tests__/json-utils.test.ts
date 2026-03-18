import { describe, it, expect } from "vitest";
import { flattenJSON, unflattenJSON } from "../json-utils.js";

describe("flattenJSON", () => {
  it("flattens simple object", () => {
    expect(flattenJSON({ save: "Save", cancel: "Cancel" })).toEqual({
      save: "Save",
      cancel: "Cancel",
    });
  });

  it("flattens nested objects with dot-paths", () => {
    expect(
      flattenJSON({ pagination: { next: "Next", previous: "Previous" } })
    ).toEqual({
      "pagination.next": "Next",
      "pagination.previous": "Previous",
    });
  });

  it("handles deeply nested objects", () => {
    expect(flattenJSON({ a: { b: { c: "deep" } } })).toEqual({
      "a.b.c": "deep",
    });
  });

  it("returns empty object for empty input", () => {
    expect(flattenJSON({})).toEqual({});
  });
});

describe("unflattenJSON", () => {
  it("unflattens flat keys", () => {
    expect(unflattenJSON({ save: "Save" })).toEqual({ save: "Save" });
  });

  it("unflattens dot-paths to nested objects", () => {
    expect(
      unflattenJSON({
        "pagination.next": "Next",
        "pagination.previous": "Previous",
      })
    ).toEqual({ pagination: { next: "Next", previous: "Previous" } });
  });

  it("preserves key order from input", () => {
    const input = { z: "Z", a: "A", m: "M" };
    const keys = Object.keys(unflattenJSON(input));
    expect(keys).toEqual(["z", "a", "m"]);
  });

  it("roundtrips with flattenJSON", () => {
    const original = {
      save: "Save",
      pagination: { next: "Next", page: "Page {{current}} of {{total}}" },
      validation: { required: "Required" },
    };
    expect(unflattenJSON(flattenJSON(original))).toEqual(original);
  });
});
