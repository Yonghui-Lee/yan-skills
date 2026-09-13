import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWwwToApexRedirectRule,
  isAlwaysUseHttpsOn,
  MANAGED_REDIRECT_REF,
  isManagedRedirectRule,
  mergeManagedRedirectRule,
  conflictsWithManagedRedirect,
  isManagedRuleUpToDate,
  planApplyRedirects,
  doApplyRedirects,
  RedirectConflictError,
} from "../scripts/cf-zone-setup.mjs";

// doApplyRedirects 读认证走 cfAuthHeaders(),没有真实凭据会在模块内部
// process.exit(2)——测试从不发真实网络请求(fetch 全程被下面的假实现接管),
// 这里只是让凭据解析这一步能过,值本身是假的,不会被用来打真实请求。
process.env.CLOUDFLARE_API_TOKEN = "test-fake-token-not-real";

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

// ── 回归:apply-redirects 曾经用只有一条规则的数组整表 PUT,会把 zone 上其余
// 既有重定向规则静默删掉(独立验收发现)。以下覆盖修复后的读-改-写合并逻辑。
// ──────────────────────────────────────────────────────────────────────

test("buildWwwToApexRedirectRule 生成的规则带 MANAGED_REDIRECT_REF 标记", () => {
  const [rule] = buildWwwToApexRedirectRule("example.com", "apex");
  assert.equal(rule.ref, MANAGED_REDIRECT_REF);
  assert.equal(isManagedRedirectRule(rule), true);
});

test("isManagedRedirectRule 只认 ref 精确匹配", () => {
  assert.equal(isManagedRedirectRule({ ref: MANAGED_REDIRECT_REF }), true);
  assert.equal(isManagedRedirectRule({ ref: "someone-elses-rule" }), false);
  assert.equal(isManagedRedirectRule({}), false);
  assert.equal(isManagedRedirectRule(null), false);
});

test("mergeManagedRedirectRule 保留既有他人规则，只 upsert 自己那条", () => {
  const othersRule = { ref: "someone-elses-rule", expression: `(http.host eq "blog.example.com")` };
  const [managed] = buildWwwToApexRedirectRule("example.com", "apex");

  // 没有自己的规则时:追加到末尾,不动既有规则
  const merged1 = mergeManagedRedirectRule([othersRule], managed);
  assert.deepEqual(merged1, [othersRule, managed]);

  // 已经有自己的旧版本规则时:原地替换,既有他人规则依旧原样保留、位置不变
  const staleManaged = { ...managed, description: "旧版本描述" };
  const merged2 = mergeManagedRedirectRule([othersRule, staleManaged], managed);
  assert.deepEqual(merged2, [othersRule, managed]);
});

test("conflictsWithManagedRedirect 命中同一 host 的非本脚本规则", () => {
  const conflicting = { expression: `(http.host eq "www.example.com")`, action_parameters: {} };
  assert.equal(conflictsWithManagedRedirect(conflicting, "example.com", "apex"), true);
});

test("conflictsWithManagedRedirect 不误判无关子域名（避免 substring 误伤）", () => {
  // "blog.example.com" 里确实包含字符串 "example.com",但它是完全不同的 host,
  // 不该被当成跟裸域 example.com 相关的重定向规则。
  const unrelated = { expression: `(http.host eq "blog.example.com")`, action_parameters: {} };
  assert.equal(conflictsWithManagedRedirect(unrelated, "example.com", "apex"), false);
});

test("conflictsWithManagedRedirect 对本脚本自己管理的规则永远返回 false", () => {
  const [managed] = buildWwwToApexRedirectRule("example.com", "apex");
  assert.equal(conflictsWithManagedRedirect(managed, "example.com", "apex"), false);
});

test("isManagedRuleUpToDate 判定现状是否已等于目标（忽略服务端只读字段）", () => {
  const [managed] = buildWwwToApexRedirectRule("example.com", "apex");
  const withServerFields = { ...managed, id: "server-assigned-id", last_updated: "2026-09-13T00:00:00Z", version: 3 };
  assert.equal(isManagedRuleUpToDate([withServerFields], managed), true);
  assert.equal(isManagedRuleUpToDate([], managed), false);
  assert.equal(isManagedRuleUpToDate([{ ...managed, enabled: false }], managed), false);
});

test("planApplyRedirects：已有他人规则时保留，只 upsert 自己那条", () => {
  const othersRule = { ref: "someone-elses-rule", expression: `(http.host eq "blog.example.com")` };
  const plan = planApplyRedirects({
    domain: "example.com",
    direction: "apex",
    existingRules: [othersRule],
    httpsAlreadyOn: false,
    forceReplace: false,
  });
  assert.equal(plan.blocked, false);
  assert.equal(plan.patchHttps, true);
  assert.equal(plan.writeRuleset, true);
  assert.deepEqual(plan.nextRules, [othersRule, plan.desiredRule]);
});

test("planApplyRedirects：现状已与目标一致时两项都跳过", () => {
  const [managed] = buildWwwToApexRedirectRule("example.com", "apex");
  const plan = planApplyRedirects({
    domain: "example.com",
    direction: "apex",
    existingRules: [managed],
    httpsAlreadyOn: true,
    forceReplace: false,
  });
  assert.equal(plan.patchHttps, false);
  assert.equal(plan.writeRuleset, false);
  assert.equal(plan.nextRules, null);
  assert.equal(plan.blocked, false);
});

test("planApplyRedirects：检测到冲突且未 --force-replace 时拒写", () => {
  const conflicting = { expression: `(http.host eq "www.example.com")`, action_parameters: {} };
  const plan = planApplyRedirects({
    domain: "example.com",
    direction: "apex",
    existingRules: [conflicting],
    httpsAlreadyOn: true,
    forceReplace: false,
  });
  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.conflicts, [conflicting]);
  assert.equal(plan.writeRuleset, false);
  assert.equal(plan.nextRules, null);
});

test("planApplyRedirects：--force-replace 时替换掉冲突规则", () => {
  const conflicting = { expression: `(http.host eq "www.example.com")`, action_parameters: {} };
  const plan = planApplyRedirects({
    domain: "example.com",
    direction: "apex",
    existingRules: [conflicting],
    httpsAlreadyOn: true,
    forceReplace: true,
  });
  assert.equal(plan.blocked, false);
  assert.equal(plan.writeRuleset, true);
  assert.deepEqual(plan.nextRules, [plan.desiredRule]);
});

// ── 集成测试:用假 fetch 接管 doApplyRedirects 实际发出的 GET/PATCH/PUT 序列 ──

const API_PREFIX = "/client/v4";

/** 构造一个假的 Cloudflare API,记录每次调用,状态保存在闭包里(PATCH/PUT 会
 * 改变后续 GET 读到的值,模拟真实 API 的读回一致性)。不发任何真实网络请求。 */
function makeFakeCf({ zoneId = "zone1", domain, httpsValue = "off", ruleset = null }) {
  const calls = [];
  let currentHttps = httpsValue;
  let currentRuleset = ruleset;

  async function fetchImpl(url, init = {}) {
    const method = init.method || "GET";
    const { pathname, search } = new URL(url);
    const p = pathname + search;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: p, body });

    if (method === "GET" && p === `${API_PREFIX}/zones?name=${encodeURIComponent(domain)}`) {
      return { json: async () => ({ success: true, result: [{ id: zoneId, name: domain }] }) };
    }
    if (p === `${API_PREFIX}/zones/${zoneId}/settings/always_use_https`) {
      if (method === "PATCH") currentHttps = body.value;
      return { json: async () => ({ success: true, result: { value: currentHttps } }) };
    }
    if (p === `${API_PREFIX}/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`) {
      if (method === "PUT") {
        currentRuleset = { name: body.name, description: body.description, rules: body.rules };
        return { json: async () => ({ success: true, result: { id: "rs1", ...currentRuleset } }) };
      }
      if (!currentRuleset) {
        return {
          json: async () => ({
            success: false,
            errors: [{ code: 10000, message: "could not find entrypoint ruleset" }],
          }),
        };
      }
      return { json: async () => ({ success: true, result: { id: "rs1", ...currentRuleset } }) };
    }
    throw new Error(`makeFakeCf: unexpected fetch ${method} ${p}`);
  }

  return { fetchImpl, calls, getRuleset: () => currentRuleset, getHttps: () => currentHttps };
}

test("doApplyRedirects（假 fetch）：已有他人规则被保留，upsert 只加自己那条", async (t) => {
  const domain = "example.com";
  const othersRule = {
    ref: "someone-elses-rule",
    action: "redirect",
    expression: `(http.host eq "blog.example.com")`,
    description: "别人配的博客重定向",
    action_parameters: {},
    enabled: true,
  };
  const fake = makeFakeCf({
    domain,
    httpsValue: "off",
    ruleset: { name: "default", description: "", rules: [othersRule] },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await doApplyRedirects(domain, "apex", {});

  const finalRuleset = fake.getRuleset();
  assert.equal(finalRuleset.rules.length, 2);
  assert.deepEqual(finalRuleset.rules[0], othersRule, "别人的规则必须原样保留");
  assert.equal(finalRuleset.rules[1].ref, MANAGED_REDIRECT_REF);
  assert.equal(fake.getHttps(), "on");

  const putCalls = fake.calls.filter((c) => c.method === "PUT");
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].body.rules.length, 2);
});

test("doApplyRedirects（假 fetch）：已与目标一致时跳过 PATCH 与 PUT", async (t) => {
  const domain = "example.com";
  const [managed] = buildWwwToApexRedirectRule(domain, "apex");
  const fake = makeFakeCf({
    domain,
    httpsValue: "on",
    ruleset: { name: "default", description: "", rules: [managed] },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await doApplyRedirects(domain, "apex", {});

  const writeCalls = fake.calls.filter((c) => c.method === "PATCH" || c.method === "PUT");
  assert.deepEqual(writeCalls, [], "已一致时不应该发出任何写请求");
});

test("doApplyRedirects（假 fetch）：检测到冲突时抛 RedirectConflictError，不写入", async (t) => {
  const domain = "example.com";
  const conflicting = {
    ref: "someone-elses-www-redirect",
    action: "redirect",
    expression: `(http.host eq "www.example.com")`,
    description: "别人配的 www 重定向，方向可能跟本脚本不一样",
    action_parameters: {},
    enabled: true,
  };
  const fake = makeFakeCf({
    domain,
    httpsValue: "on",
    ruleset: { name: "default", description: "", rules: [conflicting] },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(() => doApplyRedirects(domain, "apex", {}), RedirectConflictError);

  const writeCalls = fake.calls.filter((c) => c.method === "PATCH" || c.method === "PUT");
  assert.deepEqual(writeCalls, [], "冲突且未 --force-replace 时不应该发出任何写请求");
  assert.deepEqual(fake.getRuleset().rules, [conflicting], "既有规则必须原封不动");
});

test("doApplyRedirects（假 fetch）：--force-replace 时替换掉冲突规则", async (t) => {
  const domain = "example.com";
  const conflicting = {
    ref: "someone-elses-www-redirect",
    action: "redirect",
    expression: `(http.host eq "www.example.com")`,
    description: "别人配的 www 重定向",
    action_parameters: {},
    enabled: true,
  };
  const fake = makeFakeCf({
    domain,
    httpsValue: "on",
    ruleset: { name: "default", description: "", rules: [conflicting] },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await doApplyRedirects(domain, "apex", { forceReplace: true });

  const finalRules = fake.getRuleset().rules;
  assert.equal(finalRules.length, 1);
  assert.equal(finalRules[0].ref, MANAGED_REDIRECT_REF);
});

test("doApplyRedirects（假 fetch）：--dry-run 只读，不发 PATCH/PUT", async (t) => {
  const domain = "example.com";
  const fake = makeFakeCf({ domain, httpsValue: "off", ruleset: null });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await doApplyRedirects(domain, "apex", { dryRun: true });

  const writeCalls = fake.calls.filter((c) => c.method === "PATCH" || c.method === "PUT");
  assert.deepEqual(writeCalls, [], "--dry-run 不应该发出任何写请求");
  assert.equal(fake.getHttps(), "off", "--dry-run 不应该改变任何状态");
  assert.equal(fake.getRuleset(), null, "--dry-run 不应该创建 ruleset");
});

test("doApplyRedirects（假 fetch）：ruleset 从零创建时 PUT body 带 name/description", async (t) => {
  const domain = "example.com";
  const fake = makeFakeCf({ domain, httpsValue: "on", ruleset: null });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await doApplyRedirects(domain, "apex", {});

  const putCalls = fake.calls.filter((c) => c.method === "PUT");
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].body.name, "default");
  assert.equal(typeof putCalls[0].body.description, "string");
  assert.ok(!("kind" in putCalls[0].body), "PUT body 不能带 kind 字段（CF 会拒绝）");
  assert.ok(!("phase" in putCalls[0].body), "PUT body 不能带 phase 字段（CF 会拒绝）");
});
