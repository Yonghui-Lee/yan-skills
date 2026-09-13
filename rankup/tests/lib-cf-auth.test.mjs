import test from "node:test";
import assert from "node:assert/strict";
import { resolveCfAuth, cfAuthHeaders, cfAuthEnvHelp, CfAuthError } from "../scripts/lib-cf-auth.mjs";

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
