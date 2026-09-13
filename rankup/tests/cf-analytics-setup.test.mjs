import test from "node:test";
import assert from "node:assert/strict";
import { extractCfBeaconTokens, diagnoseCfWebAnalytics } from "../scripts/cf-analytics-setup.mjs";

const TOKEN_A = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TOKEN_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

test("extractCfBeaconTokens 从静态属性(单引号或双引号)里都能抠出 token", () => {
  const single = `<script data-cf-beacon='{"token":"${TOKEN_A}"}'></script>`;
  const double = `<script data-cf-beacon="{&quot;token&quot;: &quot;${TOKEN_A}&quot;}"></script>`;
  assert.deepEqual(extractCfBeaconTokens(single), [TOKEN_A]);
  assert.deepEqual(extractCfBeaconTokens(double), [TOKEN_A]);
});

// 回归(2026-09-13,真实项目复盘):早期版本只认 `data-cf-beacon="..."` 的静态属性
// 赋值,认不出统一延迟加载器里常见的 `setAttribute('data-cf-beacon', '{"token":...}')`
// 动态注入写法——两者字符串里都有 data-cf-beacon,但一个后面跟 `=`,一个跟函数调用的
// 逗号,旧正则匹配不上,会对这类项目误判"线上找不到任何手嵌 beacon"。
test("extractCfBeaconTokens 认得 setAttribute() 动态注入的 token", () => {
  const html = `<script>s.setAttribute('data-cf-beacon', '{"token":"${TOKEN_A}"}');document.head.appendChild(s)</script>`;
  assert.deepEqual(extractCfBeaconTokens(html), [TOKEN_A]);
});

test("extractCfBeaconTokens 认得 setAttribute() 用双引号包裹参数的写法", () => {
  const html = `s.setAttribute("data-cf-beacon", "{\\"token\\": \\"${TOKEN_A}\\"}")`;
  assert.deepEqual(extractCfBeaconTokens(html), [TOKEN_A]);
});

// 判据不关心具体语法,只认"data-cf-beacon 出现之后到下一个语法收尾符号之间
// 有没有一个 32 位十六进制串"——字符串拼接拼出来的 token 同样能抠到。
test("extractCfBeaconTokens 认得字符串拼接里的 token", () => {
  const html = `el.setAttribute('data-cf-beacon', '{"token":"' + "${TOKEN_A}" + '"}')`;
  assert.deepEqual(extractCfBeaconTokens(html), [TOKEN_A]);
});

test("extractCfBeaconTokens 找不到属性时返回空数组，不是 null/undefined", () => {
  assert.deepEqual(extractCfBeaconTokens("<html><body>no beacon here</body></html>"), []);
  assert.deepEqual(extractCfBeaconTokens(""), []);
});

test("extractCfBeaconTokens 窗口内没有十六进制 token 时记原始片段而不是静默丢弃", () => {
  const broken = `<script data-cf-beacon='{not a real token here}'></script>`;
  const tokens = extractCfBeaconTokens(broken);
  assert.equal(tokens.length, 1);
  assert.match(tokens[0], /^UNPARSED:/);
});

test("extractCfBeaconTokens 两次注入(重复)时返回两个 token", () => {
  const html = `
    <script data-cf-beacon='{"token":"${TOKEN_A}"}'></script>
    <script data-cf-beacon='{"token":"${TOKEN_B}"}'></script>
  `;
  assert.deepEqual(extractCfBeaconTokens(html), [TOKEN_A, TOKEN_B]);
});

test("extractCfBeaconTokens 对 token 大小写归一化为小写", () => {
  const html = `<script data-cf-beacon='{"token":"${TOKEN_A.toUpperCase()}"}'></script>`;
  assert.deepEqual(extractCfBeaconTokens(html), [TOKEN_A.toLowerCase()]);
});

test("diagnoseCfWebAnalytics: token 一致、无重复、有 beacon 时判 ok", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: TOKEN_A,
    autoInstall: false,
    tokensInHtml: [TOKEN_A],
  });
  assert.equal(diag.ok, true);
  assert.equal(diag.tokenMismatch, false);
  assert.equal(diag.duplicateInjection, false);
  assert.equal(diag.noBeaconFound, false);
});

test("diagnoseCfWebAnalytics: token 比对大小写不敏感", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: TOKEN_A.toUpperCase(),
    autoInstall: false,
    tokensInHtml: [TOKEN_A],
  });
  assert.equal(diag.tokenMismatch, false);
});

// 回归:代码里手嵌的 token 与后台 site_token 对不上——beacon 照样 200 加载,
// 数据流进了别的 site,这是真实项目复盘出来的坑,不能被 count>0 掩盖。
test("diagnoseCfWebAnalytics: token 不一致时判 tokenMismatch", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: TOKEN_A,
    autoInstall: false,
    tokensInHtml: [TOKEN_B],
  });
  assert.equal(diag.ok, false);
  assert.equal(diag.tokenMismatch, true);
});

// 回归:auto_install=true 时边缘已经在自动注入,代码里又手嵌了一份,
// 两条注入路径同时打点,GraphQL count>0 反而把这个问题掩盖掉。
test("diagnoseCfWebAnalytics: auto_install 开着且线上仍有手嵌 beacon 时判 duplicateInjection", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: TOKEN_A,
    autoInstall: true,
    tokensInHtml: [TOKEN_A],
  });
  assert.equal(diag.ok, false);
  assert.equal(diag.duplicateInjection, true);
});

test("diagnoseCfWebAnalytics: auto_install=false 且线上没有任何 beacon 时判 noBeaconFound", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: TOKEN_A,
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
    tokensInHtml: [TOKEN_A],
  });
  assert.equal(diag.tokenKnown, false);
  assert.equal(diag.tokenMismatch, false);
  // API 取不到 site_token 这件事本身不该判定接入失败——只是没法自动比对 token 一项。
  assert.equal(diag.ok, true);
});

test("diagnoseCfWebAnalytics: UNPARSED 片段不计入有效 token 比对", () => {
  const diag = diagnoseCfWebAnalytics({
    siteToken: TOKEN_A,
    autoInstall: false,
    tokensInHtml: ["UNPARSED:garbage"],
  });
  // 解析不出来的片段既不能证明 token 一致,也不能证明 beacon 缺失——
  // 它证明的是"抓到了但读不出内容",noBeaconFound 只在数组本身为空时才成立。
  assert.equal(diag.noBeaconFound, false);
  assert.equal(diag.validTokens.length, 0);
});
