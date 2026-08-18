import { describe, expect, it } from "vitest";
import {
  compact,
  dayKey,
  dayRange,
  durationMs,
  fmtMs,
  fmtWhen,
  getPath,
  pct,
  percentile,
  shortDay,
  shortId,
  unwrapSensitive,
  usd,
} from "../src/lib/util";

describe("getPath", () => {
  it("reads nested paths", () => {
    expect(getPath({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
  });
  it("returns undefined for missing segments and non-objects", () => {
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
    expect(getPath(undefined, "a")).toBeUndefined();
    expect(getPath("string", "length")).toBeUndefined();
  });
});

describe("unwrapSensitive", () => {
  it("unwraps $sensitive wrappers", () => {
    expect(unwrapSensitive({ $sensitive: "string", labels: ["pii"], value: "x" })).toBe("x");
  });
  it("passes plain values through", () => {
    expect(unwrapSensitive("plain")).toBe("plain");
    expect(unwrapSensitive(42)).toBe(42);
    expect(unwrapSensitive(null)).toBeNull();
    expect(unwrapSensitive({ value: "not-wrapped" })).toEqual({ value: "not-wrapped" });
  });
});

describe("durationMs", () => {
  it("computes end - start", () => {
    expect(durationMs("2026-08-01T00:00:00Z", "2026-08-01T00:00:05Z")).toBe(5000);
  });
  it("is null when either side is missing", () => {
    expect(durationMs(null, "2026-08-01T00:00:00Z")).toBeNull();
    expect(durationMs("2026-08-01T00:00:00Z", null)).toBeNull();
  });
  it("rejects negative durations (clock skew) and unparseable dates", () => {
    expect(durationMs("2026-08-01T00:00:05Z", "2026-08-01T00:00:00Z")).toBeNull();
    expect(durationMs("garbage", "2026-08-01T00:00:00Z")).toBeNull();
  });
});

describe("percentile", () => {
  it("is null on empty input", () => {
    expect(percentile([], 50)).toBeNull();
  });
  it("returns the single element for any p", () => {
    expect(percentile([7], 0)).toBe(7);
    expect(percentile([7], 100)).toBe(7);
  });
  it("picks nearest-rank percentiles from a sorted array", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 10)).toBe(10);
  });
});

describe("day buckets", () => {
  it("dayKey slices the UTC day", () => {
    expect(dayKey("2026-08-03T23:59:59Z")).toBe("2026-08-03");
  });
  it("dayRange is inclusive and crosses month boundaries", () => {
    expect(dayRange("2026-07-30T12:00:00Z", "2026-08-02T01:00:00Z")).toEqual(["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
  });
  it("dayRange of a single day returns that day", () => {
    expect(dayRange("2026-08-03T00:00:00Z", "2026-08-03T23:00:00Z")).toEqual(["2026-08-03"]);
  });
  it("shortDay formats in UTC", () => {
    expect(shortDay("2026-08-03")).toBe("Aug 3");
  });
});

describe("formatters fail closed", () => {
  it("usd", () => {
    expect(usd(NaN)).toBe("—");
    expect(usd(Infinity)).toBe("—");
    expect(usd(0)).toBe("$0");
    expect(usd(0.0123)).toBe("$0.0123");
    expect(usd(1.5)).toBe("$1.50");
    expect(usd(1234.56)).toBe("$1,235");
  });
  it("compact", () => {
    expect(compact(NaN)).toBe("—");
    expect(compact(999)).toBe("999");
    expect(compact(12_345)).toBe("12.3K");
    expect(compact(2_500_000)).toBe("2.5M");
    expect(compact(3_100_000_000)).toBe("3.1B");
  });
  it("pct", () => {
    expect(pct(null)).toBe("—");
    expect(pct(NaN)).toBe("—");
    expect(pct(0)).toBe("0%");
    expect(pct(0.4567)).toBe("45.7%");
    expect(pct(1)).toBe("100%");
  });
  it("fmtMs", () => {
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(NaN)).toBe("—");
    expect(fmtMs(500)).toBe("500ms");
    expect(fmtMs(1500)).toBe("1.5s");
    expect(fmtMs(90_000)).toBe("1.5m");
  });
  it("fmtWhen renders UTC and tolerates garbage", () => {
    expect(fmtWhen(null)).toBe("—");
    expect(fmtWhen("garbage")).toBe("—");
    expect(fmtWhen("2026-08-03T14:05:00Z")).toContain("Aug 3");
  });
});

describe("shortId", () => {
  it("keeps short ids intact and ellipsizes long ones", () => {
    expect(shortId("abc123")).toBe("abc123");
    expect(shortId("sp_0123456789abcdef")).toBe("sp_012…cdef");
  });
});
