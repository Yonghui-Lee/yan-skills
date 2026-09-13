import test from "node:test";
import assert from "node:assert/strict";
import { extractCfBeaconTokens, diagnoseCfWebAnalytics } from "../scripts/cf-analytics-setup.mjs";

test("extractCfBeaconTokens 从单引号或双引号属性里都能抠出 token", () => {
  const single = `<script data-cf-beacon='{"token":"abc123"}'></script>`;
  const double = `<script data-cf-beacon="{&quot;token&quot;: &quot;abc123&quot;}"></script>`;
  assert.deepEqual(extractCfBeaconTokens(single), ["abc123"]);
  assert.deepEqual(extractCfBeaconTokens(double), ["abc123"]);
});

test("extractCfBeaconTokens 找不到属性时返回空数组，不是 null/undefined", () => {
  assert.deepEqual(extractCfBeaconTokens("<html><body>no beacon here</body></html>"), []);
  assert.deepEqual(extractCfBeaconTokens(""), []);
});

test("extractCfBeaconTokens 解析失败时记原始片段而不是静默丢弃", () => {
  const broken = `<script data-cf-beacon='{not valid json'></script>`;
  const tokens = extractCfBeaconTokens(broken);
  assert.equal(tokens.length, 1);
  assert.match(tokens[0], /^UNPARSED:/);
});

test("extractCfBeaconTokens 两次注入(重复)时返回两个 token", () => {
  const html = `
    <script data-cf-beacon='{"token":"aaa"}'></script>
    <script data-cf-beacon='{"token":"bbb"}'></script>
  `;
  assert.deepEqual(extractCfBeaconTokens(html), ["aaa", "bbb"]);
});

test("diagnoseCfWebAnalytics: token 一致、无重复、有 beacon 时判 ok", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: "abc123",
    autoInstall: false,
    tokensInHtml: ["abc123"],
  });
  assert.equal(diag.ok, true);
  assert.equal(diag.tokenMismatch, false);
  assert.equal(diag.duplicateInjection, false);
  assert.equal(diag.noBeaconFound, false);
});

// 回归:代码里手嵌的 token 与后台 site_token 对不上——beacon 照样 200 加载,
// 数据流进了别的 site,这是真实项目复盘出来的坑,不能被 count>0 掩盖。
test("diagnoseCfWebAnalytics: token 不一致时判 tokenMismatch", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: "real-token",
    autoInstall: false,
    tokensInHtml: ["wrong-token"],
  });
  assert.equal(diag.ok, false);
  assert.equal(diag.tokenMismatch, true);
});

// 回归:auto_install=true 时边缘已经在自动注入,代码里又手嵌了一份,
// 两条注入路径同时打点,GraphQL count>0 反而把这个问题掩盖掉。
test("diagnoseCfWebAnalytics: auto_install 开着且线上仍有手嵌 beacon 时判 duplicateInjection", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: "abc123",
    autoInstall: true,
    tokensInHtml: ["abc123"],
  });
  assert.equal(diag.ok, false);
  assert.equal(diag.duplicateInjection, true);
});

test("diagnoseCfWebAnalytics: auto_install=false 且线上没有任何 beacon 时判 noBeaconFound", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: "abc123",
    autoInstall: false,
    tokensInHtml: [],
  });
  assert.equal(diag.ok, false);
  assert.equal(diag.noBeaconFound, true);
});

test("diagnoseCfWebAnalytics: API 没返回 site_token 时不误判 mismatch，只标 tokenKnown=false", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: null,
    autoInstall: false,
    tokensInHtml: ["abc123"],
  });
  assert.equal(diag.tokenKnown, false);
  assert.equal(diag.tokenMismatch, false);
  // API 取不到 site_token 这件事本身不该判定接入失败——只是没法自动比对 token 一项。
  assert.equal(diag.ok, true);
});

test("diagnoseCfWebAnalytics: UNPARSED 片段不计入有效 token 比对", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: "abc123",
    autoInstall: false,
    tokensInHtml: ["UNPARSED:garbage"],
  });
  // 解析不出来的片段既不能证明 token 一致,也不能证明 beacon 缺失——
  // 它证明的是"抓到了但读不出内容",noBeaconFound 只在数组本身为空时才成立。
  assert.equal(diag.noBeaconFound, false);
  assert.equal(diag.validTokens.length, 0);
});
