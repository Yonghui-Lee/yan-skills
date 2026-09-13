import test from "node:test";
import assert from "node:assert/strict";
import { classifyBeacons, formatBeaconTable } from "../scripts/analytics-beacon-check.mjs";

const ALL_LOADED = [
  "https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX",
  "https://www.clarity.ms/tag/xzmumryb8r",
  "https://analytics.ahrefs.com/analytics.js",
  "https://static.cloudflareinsights.com/beacon.min.js/v123",
  "https://example.com/logo.png",
  "https://example.com/assets/index-abc123.js",
];

test("classifyBeacons: 四个平台全部加载时都判 loaded=true", () => {
  const c = classifyBeacons(ALL_LOADED);
  assert.equal(c.ga4.loaded, true);
  assert.equal(c.clarity.loaded, true);
  assert.equal(c.ahrefs.loaded, true);
  assert.equal(c.cfWebAnalytics.loaded, true);
});

test("classifyBeacons: 没有任何分析脚本时全部判 loaded=false", () => {
  const c = classifyBeacons(["https://example.com/logo.png", "https://example.com/app.js"]);
  assert.equal(c.ga4.loaded, false);
  assert.equal(c.clarity.loaded, false);
  assert.equal(c.ahrefs.loaded, false);
  assert.equal(c.cfWebAnalytics.loaded, false);
});

test("classifyBeacons: 只加载了部分平台时逐项区分，不是全有或全无", () => {
  const c = classifyBeacons([
    "https://www.googletagmanager.com/gtag/js?id=G-XXXX",
    "https://example.com/logo.png",
  ]);
  assert.equal(c.ga4.loaded, true);
  assert.equal(c.clarity.loaded, false);
  assert.equal(c.ahrefs.loaded, false);
  assert.equal(c.cfWebAnalytics.loaded, false);
});

test("classifyBeacons: 命中的具体 URL 会被记下来，不只是布尔值", () => {
  const c = classifyBeacons(ALL_LOADED);
  assert.deepEqual(c.ga4.matchedUrls, ["https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"]);
});

test("classifyBeacons: 对空数组/undefined 不抛错，全部判未加载", () => {
  assert.equal(classifyBeacons([]).ga4.loaded, false);
  assert.equal(classifyBeacons(undefined).ga4.loaded, false);
  assert.equal(classifyBeacons(null).ga4.loaded, false);
});

test("classifyBeacons: 重复出现的同一个 URL 只算一次匹配", () => {
  const c = classifyBeacons([
    "https://www.googletagmanager.com/gtag/js?id=G-XXXX",
    "https://www.googletagmanager.com/gtag/js?id=G-XXXX",
  ]);
  assert.equal(c.ga4.matchedUrls.length, 1);
});

test("formatBeaconTable: 每个平台一行，命中显示 URL、未命中显示占位文案", () => {
  const c = classifyBeacons(["https://www.googletagmanager.com/gtag/js?id=G-XXXX"]);
  const table = formatBeaconTable(c);
  const lines = table.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines.find((l) => l.includes("GA4")), /✅.*GA4.*googletagmanager/);
  assert.match(lines.find((l) => l.includes("Clarity")), /❌.*Microsoft Clarity.*未加载/);
});
