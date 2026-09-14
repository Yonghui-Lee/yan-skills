import test from "node:test";
import assert from "node:assert/strict";
import { isReportStale, DEFAULT_STALE_HOURS } from "../scripts/is-agentic.mjs";

// 回归(真实项目复盘):is-agentic 的报告 API 没有强制重扫能力,同一域名调用
// 相隔 11 天仍拿到同一份旧报告。一次实测缓存分 76、浏览器手动 Rescan 后
// 变成 98,中间 22 分的差距全部来自"没有重新测量",不是真的退步——判断
// 一个站是否需要重新测量,要先核对 scanned_at,不能只看分数高低。
test("isReportStale: 阈值内的报告不算陈旧", () => {
  const now = new Date("2026-09-13T12:00:00Z");
  const scannedAt = new Date("2026-09-13T11:00:00Z").toISOString();
  assert.equal(isReportStale(scannedAt, now), false);
});

test("isReportStale: 超过默认阈值(24小时)判陈旧", () => {
  const now = new Date("2026-09-13T12:00:00Z");
  const scannedAt = new Date("2026-09-10T12:00:00Z").toISOString();
  assert.equal(isReportStale(scannedAt, now), true);
});

test("isReportStale: 恰好卡在阈值边界不判陈旧(大于才算,不是大于等于)", () => {
  const now = new Date("2026-09-13T12:00:00Z");
  const scannedAt = new Date("2026-09-12T12:00:00Z").toISOString(); // 恰好 24 小时前
  assert.equal(isReportStale(scannedAt, now), false);
});

test("isReportStale: 支持自定义阈值", () => {
  const now = new Date("2026-09-13T12:00:00Z");
  const scannedAt = new Date("2026-09-13T08:00:00Z").toISOString(); // 4 小时前
  assert.equal(isReportStale(scannedAt, now, 2), true);
  assert.equal(isReportStale(scannedAt, now, 6), false);
});

test("isReportStale: 解析不出时间时不误报陈旧", () => {
  const now = new Date("2026-09-13T12:00:00Z");
  assert.equal(isReportStale("not-a-date", now), false);
  assert.equal(isReportStale(undefined, now), false);
  assert.equal(isReportStale(null, now), false);
});

test("DEFAULT_STALE_HOURS 是 24", () => {
  assert.equal(DEFAULT_STALE_HOURS, 24);
});
