import { describe, it, expect } from "vitest";
import { hashValue, buildCacheEntries, computeDiff } from "../cache.js";

describe("hashValue", () => {
  it("returns consistent 8-char hash", () => {
    const h = hashValue("Save");
    expect(h).toHaveLength(8);
    expect(hashValue("Save")).toBe(h);
  });

  it("returns different hash for different values", () => {
    expect(hashValue("Save")).not.toBe(hashValue("Cancel"));
  });
});

describe("buildCacheEntries", () => {
  it("builds hash map from flat entries", () => {
    const entries = { save: "Save", cancel: "Cancel" };
    const cache = buildCacheEntries(entries);
    expect(cache.save).toBe(hashValue("Save"));
    expect(cache.cancel).toBe(hashValue("Cancel"));
  });
});

describe("computeDiff", () => {
  it("marks all keys as missing when no target exists", () => {
    const source = { save: "Save", cancel: "Cancel" };
    const diff = computeDiff(source, {}, {});
    expect(diff.missing).toEqual(["save", "cancel"]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it("marks key as unchanged when target exists and cache matches", () => {
    const source = { save: "Save" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };
    const diff = computeDiff(source, target, cache);
    expect(diff.unchanged).toEqual(["save"]);
    expect(diff.missing).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("marks key as changed when cache hash differs", () => {
    const source = { save: "Save changes" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };
    const diff = computeDiff(source, target, cache);
    expect(diff.changed).toEqual(["save"]);
    expect(diff.unchanged).toEqual([]);
  });

  it("marks key as missing when not in target even if in cache", () => {
    const source = { save: "Save" };
    const target = {};
    const cache = { save: hashValue("Save") };
    const diff = computeDiff(source, target, cache);
    expect(diff.missing).toEqual(["save"]);
  });
});
