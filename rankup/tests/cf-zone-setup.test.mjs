import test from "node:test";
import assert from "node:assert/strict";
import { buildWwwToApexRedirectRule, isAlwaysUseHttpsOn } from "../scripts/cf-zone-setup.mjs";

test("buildWwwToApexRedirectRule direction=apex: 匹配 www、跳到裸域", () => {
  const rules = buildWwwToApexRedirectRule("example.com", "apex");
  assert.equal(rules.length, 1);
  const rule = rules[0];
  assert.equal(rule.expression, `(http.host eq "www.example.com")`);
  assert.equal(
    rule.action_parameters.from_value.target_url.expression,
    `concat("https://example.com", http.request.uri.path)`,
  );
  assert.equal(rule.action_parameters.from_value.preserve_query_string, true);
  assert.equal(rule.action_parameters.from_value.status_code, 301);
});

test("buildWwwToApexRedirectRule direction=www: 方向对调，匹配裸域、跳到 www", () => {
  const rules = buildWwwToApexRedirectRule("example.com", "www");
  assert.equal(rules.length, 1);
  const rule = rules[0];
  assert.equal(rule.expression, `(http.host eq "example.com")`);
  assert.equal(
    rule.action_parameters.from_value.target_url.expression,
    `concat("https://www.example.com", http.request.uri.path)`,
  );
  assert.equal(rule.action_parameters.from_value.preserve_query_string, true);
  assert.equal(rule.action_parameters.from_value.status_code, 301);
});

// 非法 direction 必须抛出清晰的 Error，不能静默返回错误结果——方向是意图声明，
// 猜错方向会把裸域和 www 谁重定向到谁弄反，属于高代价的隐性 bug。
test("buildWwwToApexRedirectRule 对非法 direction 抛错", () => {
  assert.throws(() => buildWwwToApexRedirectRule("example.com", "other"), /direction/);
  assert.throws(() => buildWwwToApexRedirectRule("example.com", undefined), /direction/);
  assert.throws(() => buildWwwToApexRedirectRule("example.com", ""), /direction/);
});

test("isAlwaysUseHttpsOn 对 CF API 的 setting 对象形状判定正确", () => {
  assert.equal(isAlwaysUseHttpsOn({ value: "on" }), true);
  assert.equal(isAlwaysUseHttpsOn({ value: "off" }), false);
});

test("isAlwaysUseHttpsOn 对裸字符串形状判定正确", () => {
  assert.equal(isAlwaysUseHttpsOn("on"), true);
  assert.equal(isAlwaysUseHttpsOn("off"), false);
});

// 畸形输入不该让只读展示逻辑抛错中断——一律判 false。
test("isAlwaysUseHttpsOn 对畸形输入返回 false，不抛错", () => {
  assert.equal(isAlwaysUseHttpsOn(null), false);
  assert.equal(isAlwaysUseHttpsOn(undefined), false);
  assert.equal(isAlwaysUseHttpsOn({}), false);
  assert.equal(isAlwaysUseHttpsOn(42), false);
  assert.equal(isAlwaysUseHttpsOn([]), false);
});
