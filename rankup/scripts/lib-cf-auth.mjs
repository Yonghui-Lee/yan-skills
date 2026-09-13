#!/usr/bin/env node
/**
 * lib-cf-auth.mjs —— Cloudflare 凭据解析，扁平命名沿用 lib-scene.mjs 的风格
 * （本目录没有 lib/ 子目录，公共文件直接放 scripts/ 下）。
 *
 * 背景（2026-09-13）：rankup/scripts/ 下 cf-zone-setup.mjs、cf-analytics-setup.mjs、
 * cf-agent-baseline.mjs、cf-builds-connect.mjs、yandex-setup.mjs 各自手搓了一份
 * 「读环境变量拼 Cloudflare 请求头」的逻辑，读的变量名却不统一——有的只认
 * `CLOUDFLARE_API_TOKEN`，有的还认 `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY`，
 * 而本机 skill 实际配置用的是 `CF_EMAIL` + `CF_GLOBAL_KEY` 这套简写。结果同一台
 * 机器上凭据明明配好了，部分脚本读得到、部分读不到，报错还都在教人去设一个
 * 已经设好的变量。本文件把这份解析收敛成一处。
 *
 * 五份脚本手搓实现分别只服务 1-2 个调用点时，discipline.md 二「先查脚本清单，
 * 禁止重造轮子」判定两处几十行的重复优于共享文件更省心；但涨到 5 处、且分歧
 * 本身就是这次要修的 bug 时，继续各自为政的成本已经反过来更高——这次收敛是
 * 认定条件变化后的例外，不是推翻二节的一般判断。
 *
 * ── 解析优先级（同时设置多个时，谁赢已经写死，不取决于调用顺序）──────────
 *
 *   1. API Token 方式（推荐，可限定权限范围）：
 *      `CLOUDFLARE_API_TOKEN` 优先于 `CF_API_TOKEN`。
 *      —— `CLOUDFLARE_*` 是这个仓库里其余文档/脚本出现更早、更多的写法，
 *      两者都设置时保留这个既有默认；`CF_API_TOKEN` 只是新增的别名，不反客为主。
 *   2. 都没有 → 退到 Global API Key 方式（全账号权限，不能限定范围，只在没有
 *      scoped token 时用）：
 *        email：`CF_EMAIL` 或 `CLOUDFLARE_EMAIL`
 *        key：  `CF_GLOBAL_KEY` 或 `CLOUDFLARE_API_KEY`
 *      每一对内部同样 `CLOUDFLARE_*` 优先，与①保持同一条规则，不搞两套判断。
 *      email 与 key 必须成对出现，只给一半按「不完整」处理，报错里会点出缺的
 *      是哪一个。
 *   3. 两条路都凑不齐 → 抛 `CfAuthError`，消息里列出全部可接受的环境变量名与
 *      搭配关系（不是甩一串变量名让人猜怎么配对）。
 *
 * ── 不做的事 ──────────────────────────────────────────────────
 *
 * 不读任何 `.cf-token` 文件、不读 Skill 的 `.env`、不猜"某个值长得像不像
 * Global Key"（旧版按 37 位十六进制长度猜，猜错的后果是拿 Global Key 走
 * Bearer，得到一个极具误导性的 `6003`/`6111` 报错，看着像请求写错了）。这些
 * 属于各脚本自己的取值来源（项目本地文件、Skill 内配置、CLI 参数），由调用方
 * 在调用前自己按"环境变量优先、这些兜底源更低优先级"拼出 `token`/`email`/
 * `key` 的 override 值传进来——见下方 `resolveCfAuth` 的参数说明，以及
 * cf-zone-setup.mjs / cf-agent-baseline.mjs 里 `.cf-token` / Skill `.env` /
 * wrangler token 兜底的具体用法。
 *
 * 真实凭据值本文件不打印、不落盘、不进日志——只往外传，从不主动输出。
 */

/** 跳过 undefined/null/空白字符串，返回第一个非空的 trim 结果；否则 undefined。 */
function firstNonEmpty(...values) {
  for (const v of values) {
    if (v === undefined || v === null) continue
    const s = String(v).trim()
    if (s) return s
  }
  return undefined
}

/** Cloudflare 凭据解析失败时抛出的错误类型，方便调用方 `instanceof` 判断。 */
export class CfAuthError extends Error {
  constructor(message) {
    super(message)
    this.name = "CfAuthError"
  }
}

/**
 * 列出全部可接受的环境变量名及搭配关系。供 `resolveCfAuth` 的报错文案复用，
 * 也可以被脚本自己的 `--help`/用法说明引用，避免各写一份、措辞早晚对不上。
 */
export function cfAuthEnvHelp() {
  return [
    `Cloudflare 凭据可接受下面两种方式之一（凑齐其中一种即可，不需要两种都配）：`,
    ``,
    `  方式一 · API Token（推荐，可限定权限范围）：`,
    `    CLOUDFLARE_API_TOKEN=...     或   CF_API_TOKEN=...`,
    `    （两者都设置时，CLOUDFLARE_API_TOKEN 优先）`,
    ``,
    `  方式二 · Global API Key（全账号权限，不能限定范围；email 与 key 必须成对出现）：`,
    `    CF_EMAIL=...  +  CF_GLOBAL_KEY=...`,
    `    或`,
    `    CLOUDFLARE_EMAIL=...  +  CLOUDFLARE_API_KEY=...`,
    `    （每一对内部同样 CLOUDFLARE_* 优先；email 和 key 只设置了一个视为不完整）`,
  ].join("\n")
}

/**
 * 解析 Cloudflare 凭据，返回可以直接展开进 `fetch` headers 的对象。
 *
 * 用法（替换掉脚本里手写的 `authHeaders()`）：
 *   import { cfAuthHeaders } from "./lib-cf-auth.mjs"
 *   const res = await fetch(url, { headers: { ...cfAuthHeaders(), "Content-Type": "application/json" } })
 *
 * 需要知道走的是哪种凭据（比如按凭据类型分流报错文案，见 cf-agent-baseline.mjs
 * 对 Radar 报错码的处理）时改用本函数 `resolveCfAuth`，读 `.method`。
 *
 * @param {object} [overrides]
 * @param {string} [overrides.token]  显式传入的 API Token，优先于环境变量——
 *   调用方自己从 CLI 参数、`.cf-token` 文件等来源取到的值放这里；不传、或传
 *   空字符串/undefined 时才会去看 `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN`。
 * @param {string} [overrides.email] 显式传入的账号邮箱，优先于环境变量，语义同上。
 * @param {string} [overrides.key]   显式传入的 Global API Key，优先于环境变量，语义同上。
 * @param {NodeJS.ProcessEnv} [overrides.env]  环境变量来源，默认 `process.env`；
 *   单元测试传一个假的 map 进来，不需要真的读写 `process.env`。
 * @returns {{ method: "token"|"global-key", headers: Record<string,string> }}
 * @throws {CfAuthError} 两种方式都凑不齐时——message 里列出全部可接受的环境变量名。
 */
export function resolveCfAuth({ token, email, key, env = process.env } = {}) {
  const apiToken = firstNonEmpty(token, env.CLOUDFLARE_API_TOKEN, env.CF_API_TOKEN)
  if (apiToken) {
    return { method: "token", headers: { Authorization: `Bearer ${apiToken}` } }
  }

  const authEmail = firstNonEmpty(email, env.CLOUDFLARE_EMAIL, env.CF_EMAIL)
  const authKey = firstNonEmpty(key, env.CLOUDFLARE_API_KEY, env.CF_GLOBAL_KEY)
  if (authEmail && authKey) {
    return { method: "global-key", headers: { "X-Auth-Email": authEmail, "X-Auth-Key": authKey } }
  }

  const hints = []
  if (authEmail && !authKey) hints.push(`已经读到 email，但缺 key：CF_GLOBAL_KEY 或 CLOUDFLARE_API_KEY。`)
  if (authKey && !authEmail) hints.push(`已经读到 key，但缺 email：CF_EMAIL 或 CLOUDFLARE_EMAIL。`)
  const hintText = hints.length ? `\n\n${hints.join("\n")}` : ""

  throw new CfAuthError(`找不到可用的 Cloudflare 凭据。\n\n${cfAuthEnvHelp()}${hintText}`)
}

/**
 * 语法糖：多数脚本只关心 headers、不需要 method，直接
 * `headers: { ...cfAuthHeaders(), ... }` 替换掉原来手写的 `authHeaders()`。
 * 抛错行为与 `resolveCfAuth` 完全一致（本函数不吞异常）。
 */
export function cfAuthHeaders(overrides) {
  return resolveCfAuth(overrides).headers
}
