#!/usr/bin/env node
/**
 * Cloudflare Radar「AI Agent Readiness」全网基线 —— 给单站分数配一个分母。
 *
 * 这不是站点扫描器。这个端点没有 `url` 参数，返回的是「全网抽样域名里
 * 有百分之多少通过每一项检查」的聚合统计，不针对任何具体网站。想扫单个
 * 站点用 scripts/is-agentic.mjs。
 *
 * 为什么需要它：is-agentic.mjs 给单站打分，报告里会出现「高级集成 0/8」
 * 这种读起来像缺陷的行。没有分母就没法判断这到底是「你没做」还是
 * 「全网基本没人做」。这份基线告诉你：webMcp 通过率是 0/107985——
 * 一个都没有。追一项全网 0.3% 都不到的检查，价值几乎总是低于它挤占的工作。
 *
 * 认证：**不是零配置**（2026-08-23 订正，原文这么写过，是错的）。凭据解析
 * 统一走 ./lib-cf-auth.mjs 的 resolveCfAuth（2026-09-13 收敛，历史原因见该
 * 文件头注释），按以下顺序取值，每一层给出的值都优先于下一层：
 *   1. --token / --email 命令行参数
 *   2. 环境变量：CLOUDFLARE_API_TOKEN 或 CF_API_TOKEN（API Token 方式）；
 *      CF_EMAIL/CLOUDFLARE_EMAIL 配 CF_GLOBAL_KEY/CLOUDFLARE_API_KEY（Global Key
 *      方式，email 与 key 必须成对出现）
 *   3. 本 Skill 根目录 .env 里的同名变量
 *   4. 本机 wrangler OAuth token（只能当 API Token 用）—— **多数情况下这条走不通**，见下。
 * 不读任何项目内的凭据文件（如 <repo>/.cf-token）：本 Skill 必须项目中立，不能写死别人仓库的落点。
 *
 * **两种凭据格式的 header 完全不同，认错会得到极具误导性的报错。** resolveCfAuth
 * 按「有没有凑出一对完整的 email+key」判断该走哪条路，不再猜某个字符串长得
 * 像不像 Global Key（旧版按 37 位十六进制长度猜，猜错的代价是拿 Global Key
 * 走 Bearer）：
 *   - Global API Key → `X-Auth-Email` + `X-Auth-Key` 两个头，email 与 key 必须
 *     成对配置。**它能调 Radar**（2026-08-31 实测 success:true）。用 Bearer
 *     发它会回 `[6111] Invalid format for Authorization header`——那不是
 *     「权限不够」，是 header 用错了，去建新 token 是白费一步。
 *   - API Token → `Authorization: Bearer <token>`，需带 Radar:Read。
 * Global Key 是全账号权限、不能限定范围，泄露即等于整个账号；能用 scoped token
 * 就用 scoped token。但**用户手上已有 Global Key 时不必再去新建一枚**。
 *
 * **wrangler 的 OAuth 凭据通常不能调 Radar。** 它的 scopes 是围绕部署发的
 * （workers:*、d1、pages、zone:read…），里面**没有 Radar 相关的 scope**，
 * 而 Radar 需要一枚带 `Radar:Read` 的 API token。实测现象极具误导性：
 * 接口回的是 `[10000] Authentication error`，读起来像「token 过期了」，
 * 于是人会去重新 `wrangler login` —— 登多少次都没用，因为缺的是权限面不是新鲜度。
 * 判据：拿同一枚 token 打 `/user/tokens/verify`，
 *   - 回 `[1000] Invalid API Token` → 这枚 OAuth token 确实失效/不被当作 API token；
 *   - 回成功但 Radar 仍 10000 → 是 scope 不够。
 * 两种都要靠**新建一枚带 Radar:Read 的 API token**解决，而不是重登 wrangler。
 *
 * token 只用于发起请求，绝不打印、绝不写入任何输出文件、绝不提交。
 *
 * 已验证：2026-08-22，实测调用 https://api.cloudflare.com/client/v4/radar/
 * agent_readiness/summary/CHECK 成功，返回 2026-08-17 数据（107985/160188
 * 个域名扫描成功）。这份数字会漂移，不要凭记忆引用，重新拉一次。
 *
 * 用法：
 *   node cf-agent-baseline.mjs [fetch]                    拉基线，按通过率排序打印
 *   node cf-agent-baseline.mjs fetch --save                同上，并存入 .rankup/agentic/baseline/<date>.json
 *   node cf-agent-baseline.mjs fetch --category <name>     按 domainCategory 过滤
 *   node cf-agent-baseline.mjs fetch --json                原始 JSON，供管道使用
 *   node cf-agent-baseline.mjs --compare <scan.json>       对照 is-agentic.mjs 存下的单站扫描，
 *                                                           把失败项和全网通过率并排显示
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveCfAuth } from "./lib-cf-auth.mjs";

const API = "https://api.cloudflare.com/client/v4/radar/agent_readiness/summary/CHECK";
const UA = "rankup-skill/1.0 (+cf-agent-baseline.mjs)";

// 中文名只用于打印，不参与比对逻辑。
const CHECK_LABELS = {
  robotsTxt: "robots.txt 存在",
  robotsTxtAiRules: "robots.txt 含 AI 爬虫规则",
  sitemap: "sitemap 存在",
  markdownNegotiation: "Markdown 内容协商（Accept: text/markdown）",
  oauthDiscovery: "OAuth Discovery",
  linkHeaders: "HTTP Link 头（RFC 8288）",
  oauthProtectedResource: "OAuth Protected Resource",
  ucp: "UCP（Unified Commerce Protocol）",
  contentSignals: "Content Signals",
  apiCatalog: "API Catalog",
  agentSkills: "Agent Skills",
  mcpServerCard: "MCP Server Card",
  webBotAuth: "Web Bot Auth",
  a2aAgentCard: "A2A Agent Card",
  acp: "ACP（Agentic Commerce Protocol）",
  mpp: "MPP",
  x402: "x402",
  ap2: "AP2",
  webMcp: "WebMCP",
};

/**
 * is-agentic.mjs 单站扫描 issue.id → 本端点检查项 key 的映射。
 *
 * 只收录「同一个检查行为」的确认对应，不猜、不硬凑。目前只有一条：
 * is-agentic 的 markdown-negotiation-vary 检查的正是 Accept: text/markdown
 * 内容协商 + Vary: Accept 头，与 Radar 的 markdownNegotiation 是同一件事。
 *
 * is-agentic 的其余检查项（404 语义、无 JS 内容、品牌可发现性、
 * agent-instruction 文件措辞、Organization schema 完整度、trust anchor
 * 页面）在这个端点里没有对应的全网统计——Radar 不测这些。不要为了凑数
 * 硬映射，宁可留空。
 */
const ID_MAP = {
  "markdown-negotiation-vary": "markdownNegotiation",
};

// ── 参数解析 ─────────────────────────────────────────────────────────────

function usage() {
  console.log(`用法：
  node cf-agent-baseline.mjs [fetch]                拉全网基线，按通过率排序打印
  node cf-agent-baseline.mjs fetch --save           同上，存入 .rankup/agentic/baseline/<date>.json
  node cf-agent-baseline.mjs fetch --category <name> 按 domainCategory 过滤（有效值见输出中的报错）
  node cf-agent-baseline.mjs fetch --json            原始 JSON（供管道）
  node cf-agent-baseline.mjs --compare <scan.json>   对照 is-agentic.mjs 的单站扫描 JSON，
                                                      把失败/部分通过项和全网通过率并排显示

选项：
  --save            结果写入当前目录下 .rankup/agentic/baseline/<date>.json
  --category <name> 按 domainCategory 过滤（如 Technology）
  --json            原始 JSON 输出
  --token <token>   显式传 API Token（否则按 CLOUDFLARE_API_TOKEN/CF_API_TOKEN 环境变量 →
                    Skill 的 .env → wrangler 配置的顺序找）
  --email <email>   账号邮箱；只有走 Global API Key 方式时需要（也可用环境变量
                    CF_EMAIL/CLOUDFLARE_EMAIL，key 走 CF_GLOBAL_KEY/CLOUDFLARE_API_KEY）
  --project <dir>   项目根目录（默认 cwd），配合 --save 使用
  --help            显示帮助

这不是站点扫描器：这个 Cloudflare Radar 端点没有 url 参数，返回的是全网
抽样统计，不针对任何具体网站。扫单个站点用 scripts/is-agentic.mjs。`);
  process.exit(0);
}

function flagValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

// ── token 解析 ───────────────────────────────────────────────────────────

function findWranglerToken() {
  const candidates = [
    join(homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
    join(homedir(), ".wrangler", "config", "default.toml"),
    join(homedir(), ".config", ".wrangler", "config", "default.toml"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const m = raw.match(/oauth_token\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } catch {
      // 忽略单个候选路径的读取失败，继续尝试下一个
    }
  }
  return null;
}

/**
 * Skill 根目录的 .env（KEY=value，每行一个）。这是本 Skill 唯一允许读的凭据落点，
 * 因为它属于 Skill 自己；**不读任何项目内的路径**（如 <repo>/.cf-token），
 * 那会让这个 Skill 绑死在某个人的仓库布局上，validate-rankup 也会拦。
 */
function fromSkillEnv(key) {
  const envFile = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");
  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* 没有 .env 是正常状态 */
  }
  return null;
}

/**
 * 凭据解析统一走 lib-cf-auth.mjs 的 resolveCfAuth；本函数只负责拼出它需要的
 * override（按「CLI 参数 → 环境变量（两种命名都认）→ Skill 的 .env → wrangler
 * OAuth token」这个本脚本专属的优先级，见文件头部注释），拼好之后交给共享
 * 函数判断该用 API Token 还是 Global API Key、以及两者都凑不齐时怎么报错。
 */
function resolveCredential(args) {
  const explicitToken =
    flagValue(args, "--token") ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CF_API_TOKEN ||
    fromSkillEnv("CLOUDFLARE_API_TOKEN") ||
    fromSkillEnv("CF_API_TOKEN") ||
    findWranglerToken();
  // email/key 的 CLOUDFLARE_*/CF_* 先后顺序必须和 lib-cf-auth.mjs 内部的默认
  // 优先级一致（CLOUDFLARE_* 先）——否则同一台机器上两个变量都设置时，直接调用
  // resolveCfAuth() 和经本函数取值会选中不同的 email/key，行为对不上。
  const explicitEmail =
    flagValue(args, "--email") ||
    process.env.CLOUDFLARE_EMAIL ||
    process.env.CF_EMAIL ||
    fromSkillEnv("CLOUDFLARE_EMAIL") ||
    fromSkillEnv("CF_EMAIL");
  const explicitKey =
    process.env.CLOUDFLARE_API_KEY ||
    process.env.CF_GLOBAL_KEY ||
    fromSkillEnv("CLOUDFLARE_API_KEY") ||
    fromSkillEnv("CF_GLOBAL_KEY");

  try {
    return resolveCfAuth({ token: explicitToken, email: explicitEmail, key: explicitKey });
  } catch (e) {
    console.error(
      `${e.message}\n\n` +
      `本脚本额外支持的取值来源（按优先级，任一层给出的值都先于下一层生效）：\n` +
      `  1. --token / --email 命令行参数\n` +
      `  2. 上面列出的环境变量\n` +
      `  3. 本 Skill 根目录的 .env 里的同名变量\n` +
      `  4. 本机登录过 wrangler（~/.wrangler 或 ~/Library/Preferences/.wrangler 下\n` +
      `     的 config/default.toml 里要有 oauth_token 字段，只能当 API Token 用）——\n` +
      `     **但它多半调不通 Radar**，scopes 里没有 Radar，见文件头部注释。\n\n` +
      `不读任何项目内的凭据文件（如 <repo>/.cf-token）：本 Skill 必须项目中立。`
    );
    process.exit(1);
  }
}

// ── API ──────────────────────────────────────────────────────────────────

async function fetchBaseline(cred, { category } = {}) {
  const url = new URL(API);
  if (category) url.searchParams.set("domainCategory", category);

  const res = await fetch(url, {
    headers: {
      ...cred.headers,
      Accept: "application/json",
      "User-Agent": UA, // 缺这个头会拿到 HTML 错误页而不是 JSON，解析失败还很难定位
    },
  });

  let body;
  try {
    body = await res.json();
  } catch {
    console.error(`响应不是 JSON（HTTP ${res.status}）。多半是缺 User-Agent 或被拦截，脚本已带 UA，检查网络/token。`);
    process.exit(1);
  }

  if (!res.ok || body.success === false) {
    const errs = body.errors || [];
    const codes = new Set(errs.map(e => e.code));
    const msg = errs.map(e => `[${e.code}] ${e.message}`).join("; ") || `HTTP ${res.status}`;
    console.error(`Cloudflare API 返回失败：${msg}`);

    // 三种成因、三种说法。以前一律引导「去新建一枚 Radar:Read token」，
    // 而其中两种根本不需要新 token——那是白费一步。
    if (codes.has(6111) || codes.has(6003)) {
      // header 格式不对：几乎总是「Global API Key 被塞进了 token 槽位，走了 Bearer」。
      console.error(
        `\n这是**凭据格式**错，不是权限不够，不需要去建新 token：\n` +
        `  Global API Key 必须走 X-Auth-Email + X-Auth-Key 两个头，不能走\n` +
        `  Authorization: Bearer。本脚本不按长度猜测，只认环境变量/参数分别放在哪个\n` +
        `  槽位——会看到这条，多半是把 Global Key 填进了 CLOUDFLARE_API_TOKEN/\n` +
        `  CF_API_TOKEN（或 --token），应该改填 CF_EMAIL+CF_GLOBAL_KEY 或\n` +
        `  CLOUDFLARE_EMAIL+CLOUDFLARE_API_KEY 这一对；也可能是复制时混进了空白/\n` +
        `  换行，或者传成了 Account ID 之类的别的东西。`
      );
    } else if (codes.has(9106)) {
      console.error(`\n一个认证头都没带上。检查凭据是不是空字符串。`);
    } else if (codes.has(10000) || codes.has(1000)) {
      // 认证/权限面：凭据格式对，但这枚凭据调不通。两种凭据的成因完全不同，
      // 说法必须分开——以前一律讲 wrangler 的故事，对 Global Key 用户是错的。
      if (cred.method === "global-key") {
        console.error(
          `\nGlobal API Key 的两个头都发出去了，被拒的是**凭据内容本身**：\n` +
          `  · 邮箱与 key 不属于同一个账号（最常见——邮箱填错、或 key 是另一个账号的）；\n` +
          `  · key 已在控制台轮换/吊销；\n` +
          `  · 复制时混进了空白或换行。\n` +
          `Global Key 是全账号权限，**不存在「scope 不够」这回事**——所以不要因为这条\n` +
          `报错去新建 token，先核对邮箱与 key 是不是同一个账号的。`
        );
      } else {
        console.error(
          `\n凭据格式是对的，问题在**权限面**（不是新鲜度，重登 wrangler 没用）：\n` +
          `  wrangler 的 OAuth 凭据是为部署发的，scopes 里没有 Radar，永远调不通这个端点。\n\n` +
          `确认办法（把同一枚凭据打到验证端点）：\n` +
          `  curl -s -H "Authorization: Bearer <token>" \\\n` +
          `    https://api.cloudflare.com/client/v4/user/tokens/verify\n` +
          `  回 [1000] Invalid API Token → 这枚凭据根本不被当作 API token；\n` +
          `  回成功但 Radar 仍 10000 → 是 scope 不够。\n\n` +
          `两条出路，任选其一：\n` +
          `  A. 用账号已有的 **Global API Key** + CF_EMAIL/CLOUDFLARE_EMAIL —— 它是全账号\n` +
          `     权限，实测能调 Radar，**不需要新建任何 token**；\n` +
          `  B. 在控制台新建一枚带 **Radar:Read** 的 scoped API Token（更安全，长期推荐）。\n` +
          `（两条都需要账号持有者本人操作，不要代为创建。）`
        );
      }
    }
    process.exit(1);
  }

  return body.result;
}

function validCategoryNames(result) {
  return (result.meta.domainCategories || []).map(c => c.name);
}

// ── 格式化 ───────────────────────────────────────────────────────────────

function computeRows(result, category) {
  const counts = result.summary_0;
  // 分母坑：加了 domainCategory 过滤后，summary_0 的计数会按分类收窄，
  // 但 meta.successfulDomains 仍是全网口径，不会跟着收窄。拿全网分母去除
  // 分类后的计数会算出偏低、误导性的百分比。有分类时改用
  // meta.domainCategories 里该分类自己声明的域名数做分母——这是这个端点
  // 能给到的最接近的分母，但它统计的是「打了这个分类标签的域名总数」，
  // 不保证等于「该分类里扫描成功的域名数」，视为近似值。
  let denom = result.meta.successfulDomains;
  let denomIsApprox = false;
  if (category) {
    const entry = (result.meta.domainCategories || []).find(c => c.name === category);
    if (entry) {
      denom = entry.value;
      denomIsApprox = true;
    }
  }
  return Object.entries(counts)
    .map(([key, countStr]) => {
      const count = Number(countStr);
      return {
        key,
        label: CHECK_LABELS[key] || key,
        count,
        denom,
        denomIsApprox,
        pct: denom > 0 ? (count / denom) * 100 : 0,
      };
    })
    .sort((a, b) => b.pct - a.pct);
}

function printTable(result, category) {
  const rows = computeRows(result, category);
  const meta = result.meta;
  console.log(`\n═══ Cloudflare Radar · AI Agent Readiness 全网基线 ═══`);
  console.log(`数据日期：${meta.date}（lastUpdated ${meta.lastUpdated}）`);
  if (category) {
    console.log(`分类过滤：${category}（分母是该分类声明的域名数，是近似值，不是`);
    console.log(`该分类里「扫描成功」的精确数——这个端点没有暴露那个数字）`);
  } else {
    console.log(`样本：${meta.successfulDomains}/${meta.totalDomains} 个域名扫描成功`);
  }
  console.log();

  const nameWidth = Math.max(...rows.map(r => r.label.length)) + 2;
  for (const r of rows) {
    const pctStr = `${r.pct.toFixed(1)}%`.padStart(6);
    console.log(`${r.label.padEnd(nameWidth)} ${pctStr}   (${r.count}/${r.denom})`);
  }
  console.log();
  console.log(`解读规则：单站分数只有对着这份分母看才有意义。追一项全网通过率`);
  console.log(`个位数甚至 0% 的检查，价值几乎总是低于它挤占的工作——那不是你的`);
  console.log(`缺陷，是 2026 年互联网的常态。`);
}

// ── 存盘 ─────────────────────────────────────────────────────────────────

function saveBaseline(result, projectRoot) {
  const dir = join(projectRoot, ".rankup", "agentic", "baseline");
  mkdirSync(dir, { recursive: true });
  const date = result.meta.date || new Date().toISOString().slice(0, 10);
  const file = join(dir, `${date}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(`· 已存入 ${file}`);
}

// ── --compare ────────────────────────────────────────────────────────────

function printCompare(result, scanPath) {
  let scan;
  try {
    scan = JSON.parse(readFileSync(scanPath, "utf8"));
  } catch (e) {
    console.error(`读不了 ${scanPath}：${e.message}`);
    process.exit(1);
  }

  const issues = scan.issues || [];
  if (!issues.length) {
    console.log(`${scan.display_target || scanPath} 的扫描里没有待修项，无需对照。`);
    return;
  }

  const rows = computeRows(result);
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));

  const mapped = [];
  const unmapped = [];
  for (const issue of issues) {
    const radarKey = ID_MAP[issue.id];
    if (radarKey && byKey[radarKey]) {
      mapped.push({ issue, baseline: byKey[radarKey] });
    } else {
      unmapped.push(issue);
    }
  }

  console.log(`\n═══ ${scan.display_target || scanPath} 待修项 × 全网基线 ═══`);
  console.log(`站点分数：${scan.score ?? "?"}/100  待修项 ${issues.length} 条\n`);

  if (mapped.length) {
    console.log(`可对照（${mapped.length} 项，站点检查 ↔ Radar 全网检查为已确认的同一件事）：`);
    console.log("─".repeat(72));
    for (const { issue, baseline } of mapped) {
      console.log(`✗ [${issue.tier}] ${issue.name}`);
      console.log(`  站点现状：${issue.result}`);
      console.log(`  全网通过率：${baseline.pct.toFixed(1)}%（${baseline.count}/${baseline.denom} 个域名）`);
      console.log();
    }
  } else {
    console.log(`没有一条待修项能对照到这个端点的检查项——见下方「未能对照」。\n`);
  }

  // 这里以前有一句 `pct < 15 → 这项应该让位 / 否则值得修` 的判决，2026-08-30 第三波删除。
  // 一个通过率**不能**推出优先级：全网 8% 通过可能是这项难做（那就该让位），
  // 也可能是所有人都还没做（那就是先发优势）；而 90% 通过的项若对你的站型不适用，
  // 修了也没有收益。脚本给通过率这个事实，「先修哪个」交给读证据的人/AI。

  console.log(`未能对照（${unmapped.length} 项，Radar 这个端点不测这些，映射表故意留空，不做`);
  console.log(`凑数假映射）：`);
  for (const issue of unmapped) {
    console.log(`  · [${issue.tier}] ${issue.name}（id: ${issue.id}）`);
  }
  if (unmapped.length) {
    console.log(`\n这份对照不是全量映射：is-agentic.mjs 的检查项和这个端点的检查项`);
    console.log(`只在概念完全一致时才连线，其余需要人工判断，不要当成「全网也不管这项」。`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();

  const comparePath = flagValue(args, "--compare");
  const category = flagValue(args, "--category");
  const projectRoot = flagValue(args, "--project") || process.cwd();
  const asJson = args.includes("--json");
  const shouldSave = args.includes("--save");

  const cred = resolveCredential(args);
  const result = await fetchBaseline(cred, { category: category || undefined });

  // 客户端校验 domainCategory：这个端点对未知取值不报错，只是静默忽略过滤，
  // 会让人误以为筛选生效了。自己拿 meta.domainCategories 校验一遍。
  if (category) {
    const valid = validCategoryNames(result);
    if (!valid.includes(category)) {
      console.error(`未知的 domainCategory：「${category}」。`);
      console.error(`这个端点对无效取值不报错、只是静默忽略过滤，所以在这里先挡一道。`);
      console.error(`有效取值：\n  ${valid.join("\n  ")}`);
      process.exit(1);
    }
  }

  if (comparePath) {
    if (asJson) {
      console.error(`--compare 和 --json 不能同时用。`);
      process.exit(1);
    }
    printCompare(result, comparePath);
    if (shouldSave) saveBaseline(result, projectRoot);
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTable(result, category);
  }
  if (shouldSave) saveBaseline(result, projectRoot);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
