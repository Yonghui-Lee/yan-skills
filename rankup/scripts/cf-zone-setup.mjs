#!/usr/bin/env node
/**
 * Cloudflare zone 接入（wrangler 没有 zone 命令，这是补它的缺口）。
 *
 * 用法：
 *   node <rankup-skill-dir>/scripts/cf-zone-setup.mjs status <domain>
 *   node <rankup-skill-dir>/scripts/cf-zone-setup.mjs create <domain>
 *   node <rankup-skill-dir>/scripts/cf-zone-setup.mjs check-redirects <domain>
 *   node <rankup-skill-dir>/scripts/cf-zone-setup.mjs apply-redirects <domain> --to <www|apex>
 *
 * 凭据解析统一走 ./lib-cf-auth.mjs 的 resolveCfAuth（2026-09-13 收敛，历史原因见
 * 该文件头注释）：API Token 认 CLOUDFLARE_API_TOKEN 或 CF_API_TOKEN，都没有则
 * 退到 Global API Key（CF_EMAIL/CLOUDFLARE_EMAIL 配 CF_GLOBAL_KEY/CLOUDFLARE_API_KEY，
 * 必须成对）。这些都没配时还会退到 <repo>/.cf-token（该文件已被 .gitignore 排除，
 * 只当 API Token 用，不支持在这里塞 Global Key）。真实值不打印、不落盘、不进日志。
 *
 * 需要的权限：Zone > Zone > Edit，资源范围必须是 **All zones**。
 * zone 还不存在，所以 zone-scoped 的 token 建不了它——这是官方文档明确写的。
 * 不要用 Global API Key：它不能限定 scope，泄露即等于整个账号。
 *
 * ── check-redirects / apply-redirects：协议/host 收敛到规范 URL（2026-09-13 新增）──
 *
 * 根因：zone 没开 Always Use HTTPS、`www` 子域也没收敛到裸域（或反过来），会让
 * http / http-www / https-www 三种非规范协议+host 组合都能直接 200 访问到内容——
 * 这是一批表面上互不相干的问题（重复内容、多个 sitemap 出现同一批 URL、内链走了
 * 非规范 host）背后共同的根因。一次修好协议+host，比逐条排查每个症状便宜得多。
 *
 * check-redirects 只读（GET only，不改任何配置），查看 Always Use HTTPS 现状与
 * 已存在的 dynamic redirect 规则；apply-redirects 是写操作，会立刻打开 Always Use
 * HTTPS，并覆盖式替换整个 http_request_dynamic_redirect phase 入口的规则集（PUT
 * 是幂等替换，不是追加，所以不需要先建 ruleset 再改）。`--to` 必须显式指定 www
 * 或 apex，不设默认值——方向是意图声明，不能靠猜。
 *
 * 四个已验证的坑（2026-09-13，两个真实项目分别复盘）：
 *   1. target_url 的 expression **不支持 if()**——Cloudflare 的 wirefilter 表达式
 *      语法会报 `unknown identifier`。查询串保留与否交给同级的
 *      `preserve_query_string` 参数处理，不要在 expression 里手写判空逻辑。
 *   2. **不要套用 Cloudflare 控制台自带的「从 WWW 重定向到根」模板规则**——它硬编码
 *      匹配 `https://www.*`（要求协议已经是 https），如果来源是 `http://www.*`，
 *      会先被 Always Use HTTPS 接走升级协议、再撞上这条规则，变成两跳而不是一跳。
 *      这里手写的规则按 `http.host eq "..."` 匹配（不含协议前缀），不管来源协议
 *      是 http 还是 https 都一次性跳到位，这是刻意的设计，不是疏漏。
 *   3. **PUT body 不能带 `kind`/`phase` 字段**——它们是只读的、由 URL 决定，照抄
 *      GET 响应的完整字段回填会被拒绝（`invalid JSON: unknown field "kind"`）；
 *      body 只认 `name`/`description`/`rules` 三个字段，且**从零创建**这个 phase
 *      时（该 zone 此前从没配置过，GET 报 `could not find entrypoint ruleset`）
 *      必须带上 `name`/`description` 才能建成功，本脚本因此固定带上这两个字段，
 *      不依赖 entrypoint 是否已经存在。
 *   4. **为什么走 dynamic redirect phase 而不是在 Worker 代码里判断 host 跳转**：
 *      `www` 子域名在 Workers 场景下常见的接法是一条指向占位地址的 DNS 记录
 *      （例如 `AAAA www.<domain> -> 100::`，`proxied: true`），实际请求由同一个
 *      Worker 处理——但如果 Worker 自己的路由对这个 host 没有显式处理，会直接
 *      404，而不是"什么都不做，内容照常返回"。把跳转放在 zone 级的 dynamic
 *      redirect phase 里，请求在到达 Worker 之前就已经跳转完毕，不依赖 Worker
 *      代码是否覆盖了这个 host，也不需要为了这一条重定向单独发一次 Worker 部署。
 *
 * 已验证：2026-08-21（status/create）。check-redirects：2026-09-13 在真实账号上
 * 跑通只读核验。apply-redirects 本身未在真实账号上跑过这份脚本代码——上面四条坑
 * 与"一跳到位"的复验，来自两个真实项目当天用等价的手工 curl 调用（同一套
 * API/端点/body 形状）分别跑通「已有 entrypoint、覆盖式更新」与「从零创建
 * entrypoint」两条路径，脚本按那两次手工调用的确切请求复刻；换新账号第一次用
 * apply-redirects 时建议先 check-redirects 核对现状，执行后也再 check-redirects
 * 一次确认。
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { cfAuthHeaders, resolveCfAccountId, CfAuthError } from "./lib-cf-auth.mjs"

const API = "https://api.cloudflare.com/client/v4"

/** 项目根目录下的 .cf-token（已 gitignore）：环境变量都没设置时的最后兜底，
 * 只当 API Token 用——想用 Global Key 请直接设 CF_EMAIL/CF_GLOBAL_KEY 这对环境变量。 */
function fileToken() {
  const f = join(process.cwd(), ".cf-token")
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined
}

/**
 * 两种凭据的 header 完全不同，认错会得到一个极具误导性的
 * `6003 Invalid request headers`（看着像请求写错了，其实是凭据类型不匹配）。
 * 具体的环境变量名、优先级与两种 header 的拼法见 ./lib-cf-auth.mjs。
 */
function authHeaders() {
  try {
    return cfAuthHeaders({ token: process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || fileToken() })
  } catch (e) {
    console.error(
      `${e.message}\n\n` +
        `也可以把 API Token 写进 <repo>/.cf-token（已 gitignore），环境变量都没设置时会读它。\n\n` +
        `token 在 dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom：\n` +
        `  权限  Zone > Zone > Edit\n` +
        `  范围  Zone Resources = All zones      ← 必须 All zones，不能选具体某个 zone`,
    )
    process.exit(2)
  }
}

async function cf(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  })
  const j = await r.json().catch(() => ({}))
  if (!j.success) {
    const msg = (j.errors || []).map((e) => `${e.code} ${e.message}`).join("; ")
    throw new Error(`${init.method || "GET"} ${path} → HTTP ${r.status}: ${msg || "未知错误"}`)
  }
  return j.result
}

function reportZone(z) {
  console.log(`zone       ${z.name}`)
  console.log(`状态       ${z.status}`)
  console.log(`zone id    ${z.id}`)
  if (z.original_name_servers?.length) console.log(`原 NS      ${z.original_name_servers.join(", ")}`)
  console.log(`\n把注册商的 NS 整体替换成这两个（是替换，不是追加）：`)
  for (const ns of z.name_servers || []) console.log(`  ${ns}`)
  if (z.status !== "active") {
    console.log(`\n⚠️ 状态还不是 active。换 NS 之前先在注册商关掉 DNSSEC——`)
    console.log(`   带着旧 DS 记录换 NS 会 SERVFAIL，症状伪装成「NS 还没生效」。`)
    console.log(`   核验：whois -h whois.registry.co ${z.name} | grep -i dnssec   → 要看到 unsigned`)
  }
}

/* ── 纯函数：重定向规则构造与状态判定（可脱离网络单测） ──────────── */

/**
 * 构造「www ⇄ 裸域」一跳到位的 301 重定向规则——PUT 整个
 * http_request_dynamic_redirect phase 入口时要用的 rules 数组（纯构造，不发请求）。
 *
 * direction "apex"：把 www.<domain> 重定向到裸域 <domain>（真实项目验证过的那套配置）。
 * direction "www"：镜像方向，把裸域 <domain> 重定向到 www.<domain>。
 *
 * 【已验证的坑，2026-09-13，真实项目复盘】
 * 1. target_url.expression 不支持 if()——wirefilter 表达式语法会报
 *    `unknown identifier`。查询串保留与否交给同级的 preserve_query_string
 *    参数处理，不要在 expression 里手写判空逻辑。
 * 2. 不要套用 Cloudflare 控制台自带的「从 WWW 重定向到根」模板规则：它硬编码
 *    匹配 `https://www.*`（要求协议已经是 https），来源若是 http://www.* 会先被
 *    Always Use HTTPS 接走升级协议、再撞上这条规则，变成两跳而不是一跳。这里按
 *    http.host（不含协议前缀）匹配，不管来源协议是 http 还是 https 都一次跳到位。
 */
export function buildWwwToApexRedirectRule(domain, direction) {
  if (direction !== "apex" && direction !== "www") {
    throw new Error(`direction 必须是 "apex" 或 "www"，收到：${JSON.stringify(direction)}`)
  }
  const fromHost = direction === "apex" ? `www.${domain}` : domain
  const toHost = direction === "apex" ? domain : `www.${domain}`
  return [
    {
      action: "redirect",
      action_parameters: {
        from_value: {
          status_code: 301,
          target_url: { expression: `concat("https://${toHost}", http.request.uri.path)` },
          preserve_query_string: true,
        },
      },
      expression: `(http.host eq "${fromHost}")`,
      description:
        direction === "apex" ? "www -> apex, any protocol, one hop 301" : "apex -> www, any protocol, one hop 301",
      enabled: true,
    },
  ]
}

/**
 * 判断 Always Use HTTPS 是否已经打开。接受 CF API 返回的 setting 对象
 * （形如 `{value:"on"}`）或裸字符串（`"on"`）。对畸形输入（null/undefined/
 * `{}`/其他形状）一律返回 false，不抛错——这是只读展示用的判定，不该因为
 * 输入形状意外而中断调用方。
 */
export function isAlwaysUseHttpsOn(settingValue) {
  if (typeof settingValue === "string") return settingValue === "on"
  if (settingValue && typeof settingValue === "object") return settingValue.value === "on"
  return false
}

/* ── 命令 ─────────────────────────────────────────────────── */

/** check-redirects/apply-redirects 共用：找不到 zone 就报错退出，提示先跑 create。 */
async function findZoneOrDie(domain) {
  const found = await cf(`/zones?name=${encodeURIComponent(domain)}`)
  if (!found.length) {
    console.error(`${domain} 不在这个账号里，先跑: cf-zone-setup.mjs create ${domain}`)
    process.exit(2)
  }
  return found[0]
}

/** check-redirects：只读，GET only，不改任何配置。 */
async function doCheckRedirects(domain) {
  const zone = await findZoneOrDie(domain)
  console.log(`── 协议/host 收敛只读核验：${domain} ──`)
  console.log(`zone id            ${zone.id}`)

  const httpsSetting = await cf(`/zones/${zone.id}/settings/always_use_https`)
  console.log(
    `Always Use HTTPS   ${isAlwaysUseHttpsOn(httpsSetting) ? "✅ on" : "❌ off"}（原始值：${JSON.stringify(httpsSetting)}）`,
  )

  let ruleset = null
  try {
    ruleset = await cf(`/zones/${zone.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`)
  } catch {
    ruleset = null // 该 phase 从未配置过规则时 CF 对这个 GET 直接返回失败，视同「不存在」
  }

  console.log()
  if (!ruleset?.rules?.length) {
    console.log(`dynamic redirect ruleset   （不存在，或存在但没有规则）`)
  } else {
    console.log(`dynamic redirect ruleset   已存在 ${ruleset.rules.length} 条规则：`)
    for (const r of ruleset.rules) {
      console.log(`  - description: ${r.description || "(无)"}`)
      console.log(`    expression:  ${r.expression}`)
    }
  }
}

/**
 * apply-redirects：写操作，执行后立刻生效，不是只读预览。
 * --to 必须显式给 www 或 apex，不接受裸调用、没有默认值——方向是意图声明，不能靠猜。
 */
async function doApplyRedirects(domain, direction) {
  if (direction !== "apex" && direction !== "www") {
    console.error(`必须显式指定方向：--to www 或 --to apex（不接受裸调用，也没有默认值）
  --to apex   把 www.${domain} 重定向到裸域 ${domain}
  --to www    把裸域 ${domain} 重定向到 www.${domain}`)
    process.exit(2)
  }

  const zone = await findZoneOrDie(domain)
  const httpsBody = { value: "on" }
  // 【实测坑，2026-09-13，另一真实项目复盘】entrypoint 端点的 PUT body 只认
  // name / description / rules 三个字段——kind / phase 是只读的、由 URL 决定，
  // 照抄 GET 响应的完整字段回填会被拒绝（`invalid JSON: unknown field "kind"`）。
  // 反过来，zone 此前从未配置过这个 phase 时（GET 报 `could not find entrypoint
  // ruleset`），PUT 必须带 name/description 才能建成功，光传 { rules: [...] }
  // 在"从零创建"这条路径上不可靠，所以两个字段固定带上，不依赖是否已存在。
  const rulesetBody = { name: "default", description: "", rules: buildWwwToApexRedirectRule(domain, direction) }

  console.log(`── 即将对 ${domain}（zone ${zone.id}）执行写操作，立刻生效 ──\n`)
  console.log(`PATCH /zones/${zone.id}/settings/always_use_https`)
  console.log(JSON.stringify(httpsBody, null, 2))
  console.log()
  console.log(`PUT /zones/${zone.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`)
  console.log(JSON.stringify(rulesetBody, null, 2))
  console.log()

  await cf(`/zones/${zone.id}/settings/always_use_https`, {
    method: "PATCH",
    body: JSON.stringify(httpsBody),
  })
  await cf(`/zones/${zone.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, {
    method: "PUT",
    body: JSON.stringify(rulesetBody),
  })

  console.log(`✅ 已应用。读回验证：\n`)
  const httpsAfter = await cf(`/zones/${zone.id}/settings/always_use_https`)
  console.log(`Always Use HTTPS   ${isAlwaysUseHttpsOn(httpsAfter) ? "✅ on" : "❌ off"}`)
  const rulesetAfter = await cf(`/zones/${zone.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`)
  console.log(`dynamic redirect ruleset   ${rulesetAfter.rules?.length || 0} 条规则：`)
  for (const r of rulesetAfter.rules || []) {
    console.log(`  - ${r.description || "(无)"}: ${r.expression}`)
  }
}

function usage(toStderr) {
  const out = toStderr ? console.error : console.log
  out(`用法: cf-zone-setup.mjs <status|create|check-redirects|apply-redirects> <domain> [--to <www|apex>]

  status <domain>                查询是否已加入账号，打印 zone 状态与 NS
  create <domain>                创建 zone 并读回 NS
  check-redirects <domain>       只读核验 Always Use HTTPS 与 dynamic redirect ruleset 现状
  apply-redirects <domain> --to <www|apex>
                                  写操作，立刻生效：打开 Always Use HTTPS，并建一条一跳
                                  到位的 301 重定向规则。--to apex 把 www 收敛到裸域，
                                  --to www 收敛到 www 子域。必须显式指定，没有默认值。`)
}

async function main() {
  const argv = process.argv.slice(2)
  const [cmd, domain] = argv
  const askedForHelp = argv.some((a) => a === "-h" || a === "--help")
  if (askedForHelp || !cmd || !domain) {
    // 显式 `--help` 是成功，退出码 0；什么都不给才是用法错误。
    usage(!askedForHelp)
    process.exit(askedForHelp ? 0 : 2)
  }

  if (cmd === "check-redirects") {
    await doCheckRedirects(domain)
    return
  }
  if (cmd === "apply-redirects") {
    const toIdx = argv.indexOf("--to")
    const direction = toIdx >= 0 ? argv[toIdx + 1] : undefined
    await doApplyRedirects(domain, direction)
    return
  }

  const found = await cf(`/zones?name=${encodeURIComponent(domain)}`)
  if (found.length) {
    console.log(`zone 已存在，直接读回：\n`)
    reportZone(found[0])
    process.exit(0)
  }
  if (cmd === "status") {
    console.log(`${domain} 尚未加入这个 Cloudflare 账号。跑 create 加进去。`)
    process.exit(0)
  }

  let accountId
  try {
    accountId = await resolveCfAccountId({ headers: authHeaders() })
  } catch (e) {
    if (e instanceof CfAuthError) {
      console.error(e.message)
      process.exit(2)
    }
    throw e
  }

  const zone = await cf("/zones", {
    method: "POST",
    body: JSON.stringify({ account: { id: accountId }, name: domain, type: "full" }),
  })
  console.log(`✅ 已创建 zone\n`)
  reportZone(zone)
}

// argv[1] 保留调用时写的路径，import.meta.url 已经过符号链接解析——两边取真实路径
// 再比较，同 cf-analytics-setup.mjs 的 invokedAsScript()，让测试可以只 import 纯函数
// （buildWwwToApexRedirectRule / isAlwaysUseHttpsOn）而不触发真的网络请求。
async function invokedAsScript() {
  if (process.argv[1] === undefined) return false
  try {
    const resolved = await realpath(path.resolve(process.argv[1]))
    return pathToFileURL(resolved).href === import.meta.url
  } catch {
    return false
  }
}

if (await invokedAsScript()) {
  await main()
}
