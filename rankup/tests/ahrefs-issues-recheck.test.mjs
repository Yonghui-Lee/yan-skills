import test from "node:test";
import assert from "node:assert/strict";
import {
  readIssuesFromExport,
  classifyIssueCheckType,
  judgeRedirectCanonical,
  judgeMetaDescriptionLength,
  judgeResourceStatus,
} from "../scripts/ahrefs-issues-recheck.mjs";

test("readIssuesFromExport: 接受单个 issue 对象（不是数组）", () => {
  const result = readIssuesFromExport({ category: "x", name: "y", allCapturedUrls: ["https://example.com/1"] });
  assert.equal(result.length, 1);
  assert.equal(result[0].urls[0], "https://example.com/1");
});

test("readIssuesFromExport: 接受 { issues: [...] } 数组形状", () => {
  const result = readIssuesFromExport({
    issues: [
      { category: "a", name: "1", allCapturedUrls: ["https://example.com/1"] },
      { category: "b", name: "2", exampleUrls: ["https://example.com/2"] },
    ],
  });
  assert.equal(result.length, 2);
  assert.equal(result[1].urls[0], "https://example.com/2");
});

test("readIssuesFromExport: 按优先级取字段——allCapturedUrls 优先于 exampleUrls", () => {
  const result = readIssuesFromExport({
    category: "x",
    name: "y",
    allCapturedUrls: ["https://example.com/full"],
    exampleUrls: ["https://example.com/example"],
  });
  assert.deepEqual(result[0].urls, ["https://example.com/full"]);
});

test("readIssuesFromExport: 没有直接的 URL 字段时从 rows 逐行抠 URL", () => {
  const result = readIssuesFromExport({
    category: "x",
    name: "y",
    rows: [
      ["20", "html", "https://example.com/play/1", "0", "200"],
      ["no url in this row"],
    ],
  });
  assert.deepEqual(result[0].urls, ["https://example.com/play/1"]);
});

test("readIssuesFromExport: URL 去重", () => {
  const result = readIssuesFromExport({
    category: "x",
    name: "y",
    allCapturedUrls: ["https://example.com/1", "https://example.com/1"],
  });
  assert.equal(result[0].urls.length, 1);
});

test("classifyIssueCheckType: 协议/host/sitemap 类关键词归 redirect-canonical", () => {
  assert.equal(
    classifyIssueCheckType({ category: "Indexability", name: "从 HTTP 指向 HTTPS 的规范链接" }),
    "redirect-canonical",
  );
  assert.equal(classifyIssueCheckType({ category: "Sitemaps", name: "多个网站地图中的页面" }), "redirect-canonical");
});

test("classifyIssueCheckType: 元描述类归 meta-description", () => {
  assert.equal(classifyIssueCheckType({ category: "Content", name: "元描述过短" }), "meta-description");
});

test("classifyIssueCheckType: JS/资源错误类归 resource-status", () => {
  assert.equal(classifyIssueCheckType({ category: "JavaScript", name: "页面存在JavaScript错误" }), "resource-status");
});

test("classifyIssueCheckType: 内链/孤岛/速度类归 not-checkable-via-http", () => {
  assert.equal(
    classifyIssueCheckType({ category: "Links", name: "孤岛页面（没有导入内链）" }),
    "not-checkable-via-http",
  );
  assert.equal(
    classifyIssueCheckType({ category: "Performance", name: "Slow server response for AI crawlers" }),
    "not-checkable-via-http",
  );
});

test("classifyIssueCheckType: 匹配不上任何规则时归 generic-http，不瞎猜", () => {
  assert.equal(classifyIssueCheckType({ category: "???", name: "unrecognized issue type" }), "generic-http");
});

// 回归:一批候选归类判据顺序很重要——"仅一个 dofollow 内链，不可索引"这类
// 真实项目里本质常是重定向缺失,不是内链计数问题,redirect-canonical 规则
// 必须比 not-checkable-via-http 先匹配。
test("classifyIssueCheckType: 同时含重定向与内链关键词时按规则顺序优先 redirect-canonical", () => {
  assert.equal(
    classifyIssueCheckType({ category: "Links", name: "仅一个dofollow内链，不可索引（www变体）" }),
    "redirect-canonical",
  );
});

test("judgeRedirectCanonical: 直接 2xx 判仍存在", () => {
  const r = judgeRedirectCanonical({ initialStatus: 200, hops: 0 });
  assert.equal(r.verdict, "still-present");
});

test("judgeRedirectCanonical: 单跳 3xx 判已修复", () => {
  const r = judgeRedirectCanonical({ initialStatus: 301, hops: 1 });
  assert.equal(r.verdict, "resolved");
});

test("judgeRedirectCanonical: 多跳判不确定，需要人工核对", () => {
  const r = judgeRedirectCanonical({ initialStatus: 301, hops: 2 });
  assert.equal(r.verdict, "unknown");
});

test("judgeMetaDescriptionLength: 短于阈值判仍存在", () => {
  assert.equal(judgeMetaDescriptionLength(50, 70).verdict, "still-present");
});

test("judgeMetaDescriptionLength: 达到阈值判已修复", () => {
  assert.equal(judgeMetaDescriptionLength(150, 70).verdict, "resolved");
});

test("judgeMetaDescriptionLength: 找不到 description 时判不确定，不是 0", () => {
  assert.equal(judgeMetaDescriptionLength(null, 70).verdict, "unknown");
});

// 回归:资源现在 404 不能直接判定"问题已修复"或"问题仍存在"——
// 需要另外确认有没有页面还在引用它,单次请求这个资源本身回答不了这个问题。
test("judgeResourceStatus: 404 判不确定，不是直接判已修复或仍存在", () => {
  assert.equal(judgeResourceStatus(404).verdict, "unknown");
});

test("judgeResourceStatus: 2xx 判已修复", () => {
  assert.equal(judgeResourceStatus(200).verdict, "resolved");
});
