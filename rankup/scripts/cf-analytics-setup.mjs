#!/usr/bin/env node
/**
 * Cloudflare Web Analytics（RUM）接入。
 *
 * 用法：
 *   node <rankup-skill-dir>/scripts/cf-analytics-setup.mjs status <domain>
 *   node <rankup-skill-dir>/scripts/cf-analytics-setup.mjs enable <domain>
 *   node <rankup-skill-dir>/scripts/cf-analytics-setup.mjs verify <domain>
 *
 * 站点由 Cloudflare 代理时可以用 auto_install：beacon 由边缘在 HTML 响应经过时注入，
 * 不需要改代码、不需要发版。Workers custom domain 本身就是代理态，满足条件。
 *
 * 【实测，多站复现，2026-09-12】auto_install 默认必须关闭：边缘在每次响应上注入 beacon
 * 会绕过代码里的任何延迟加载逻辑，beacon 请求（/cdn-cgi/rum）因此成为最长关键请求链之一，
 * 与「第三方分析脚本一律延迟到首次交互或 6s 兜底再加载」的硬规则冲突。本脚本 enable 默认
 * 以 auto_install: false 创建站点记录，改由代码延迟注入 beacon；status 对已存在且
 * auto_install 为 true 的站点会打印告警。
 *
 * ── verify：只读核验，抓真实项目踩过的两个坑（2026-09-13 新增）───────
 *
 * 真实项目复盘过两次「接了但没生效」，都不会让任何东西变红：
 *   1. **token 不一致**：代码里手嵌的 `data-cf-beacon` token 与 CF 后台该站
 *      实际的 `site_token` 对不上——beacon 脚本照样 200 加载、控制台照样绿，
 *      数据只是流进了别的 site。`site_tag` 与 `site_token` 同形（都是 32 位
 *      hex），把 token 填成 tag 也是这个症状的一种。
 *   2. **auto_install 与手嵌脚本同时存在**：zone 上 `auto_install=true`，
 *      边缘已经在每次响应上自动注入 beacon，代码里又手嵌了一份延迟加载的
 *      snippet——两份 beacon 同时打点，GraphQL `count > 0` 反而把这个问题
 *      掩盖掉（有数据 ≠ 接入方式正确），而边缘注入那份完全绕过了「首次交互
 *      或 6s 兜底」的延迟加载设计。
 * `verify` 三件事都做：(a) 从 CF API 取 `site_tag`/`site_token`/`auto_install`；
 * (b) `fetch` 线上 HTML，用 `extractCfBeaconTokens` 抠出所有 `data-cf-beacon`
 * 附近的 token；(c) 查 GraphQL `rumPageloadEventsAdaptiveGroups` 近 7 天 count。
 * 三者交叉出「token 一致吗」「是不是重复注入」「beacon 是不是干脆缺失」三条
 * 判定，count 只作参考，**不能单独当接通的证据**（两份 beacon 同时打点时
 * count 一样 > 0）。全程只读，不改任何 CF 配置。
 *
 * 【实测，2026-09-13，真实项目复盘】`extractCfBeaconTokens` 最初只认标准 CF
 * 静态 snippet 形态 `data-cf-beacon="..."`，认不出「统一延迟加载器里用 JS
 * `setAttribute('data-cf-beacon', ...)` 动态注入」这种同样常见的写法，会对
 * 这类项目误判「线上找不到任何手嵌 beacon」——**已修**：判据改成「`data-cf-beacon`
 * 出现之后、下一个语法收尾符号之前的窗口里找 32 位十六进制 token」，不再
 * 关心具体是哪种 JS/HTML 语法把它写出来的（函数细节见该函数自己的注释）。
 *
 * 规范（同步进 references/analytics-platforms.md「CF WA」节，两处不得各存一份）：
 * **`auto_install=false` + 手嵌 beacon 放进站点统一的延迟加载器 + token 只从
 * API 或页面 DOM 取，不手抄，不并存两条注入路径。**
 *
 * 【已知现象，非配置错误，2026-09-13 两个真实站点复现】同一个自动化环境
 * （本机 opencli/Chrome 或 Google 自己的 PageSpeed 服务端）短时间内对同一 URL
 * 重复访问几次之后，`/cdn-cgi/rum` 上报请求会从 `204` 转 `404`，导致 Lighthouse
 * best-practices 审计偶尔从 100 掉到 96（拍到一条同源 404）。怀疑是 Cloudflare
 * 对自动化/机器人特征流量的限流或反刷量机制——真实用户一次会话通常只加载一次，
 * 不会触发这个模式。验收时看**第一次**干净加载是不是 204，别被这类偶发 404
 * 带偏去重查 token/auto_install 配置本身。
 *
 * 【留给未来：给已存在的 site_info 记录改 auto_install】本脚本目前只有创建
 * （`enable`，新建时就是 `auto_install:false`），没有针对已存在记录去改
 * `auto_install` 的写路径；真要加，PUT 到 `/rum/site_info/<site_tag>`，
 * **body 只需要 `{"auto_install": false}`**——site_tag 已经在 URL 路径里了，
 * 模仿 `enable` 那个 POST 端点的 body 形态多带一个 `zone_tag` 会被 CF 拒绝，
 * 报 `HTTP 400: 10004 web_analytics.configuration.api.malformedParams`
 * （2026-09-13 真实项目踩过一次）。
 *
 * 凭据：只从环境变量 CLOUDFLARE_API_TOKEN 读，读不到就退到 <repo>/.cf-token
 * （该文件已被 .gitignore 排除）。真实值不打印、不落盘、不进日志。
 *
 * 需要的权限：Account > Account Analytics > Edit（RUM）+ Zone > Zone > Read。
 * 不要用 Global API Key：它不能限定 scope，泄露即等于整个账号。
 *
 * 已验证：2026-08-21；auto_install 默认关闭复验：2026-09-12；
 * verify 三件套（token 比对 / 重复注入判定 / GraphQL count）：2026-09-13
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const API = "https://api.cloudflare.com/client/v4"

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim()
  const f = join(process.cwd(), ".cf-token")
  if (existsSync(f)) return readFileSync(f, "utf8").trim()
  console.error(`找不到 API token。二选一：
  export CLOUDFLARE_API_TOKEN=...        （当前 shell 有效）
  echo '...' > .cf-token                 （已 gitignore）

token 在 dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom：
  权限  Zone > Zone > Edit
  范围  Zone Resources = All zones      ← 必须 All zones，不能选具体某个 zone
不要用 Global API Key。`)
  process.exit(2)
}

/**
 * 两种凭据的 header 完全不同，认错会得到一个极具误导性的
 * `6003 Invalid request headers`（看着像请求写错了，其实是凭据类型不匹配）：
 *   - API Token（40 字符）  → Authorization: Bearer <token>
 *   - Global API Key（37 字符）→ X-Auth-Email + X-Auth-Key，还必须带账号邮箱
 * 按长度判别，并允许 CLOUDFLARE_EMAIL 覆盖。
 */
function authHeaders() {
  const t = token()
  if (t.length === 37 && /^[0-9a-f]+$/.test(t)) {
    const email = process.env.CLOUDFLARE_EMAIL
    if (!email) {
      console.error(`检测到 Global API Key。它必须配合账号邮箱使用：
  export CLOUDFLARE_EMAIL=你的Cloudflare账号邮箱

强烈建议改用 scoped API Token（Zone>Zone>Edit，范围 All zones）：
Global Key 不能限定范围，泄露即等于整个账号。`)
      process.exit(2)
    }
    return { "X-Auth-Email": email, "X-Auth-Key": t }
  }
  return { Authorization: `Bearer ${t}` }
}

async function cf(path_, init = {}) {
  const r = await fetch(`${API}${path_}`, {
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
    throw new Error(`${init.method || "GET"} ${path_} → HTTP ${r.status}: ${msg || "未知错误"}`)
  }
  return j.result
}

/**
 * GraphQL 走同一个 API host 的 /graphql 端点，鉴权与 REST 端点一致。
 * `errors` 数组存在时 GraphQL 惯例是仍然 200，所以不能只看 HTTP 状态。
 */
async function cfGraphQL(query, variables) {
  const r = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  const j = await r.json().catch(() => ({}))
  if (j.errors?.length) {
    throw new Error(j.errors.map((e) => e.message).join("; "))
  }
  return j.data
}

async function rumPageloadCount(accountId, siteTag, sinceIso) {
  const data = await cfGraphQL(
    `query ($accountTag: string!, $siteTag: string!, $since: string!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          rumPageloadEventsAdaptiveGroups(filter: { siteTag: $siteTag, date_geq: $since }, limit: 1) {
            count
          }
        }
      }
    }`,
    { accountTag: accountId, siteTag, since: sinceIso },
  )
  const count = data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups?.[0]?.count
  return typeof count === "number" ? count : null
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


function reportSite(s) {
  console.log(`site tag     ${s.site_tag}   （这是查询/面板用的 ID，不是 beacon 里的 token）`)
  console.log(`site token   ${s.site_token || "(API 未返回，去面板取 snippet)"}   ← 手动嵌 beacon 时只能用这个`)
  console.log(`auto_install ${s.auto_install}`)
  console.log(`zone         ${s.ruleset?.zone_name || "(未绑定 zone)"}`)
  console.log(`规则启用     ${s.ruleset?.enabled}`)
  if (s.snippet) console.log(`snippet      ${s.snippet}`)
  if (!s.auto_install) {
    console.log(`\n✅ auto_install 已关闭（这是期望状态）—— 手动把上面的 snippet 嵌进页面，`)
    console.log(`   延迟到首次交互或 6s 兜底再注入，data-cf-beacon 里填 site_token，不是 site_tag。`)
    console.log(`   两个都是 32 位十六进制，填错不报错、beacon 照样 200，只是永远 0 数据。`)
  } else {
    console.log(`\n⚠️ auto_install 为 true —— 边缘会在每次响应上自动注入 beacon，绕过代码里`)
    console.log(`   任何延迟加载逻辑，/cdn-cgi/rum 会成为最长关键请求链之一。`)
    console.log(`   【实测，多站复现】应改为手动嵌 snippet 并关闭 auto_install，去 Cloudflare`)
    console.log(`   Dashboard 的 Web Analytics 设置里关掉，或删除后用本脚本 enable 重建`)
    console.log(`   （enable 默认创建时就是 auto_install: false）。`)
  }
  console.log(`\n验收不能停在「HTML 里有 cloudflareinsights」。用 GraphQL 查 count，`)
  console.log(`  或直接跑 \`cf-analytics-setup.mjs verify <domain>\` 做三件套核验：`)
  console.log(`  rumPageloadEventsAdaptiveGroups(filter:{siteTag:"${s.site_tag}", date_geq:"<7 天前>"}) { count }`)
  console.log(`  上线后一天仍是 [] 就是 token 填错或注入没生效。`)
}

/* ── 纯函数：token 抠取与三件套判定（可脱离网络单测） ──────────── */

/**
 * 从线上 HTML 里抠出所有 `data-cf-beacon` 出现处附带的 token。
 *
 * 【实测，2026-09-13，真实项目复盘】早期版本只认标准 CF 静态 snippet 形态
 * `data-cf-beacon="..."`（HTML 属性赋值），认不出「统一延迟加载器里用 JS
 * `setAttribute('data-cf-beacon', '{"token":...}')` 动态注入」这种同样常见的写法——
 * 两者字符串里都有 `data-cf-beacon`，但一个后面跟 `=`，一个后面跟函数调用的逗号，
 * 正则字面量匹配不上。对这类项目跑旧版会得到假阴性「线上找不到任何手嵌 beacon」，
 * 即使 beacon 其实工作正常（`/cdn-cgi/rum` 也真的发出去了）。
 *
 * 现在的判据不再纠结「这段代码长什么语法形状」，只认**事实**：不管是静态属性、
 * `setAttribute()` 调用参数、还是字符串拼接拼出来的 JSON，CF 的 token 本身
 * 固定是 32 位十六进制——`data-cf-beacon` 出现之后，到下一个语法收尾符号
 * （`>` 收静态属性、`)` 收函数调用，取先出现的那个）之间的窗口里找这个形状，
 * 三种写法通吃。解析不出十六进制 token 的片段不丢弃——记一条 `UNPARSED:`
 * 前缀的原始片段，让「抓到了但读不出 token」和「压根没有这个属性」在返回值里
 * 可分辨，不静默合并成同一个「没有」。
 */
export function extractCfBeaconTokens(html) {
  const text = String(html || "")
  const tokens = []
  const anchorRe = /data-cf-beacon/gi
  let m
  while ((m = anchorRe.exec(text))) {
    const rest = text.slice(m.index, m.index + 500)
    const gt = rest.indexOf(">")
    const paren = rest.indexOf(")")
    const closers = [gt, paren].filter((i) => i >= 0)
    const closeIdx = closers.length ? Math.min(...closers) : rest.length - 1
    const windowText = rest.slice(0, closeIdx + 1)
    const hex = windowText.match(/\b[a-f0-9]{32}\b/i)
    if (hex) tokens.push(hex[0].toLowerCase())
    else tokens.push(`UNPARSED:${windowText.slice(0, 80)}`)
  }
  return tokens
}

/**
 * 三件套判定：token 是否一致、是否重复注入、beacon 是否干脆缺失。
 * 纯函数，不碰网络——三个输入都是调用方已经取到的事实。
 */
export function diagnoseCfWebAnalytics({ siteToken, autoInstall, tokensInHtml }) {
  const validTokens = (tokensInHtml || []).filter((t) => !t.startsWith("UNPARSED:"))
  const tokenKnown = Boolean(siteToken)
  // 大小写不敏感比较：token 本身是十六进制,写法上大小写不该影响"是不是同一个值"的判断。
  const normalized = (s) => String(s || "").toLowerCase()
  const tokenMismatch =
    tokenKnown && validTokens.length > 0 && !validTokens.map(normalized).includes(normalized(siteToken))
  const duplicateInjection = Boolean(autoInstall) && (tokensInHtml || []).length > 0
  const noBeaconFound = (tokensInHtml || []).length === 0 && !autoInstall
  const ok = !tokenMismatch && !duplicateInjection && !noBeaconFound
  return { ok, tokenKnown, tokenMismatch, duplicateInjection, noBeaconFound, validTokens }
}

/* ── 命令 ─────────────────────────────────────────────────── */

async function findSite(domain) {
  const zones = await cf(`/zones?name=${encodeURIComponent(domain)}`)
  if (!zones.length) throw new Error(`${domain} 不在这个账号里，先跑 cf-zone-setup.mjs create`)
  const zone = zones[0]

  const accounts = await cf("/accounts")
  const accountId = process.env.CF_ACCOUNT_ID || accounts[0].id

  // 必须分页：默认每页 10 条，账号站点一多就会把已存在的条目判成「不存在」而重复创建。
  const existing = await cf(`/accounts/${accountId}/rum/site_info/list?per_page=100`)
  const hit = (existing || []).find((s) => s.ruleset?.zone_tag === zone.id)
  return { zone, accountId, site: hit }
}

async function doStatusOrEnable(cmd, domain) {
  const { zone, accountId, site: hit } = await findSite(domain)
  if (hit) {
    console.log(`Web Analytics 已启用：\n`)
    reportSite(hit)
    return
  }
  if (cmd === "status") {
    console.log(`${domain} 尚未启用 Web Analytics。跑 enable 开启。`)
    return
  }

  // auto_install 默认 false：【实测，多站复现】边缘自动注入的 beacon 会绕过代码里的延迟
  // 加载逻辑，成为最长关键请求链之一。需要手动把 snippet 写进页面，延迟到首次交互或 6s
  // 兜底后注入，见 references/analytics-platforms.md「CF WA」节。
  const site = await cf(`/accounts/${accountId}/rum/site_info`, {
    method: "POST",
    body: JSON.stringify({ zone_tag: zone.id, auto_install: false }),
  })
  console.log(`✅ 已启用 Web Analytics（auto_install: false，需手动嵌延迟加载的 snippet）\n`)
  reportSite(site)
}

/** verify：只读三件套核验，不改任何 CF 配置。 */
async function doVerify(domain) {
  const { accountId, site: hit } = await findSite(domain)
  if (!hit) {
    console.log(`${domain} 尚未启用 Web Analytics，无法 verify。先跑 enable。`)
    process.exitCode = 1
    return
  }

  const url = `https://${domain}`
  let html = ""
  try {
    const r = await fetch(url, { redirect: "follow" })
    html = await r.text()
  } catch (e) {
    console.error(`抓取线上 HTML 失败（${url}）：${e.message}`)
    process.exitCode = 1
    return
  }

  const tokensInHtml = extractCfBeaconTokens(html)
  const diag = diagnoseCfWebAnalytics({
    siteToken: hit.site_token,
    autoInstall: hit.auto_install,
    tokensInHtml,
  })

  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  let count = null
  let countError = null
  try {
    count = await rumPageloadCount(accountId, hit.site_tag, since)
  } catch (e) {
    countError = e.message
  }

  console.log(`── Cloudflare Web Analytics 只读核验：${domain} ──`)
  console.log(`site tag        ${hit.site_tag}`)
  console.log(`site token(API) ${hit.site_token || "(API 未返回——只能人工去面板 Web Analytics 设置页核对)"}`)
  console.log(`auto_install    ${hit.auto_install}`)
  console.log(
    `线上 HTML 里的 data-cf-beacon token  ${tokensInHtml.length ? tokensInHtml.join(", ") : "(未找到)"}`,
  )
  console.log()
  if (!diag.tokenKnown) {
    console.log(`token 一致：（API 没返回 site_token，无法自动比对，人工去 Web Analytics 设置页核对）`)
  } else {
    console.log(
      diag.tokenMismatch
        ? `token 一致：❌ 不一致——线上手嵌的 token 与后台 site_token 对不上，这份 beacon 的数据流进了别的 site`
        : diag.validTokens.length
          ? `token 一致：✅`
          : `token 一致：（线上没有手嵌脚本，无从比对）`,
    )
  }
  console.log(
    diag.duplicateInjection
      ? `重复注入：❌ auto_install=true 的同时线上还有手嵌 beacon——边缘自动注入会绕过代码里` +
          `「首次交互或 6s 兜底」的延迟加载逻辑，两条注入路径不该同时存在`
      : `重复注入：✅ 没有同时出现`,
  )
  console.log(
    diag.noBeaconFound
      ? `beacon 缺失：❌ auto_install=false 且线上找不到任何手嵌 beacon——等于没接`
      : `beacon 缺失：✅`,
  )
  console.log()
  console.log(`GraphQL 近 7 天 pageload 数：${count === null ? `取不到（${countError}）` : count}`)
  console.log(
    `  count > 0 不能单独当「接通」的证据——两条注入路径同时打点时 count 一样 > 0，`,
  )
  console.log(`  掩盖的正是「重复注入」这个问题；判定以上面三行 ✅/❌ 为准，count 只作参考。`)

  console.log()
  if (!diag.ok) {
    console.log(`结论：这个站的 CF Web Analytics 接入有问题，见上面标 ❌ 的行。`)
    console.log(
      `规范做法：auto_install=false + 手嵌 beacon 放进站点统一的延迟加载器 + token 只从` +
        ` API 或页面 DOM 取，不手抄、不并存两条注入路径。`,
    )
    process.exitCode = 1
  } else {
    console.log(`结论：token 一致、没有重复注入、beacon 确实存在——接入方式正常。`)
  }
}

function usage() {
  console.log(`用法: cf-analytics-setup.mjs <status|enable|verify> <domain>

  status <domain>   查询是否已启用，打印 site_tag/site_token/auto_install
  enable <domain>   启用（auto_install 默认 false，需手动嵌延迟加载的 snippet）
  verify <domain>   只读核验：抓线上 HTML 比对 data-cf-beacon token、判断是否与
                    auto_install 重复注入、查 GraphQL 近 7 天 pageload 数`)
}

async function main() {
  const [cmd, domain] = process.argv.slice(2)
  const askedForHelp = process.argv.slice(2).some((a) => a === "-h" || a === "--help")
  if (askedForHelp || !cmd || !domain) {
    // 显式 `--help` 是成功，退出码 0；什么都不给才是用法错误。
    if (askedForHelp) {
      usage()
      process.exit(0)
    }
    usage()
    process.exit(2)
  }
  if (!["status", "enable", "verify"].includes(cmd)) {
    usage()
    process.exit(2)
  }

  if (cmd === "verify") await doVerify(domain)
  else await doStatusOrEnable(cmd, domain)
}

// argv[1] 保留调用时写的路径，import.meta.url 已经过符号链接解析——两边取真实路径
// 再比较，同 check-version.mjs 的 invokedAsScript()，让测试可以只 import 纯函数
// （extractCfBeaconTokens / diagnoseCfWebAnalytics）而不触发真的网络请求。
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
