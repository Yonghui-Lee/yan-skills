import test from "node:test";
import assert from "node:assert/strict";
import { resolveCfAuth, cfAuthHeaders, cfAuthEnvHelp, resolveCfAccountId, CfAuthError } from "../scripts/lib-cf-auth.mjs";

// 全程只用假值（fake-*），绝不读取/打印任何真实凭据。断言只看变量名/头名有没有
// 正确出现，不断言真实凭据的内容。

test("resolveCfAuth: 只有 CLOUDFLARE_API_TOKEN 时走 API Token 方式", () => {
  const result = resolveCfAuth({ env: { CLOUDFLARE_API_TOKEN: "fake-token-aaa" } });
  assert.equal(result.method, "token");
  assert.deepEqual(result.headers, { Authorization: "Bearer fake-token-aaa" });
});

test("resolveCfAuth: 只有 CF_API_TOKEN（简写别名）时同样走 API Token 方式", () => {
  const result = resolveCfAuth({ env: { CF_API_TOKEN: "fake-token-bbb" } });
  assert.equal(result.method, "token");
  assert.deepEqual(result.headers, { Authorization: "Bearer fake-token-bbb" });
});

test("resolveCfAuth: 两个 token 变量都设置时，CLOUDFLARE_API_TOKEN 优先", () => {
  const result = resolveCfAuth({
    env: { CLOUDFLARE_API_TOKEN: "fake-token-wins", CF_API_TOKEN: "fake-token-loses" },
  });
  assert.equal(result.headers.Authorization, "Bearer fake-token-wins");
});

test("resolveCfAuth: token 值前后空白会被 trim", () => {
  const result = resolveCfAuth({ env: { CLOUDFLARE_API_TOKEN: "  fake-token-padded  " } });
  assert.equal(result.headers.Authorization, "Bearer fake-token-padded");
});

test("resolveCfAuth: CF_EMAIL + CF_GLOBAL_KEY 成对出现时走 Global API Key 方式", () => {
  const result = resolveCfAuth({
    env: { CF_EMAIL: "fake-user@example.com", CF_GLOBAL_KEY: "fake-global-key-ccc" },
  });
  assert.equal(result.method, "global-key");
  assert.deepEqual(result.headers, {
    "X-Auth-Email": "fake-user@example.com",
    "X-Auth-Key": "fake-global-key-ccc",
  });
});

test("resolveCfAuth: CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY（官方全称）成对出现时同样走 Global API Key 方式", () => {
  const result = resolveCfAuth({
    env: { CLOUDFLARE_EMAIL: "fake-user2@example.com", CLOUDFLARE_API_KEY: "fake-global-key-ddd" },
  });
  assert.equal(result.method, "global-key");
  assert.deepEqual(result.headers, {
    "X-Auth-Email": "fake-user2@example.com",
    "X-Auth-Key": "fake-global-key-ddd",
  });
});

test("resolveCfAuth: email/key 两个命名混搭（CF_EMAIL + CLOUDFLARE_API_KEY）也能配对成功", () => {
  const result = resolveCfAuth({
    env: { CF_EMAIL: "fake-user3@example.com", CLOUDFLARE_API_KEY: "fake-global-key-eee" },
  });
  assert.equal(result.method, "global-key");
  assert.deepEqual(result.headers, {
    "X-Auth-Email": "fake-user3@example.com",
    "X-Auth-Key": "fake-global-key-eee",
  });
});

test("resolveCfAuth: email 两个变量都设置时，CLOUDFLARE_EMAIL 优先", () => {
  const result = resolveCfAuth({
    env: {
      CLOUDFLARE_EMAIL: "fake-wins@example.com",
      CF_EMAIL: "fake-loses@example.com",
      CF_GLOBAL_KEY: "fake-global-key-fff",
    },
  });
  assert.equal(result.headers["X-Auth-Email"], "fake-wins@example.com");
});

test("resolveCfAuth: key 两个变量都设置时，CLOUDFLARE_API_KEY 优先", () => {
  const result = resolveCfAuth({
    env: {
      CF_EMAIL: "fake-user4@example.com",
      CLOUDFLARE_API_KEY: "fake-key-wins",
      CF_GLOBAL_KEY: "fake-key-loses",
    },
  });
  assert.equal(result.headers["X-Auth-Key"], "fake-key-wins");
});

test("resolveCfAuth: 优先级——token 与 email+key 都配齐时，走 API Token（token 方式优先于 Global Key）", () => {
  const result = resolveCfAuth({
    env: {
      CLOUDFLARE_API_TOKEN: "fake-token-should-win",
      CF_EMAIL: "fake-user5@example.com",
      CF_GLOBAL_KEY: "fake-global-key-should-lose",
    },
  });
  assert.equal(result.method, "token");
  assert.deepEqual(result.headers, { Authorization: "Bearer fake-token-should-win" });
});

test("resolveCfAuth: 只给 email 不给 key 时抛错，且不会误判成功", () => {
  assert.throws(
    () => resolveCfAuth({ env: { CF_EMAIL: "fake-user6@example.com" } }),
    CfAuthError,
  );
});

test("resolveCfAuth: 只给 key 不给 email 时抛错，且不会误判成功", () => {
  assert.throws(
    () => resolveCfAuth({ env: { CF_GLOBAL_KEY: "fake-global-key-ggg" } }),
    CfAuthError,
  );
});

test("resolveCfAuth: 什么都没配时抛出 CfAuthError，消息里列出全部可接受的环境变量名及搭配关系", () => {
  assert.throws(() => resolveCfAuth({ env: {} }), (err) => {
    assert.ok(err instanceof CfAuthError);
    // 方式一：两个 token 变量名都要出现。
    assert.match(err.message, /CLOUDFLARE_API_TOKEN/);
    assert.match(err.message, /CF_API_TOKEN/);
    // 方式二：两套 email/key 命名都要出现，且能看出 email 与 key 是成对搭配的。
    assert.match(err.message, /CF_EMAIL/);
    assert.match(err.message, /CLOUDFLARE_EMAIL/);
    assert.match(err.message, /CF_GLOBAL_KEY/);
    assert.match(err.message, /CLOUDFLARE_API_KEY/);
    return true;
  });
});

test("resolveCfAuth: 错误消息与 cfAuthEnvHelp() 保持同一份文案来源", () => {
  try {
    resolveCfAuth({ env: {} });
    assert.fail("应该抛错");
  } catch (e) {
    assert.ok(e.message.includes(cfAuthEnvHelp()));
  }
});

test("resolveCfAuth: overrides.token/email/key 优先于环境变量（用于 CLI 参数、.cf-token 文件等来源）", () => {
  const result = resolveCfAuth({
    token: "fake-override-token",
    env: { CLOUDFLARE_API_TOKEN: "fake-env-token-should-lose" },
  });
  assert.equal(result.headers.Authorization, "Bearer fake-override-token");
});

test("resolveCfAuth: overrides 传空字符串时视为未提供，仍会回退到环境变量", () => {
  const result = resolveCfAuth({
    token: "",
    env: { CLOUDFLARE_API_TOKEN: "fake-fallback-token" },
  });
  assert.equal(result.headers.Authorization, "Bearer fake-fallback-token");
});

test("cfAuthHeaders: 语法糖直接返回 headers（不需要调用方再取 .headers）", () => {
  const headers = cfAuthHeaders({ env: { CLOUDFLARE_API_TOKEN: "fake-token-sugar" } });
  assert.deepEqual(headers, { Authorization: "Bearer fake-token-sugar" });
});

test("cfAuthHeaders: 凭据不全时同样抛出 CfAuthError（不吞异常）", () => {
  assert.throws(() => cfAuthHeaders({ env: {} }), CfAuthError);
});

// 默认参数下 resolveCfAuth 读的是真实 process.env——用真实环境变量名跑一遍同样的
// 优先级验证，确认默认值不是只在测试的 env override 路径下才成立。测试自己保存/
// 清理这几个变量，不污染其他测试或用户真正配置的 .env。
test("resolveCfAuth: 默认读 process.env（不传 env 时），并在用完后完整还原现场", () => {
  const KEYS = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CF_EMAIL", "CLOUDFLARE_EMAIL", "CF_GLOBAL_KEY", "CLOUDFLARE_API_KEY"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of KEYS) delete process.env[k];
    process.env.CF_API_TOKEN = "fake-real-env-token";

    const result = resolveCfAuth();
    assert.equal(result.headers.Authorization, "Bearer fake-real-env-token");
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  // 现场已还原：再次读取应该拿到测试开始前的原始状态，而不是被测试污染。
  for (const k of KEYS) assert.equal(process.env[k], saved[k]);
});

// ── resolveCfAccountId ──────────────────────────────────────────────────
// 同样只用假值；网络调用一律用 fetchImpl 假实现拦截，真实测试环境不发请求。

function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: response.status ?? 200,
      json: async () => response.body,
    };
  };
  impl.calls = calls;
  return impl;
}

test("resolveCfAccountId: 显式传入 accountId 时直接用它，不发请求", async () => {
  const fetchImpl = fakeFetch({ body: { success: true, result: [] } });
  const id = await resolveCfAccountId({ accountId: "explicit-acct", env: {}, fetchImpl });
  assert.equal(id, "explicit-acct");
  assert.equal(fetchImpl.calls.length, 0);
});

test("resolveCfAccountId: 只有 CF_ACCOUNT_ID 时读它，不发请求", async () => {
  const fetchImpl = fakeFetch({ body: { success: true, result: [] } });
  const id = await resolveCfAccountId({ env: { CF_ACCOUNT_ID: "fake-acct-cf" }, fetchImpl });
  assert.equal(id, "fake-acct-cf");
  assert.equal(fetchImpl.calls.length, 0);
});

test("resolveCfAccountId: 只有 CLOUDFLARE_ACCOUNT_ID 时读它，不发请求", async () => {
  const fetchImpl = fakeFetch({ body: { success: true, result: [] } });
  const id = await resolveCfAccountId({ env: { CLOUDFLARE_ACCOUNT_ID: "fake-acct-cloudflare" }, fetchImpl });
  assert.equal(id, "fake-acct-cloudflare");
  assert.equal(fetchImpl.calls.length, 0);
});

test("resolveCfAccountId: 两个变量都设置时，CLOUDFLARE_ACCOUNT_ID 优先（与 resolveCfAuth 同一条准则）", async () => {
  const fetchImpl = fakeFetch({ body: { success: true, result: [] } });
  const id = await resolveCfAccountId({
    env: { CLOUDFLARE_ACCOUNT_ID: "fake-acct-wins", CF_ACCOUNT_ID: "fake-acct-loses" },
    fetchImpl,
  });
  assert.equal(id, "fake-acct-wins");
});

test("resolveCfAccountId: 显式参数优先于两个环境变量", async () => {
  const fetchImpl = fakeFetch({ body: { success: true, result: [] } });
  const id = await resolveCfAccountId({
    accountId: "explicit-wins",
    env: { CLOUDFLARE_ACCOUNT_ID: "fake-acct-loses-1", CF_ACCOUNT_ID: "fake-acct-loses-2" },
    fetchImpl,
  });
  assert.equal(id, "explicit-wins");
});

test("resolveCfAccountId: 环境变量值前后空白会被 trim", async () => {
  const fetchImpl = fakeFetch({ body: { success: true, result: [] } });
  const id = await resolveCfAccountId({ env: { CF_ACCOUNT_ID: "  fake-acct-padded  " }, fetchImpl });
  assert.equal(id, "fake-acct-padded");
});

test("resolveCfAccountId: 两个变量都没配时，调 GET /accounts；账号唯一时直接用它", async () => {
  const fetchImpl = fakeFetch({
    body: { success: true, result: [{ id: "only-account-id", name: "Only Account" }] },
  });
  const id = await resolveCfAccountId({
    env: {},
    headers: { Authorization: "Bearer fake-token-for-account-lookup" },
    fetchImpl,
  });
  assert.equal(id, "only-account-id");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "https://api.cloudflare.com/client/v4/accounts");
  assert.deepEqual(fetchImpl.calls[0].init.headers, { Authorization: "Bearer fake-token-for-account-lookup" });
});

test("resolveCfAccountId: 没传 headers 时，自己用 overrides 走 resolveCfAuth 拼一份", async () => {
  const fetchImpl = fakeFetch({
    body: { success: true, result: [{ id: "only-account-id-2", name: "Only Account 2" }] },
  });
  const id = await resolveCfAccountId({
    env: {},
    overrides: { token: "fake-token-via-overrides" },
    fetchImpl,
  });
  assert.equal(id, "only-account-id-2");
  assert.deepEqual(fetchImpl.calls[0].init.headers, { Authorization: "Bearer fake-token-via-overrides" });
});

test("resolveCfAccountId: apiBase 可覆盖，用于拼请求 URL", async () => {
  const fetchImpl = fakeFetch({ body: { success: true, result: [{ id: "acct", name: "A" }] } });
  await resolveCfAccountId({ env: {}, headers: {}, fetchImpl, apiBase: "https://fake-api.example.com/v9" });
  assert.equal(fetchImpl.calls[0].url, "https://fake-api.example.com/v9/accounts");
});

test("resolveCfAccountId: 账号列表为空时抛 CfAuthError，消息里列出两个可接受的变量名", async () => {
  const fetchImpl = fakeFetch({ body: { success: true, result: [] } });
  await assert.rejects(
    () => resolveCfAccountId({ env: {}, headers: {}, fetchImpl }),
    (err) => {
      assert.ok(err instanceof CfAuthError);
      assert.match(err.message, /CLOUDFLARE_ACCOUNT_ID/);
      assert.match(err.message, /CF_ACCOUNT_ID/);
      return true;
    },
  );
});

test("resolveCfAccountId: 账号有多个时抛 CfAuthError，消息里列出变量名以及每个账号的 id/name", async () => {
  const fetchImpl = fakeFetch({
    body: {
      success: true,
      result: [
        { id: "acct-one", name: "Account One" },
        { id: "acct-two", name: "Account Two" },
      ],
    },
  });
  await assert.rejects(
    () => resolveCfAccountId({ env: {}, headers: {}, fetchImpl }),
    (err) => {
      assert.ok(err instanceof CfAuthError);
      assert.match(err.message, /CLOUDFLARE_ACCOUNT_ID/);
      assert.match(err.message, /CF_ACCOUNT_ID/);
      assert.match(err.message, /acct-one/);
      assert.match(err.message, /Account One/);
      assert.match(err.message, /acct-two/);
      assert.match(err.message, /Account Two/);
      return true;
    },
  );
});

test("resolveCfAccountId: API 返回 success:false 时抛 CfAuthError，消息里带 HTTP 状态码", async () => {
  const fetchImpl = fakeFetch({
    status: 403,
    body: { success: false, errors: [{ code: 9109, message: "Invalid access token" }] },
  });
  await assert.rejects(
    () => resolveCfAccountId({ env: {}, headers: {}, fetchImpl }),
    (err) => {
      assert.ok(err instanceof CfAuthError);
      assert.match(err.message, /403/);
      assert.match(err.message, /Invalid access token/);
      return true;
    },
  );
});
