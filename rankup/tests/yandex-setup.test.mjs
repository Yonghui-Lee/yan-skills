import test from "node:test";
import assert from "node:assert/strict";
import {
  yandexSitePath,
  extractYandexVerificationValue,
  hasVerifyRequestSucceeded,
  siteAlreadyRegistered,
  parseVerificationStatus,
} from "../scripts/yandex-setup.mjs";

test("yandexSitePath 按协议:主机:端口拼接，与 webmaster-sitemap.mjs 同款", () => {
  assert.equal(yandexSitePath("https://example.com"), "/site/https:example.com:443");
  assert.equal(yandexSitePath("http://example.com"), "/site/http:example.com:80");
  assert.equal(yandexSitePath("https://example.com:8443"), "/site/https:example.com:8443");
});

test("extractYandexVerificationValue 从页面文本里抠 DNS TXT 值", () => {
  const text = "选择验证方式\nDNS record\nyandex-verification: 52711165efb84d91\n下一步";
  assert.equal(extractYandexVerificationValue(text), "52711165efb84d91");
});

test("extractYandexVerificationValue 找不到时返回 null，不是空字符串", () => {
  assert.equal(extractYandexVerificationValue("没有验证值的页面"), null);
  assert.equal(extractYandexVerificationValue(""), null);
});

// 回归:Verify 点击是否生效的唯一判据是网络请求,不是页面文案——页面文案在
// 请求成功之前和点击前完全一样,不能作为判据。
test("hasVerifyRequestSucceeded 命中 2xx 的 verification/verify 请求才算生效", () => {
  const ok = { entries: [{ url: "https://webmaster.yandex.com/gate/verification/verify/", status: 200 }] };
  assert.equal(hasVerifyRequestSucceeded(ok), true);
});

test("hasVerifyRequestSucceeded 没有匹配请求或状态非 2xx 时判未生效", () => {
  assert.equal(hasVerifyRequestSucceeded({ entries: [] }), false);
  assert.equal(
    hasVerifyRequestSucceeded({ entries: [{ url: "https://x/other", status: 200 }] }),
    false,
  );
  assert.equal(
    hasVerifyRequestSucceeded({
      entries: [{ url: "https://webmaster.yandex.com/gate/verification/verify/", status: 500 }],
    }),
    false,
  );
});

test("hasVerifyRequestSucceeded 对缺失/畸形 entries 不抛错", () => {
  assert.equal(hasVerifyRequestSucceeded({}), false);
  assert.equal(hasVerifyRequestSucceeded(null), false);
});

test("siteAlreadyRegistered: 落在目标站点的 access 设置页判已存在", () => {
  assert.equal(
    siteAlreadyRegistered(
      "https://webmaster.yandex.com/site/https:example.com:443/settings/access/",
      "https://example.com",
    ),
    true,
  );
});

test("siteAlreadyRegistered: 被重定向到添加页/站点列表判不存在", () => {
  assert.equal(
    siteAlreadyRegistered("https://webmaster.yandex.com/sites/add/", "https://example.com"),
    false,
  );
  assert.equal(
    siteAlreadyRegistered("https://webmaster.yandex.com/sites/", "https://example.com"),
    false,
  );
});

test("siteAlreadyRegistered: URL 解析失败时不抛错，判不存在", () => {
  assert.equal(siteAlreadyRegistered("not a url", "https://example.com"), false);
});

test("parseVerificationStatus: 命中验证日期判 verified 并抠出日期", () => {
  const text = "Username\tVerification method and code\tRole\tVerification date\nfoo@example.com\tDNS record\n52711165\tOwner\t09/13/2026";
  const result = parseVerificationStatus(text);
  assert.equal(result.status, "verified");
  assert.equal(result.date, "09/13/2026");
});

test("parseVerificationStatus: 命中检查中文案判 pending", () => {
  assert.equal(parseVerificationStatus("Check is in progress, it can take up to two days").status, "pending");
});

test("parseVerificationStatus: 都不命中时判 unknown，不强行归类", () => {
  assert.equal(parseVerificationStatus("完全不相关的页面文本").status, "unknown");
});
