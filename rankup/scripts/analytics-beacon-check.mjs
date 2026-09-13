#!/usr/bin/env node
/**
 * analytics-beacon-check.mjs —— 检查延迟加载的第三方分析脚本是否真的触发了，
 * 驱动一次性的浏览器会话打开公开页面（不需要登录态）。
 *
 * 用法：
 *   node <rankup-skill-dir>/scripts/analytics-beacon-check.mjs <url> [--wait <秒>] [--json]
 *   node <rankup-skill-dir>/scripts/analytics-beacon-check.mjs <url> --interact [--json]
 *   node <rankup-skill-dir>/scripts/analytics-beacon-check.mjs <url> --both [--json]
 *
 * 标志：
 *   --wait <秒>       不交互场景下等待的秒数，默认 7（覆盖本 Skill 硬规则的
 *                     "6s 兜底"再留 1 秒缓冲）
 *   --interact        打开页面后立即模拟一次真实点击，检查是否由交互触发
 *                     （而不是靠 6s 兜底）
 *   --both            两种场景都跑，各开一个独立会话，输出各自结果
 *   --interact-wait <秒>  --interact 场景下点击后再等待的秒数，默认 3
 *   --session <名>    opencli 会话名前缀（默认按场景派生，见下）
 *   --keep-session    完成后不关闭会话
 *   --json            机读输出
 *
 * ── 为什么用 opencli 而不是新引入无头浏览器依赖 ──────────────────────
 *
 * 本 Skill 里所有浏览器自动化脚本统一走 opencli（讨论见 discipline.md 五）；
 * 仓库本身（package.json 或等价物）没有 puppeteer/playwright 这类无头浏览器
 * 依赖，为这一个脚本单独引入一次性重量级依赖不划算，且这类页面是**公开页面
 * 不需要登录态**——opencli 驱动用户真实 Chrome 开一次性会话、看完就关，
 * 与"需要登录态才用 opencli"这条规则不冲突，只是复用同一套已有机制。
 *
 * ── 判据来源：为什么不用 opencli 自己的 `network` 命令 ───────────────
 *
 * 【实测，2026-09-13】对一个真实站点，`opencli browser <s> network` 在页面
 * 加载完 8 秒后仍报 `count: 0`——CDP 的 Network 域似乎在页面导航发生之后才
 * 挂上监听，错过了脚本标签注入触发的请求（无论 `--all` 还是默认过滤）。
 * 同一个会话改用 `eval` 读 `performance.getEntriesByType('resource')` 与
 * `document.querySelectorAll('script[src]')`，同一批请求（GA4/Clarity/Ahrefs/
 * CF beacon 全部在内）立刻就能看到。这与某个项目侧沉淀的证据结论一致
 * （某项目 `.rankup/` 下的分析脚本核验记录：`read_network_requests` 对这类脚本
 * 标签注入的跨域请求同样"看不见"，判据落在 `performance` 条目与 `script[src]`
 * 上才可靠——项目专属的记录文件不属于本 Skill，具体出处见各项目自己的
 * `.rankup/`）。因此本脚本判定第三方脚本"有没有加载"一律走这条路径，不用
 * opencli 的 `network` 命令。
 *
 * ── 两种场景 ─────────────────────────────────────────────────
 *
 * 不交互：打开页面，等 `--wait` 秒（默认 7，覆盖 6s 兜底 + 1s 缓冲），
 * 检查此时已加载的资源——验证"没有用户交互时，6s 兜底确实生效"。
 * 交互：打开页面后立刻用 opencli 的真实 CDP 点击（不是 JS 合成事件）
 * 点一下页面主体，短暂等待（默认 3 秒）后检查——验证"首次交互立即触发，
 * 不需要等到 6s"。两者都通过才算「延迟加载策略按设计工作」；只有不交互
 * 场景通过、交互场景不触发，说明交互监听器本身有问题。
 *
 * ── 判定的平台与host ─────────────────────────────────────────
 *   GA4       googletagmanager.com
 *   Clarity   clarity.ms
 *   Ahrefs    analytics.ahrefs.com
 *   CF WA     cloudflareinsights.com
 *
 * 已验证：2026-09-13（在一个真实部署了这四种分析脚本延迟加载器的站点上，
 * 不交互等 7 秒与交互后立即检查两种场景均正确识别出脚本已加载）。
 */
import { execSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { newEvidenceDir, captureScene, writeManifest, sessionSuffix } from "./lib-scene.mjs";

const HOST_PATTERNS = {
  ga4: { label: "GA4", host: "googletagmanager.com" },
  clarity: { label: "Microsoft Clarity", host: "clarity.ms" },
  ahrefs: { label: "Ahrefs WA", host: "analytics.ahrefs.com" },
  cfWebAnalytics: { label: "Cloudflare Web Analytics", host: "cloudflareinsights.com" },
};

/* ── 纯函数：分类判定，可脱离浏览器单测 ───────────────────────── */

/**
 * 给定已加载资源的 URL 列表（`performance` 条目名 + `script[src]`），
 * 判定四个平台各自是否命中，并给出命中的具体 URL（便于核对是不是这个项目
 * 自己的脚本，而不是页面里恰好出现的第三方广告/CDN 巧合撞了域名关键词）。
 */
export function classifyBeacons(resourceUrls) {
  const urls = [...new Set((resourceUrls || []).filter(Boolean))];
  const result = {};
  for (const [key, { label, host }] of Object.entries(HOST_PATTERNS)) {
    const matched = urls.filter((u) => u.includes(host));
    result[key] = { label, host, loaded: matched.length > 0, matchedUrls: matched };
  }
  return result;
}

/** 把 classifyBeacons 的结果渲染成一行一个平台的文本表格。 */
export function formatBeaconTable(classified) {
  const rows = Object.values(classified).map(
    (c) => `${c.loaded ? "✅" : "❌"} ${c.label.padEnd(24)} ${c.loaded ? c.matchedUrls[0] : "(未加载)"}`,
  );
  return rows.join("\n");
}

/* ── 参数 ─────────────────────────────────────────────────── */
let url = null;
let waitSeconds = 7;
let interact = false;
let both = false;
let interactWaitSeconds = 3;
let sessionPrefix = null;
let keepSession = false;
let json = false;

function usage() {
  console.log(`用法:
  node analytics-beacon-check.mjs <url> [--wait <秒>] [--json]
  node analytics-beacon-check.mjs <url> --interact [--interact-wait <秒>] [--json]
  node analytics-beacon-check.mjs <url> --both [--json]`);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  url = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wait" && argv[i + 1]) { waitSeconds = Number(argv[++i]); continue; }
    if (a === "--interact") { interact = true; continue; }
    if (a === "--both") { both = true; continue; }
    if (a === "--interact-wait" && argv[i + 1]) { interactWaitSeconds = Number(argv[++i]); continue; }
    if (a === "--session" && argv[i + 1]) { sessionPrefix = argv[++i]; continue; }
    if (a === "--keep-session") { keepSession = true; continue; }
    if (a === "--json") { json = true; continue; }
    if (a === "-h" || a === "--help") { usage(); process.exit(0); }
    console.error(`未知参数: ${a}`);
    usage();
    process.exit(1);
  }
  if (!/^https?:\/\//i.test(url)) {
    console.error("url 必须是完整地址（带 http:// 或 https://）");
    process.exit(1);
  }
}

/* ── OpenCLI 封装（execSync + eval，风格同 clarity-setup.mjs） ── */
function cli(session, action, { timeout = 30000 } = {}) {
  try {
    return execSync(`opencli browser "${session}" --window background ${action}`,
      { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = (e.stderr?.toString() || e.stdout?.toString() || e.message).trim();
    throw new Error(`opencli 失败: ${action}\n  ${err}`);
  }
}
function evalJs(session, js) {
  return cli(session, `eval '${`(()=>{${js}})()`.replace(/'/g, "'\\''")}'`);
}
function open(session, target) {
  cli(session, `open "${target}"`);
}
function settle(session, ms) {
  cli(session, `eval '(async()=>{await new Promise(r=>setTimeout(r,${ms}));return true})()'`, { timeout: ms + 30000 });
}

/** 读取当前页面已加载的资源 URL：performance 条目 + script[src]，两路合并去重。 */
function readLoadedResourceUrls(session) {
  const raw = evalJs(
    session,
    `const names=performance.getEntriesByType('resource').map(r=>r.name);` +
      `const scripts=[...document.querySelectorAll('script[src]')].map(s=>s.src);` +
      `return JSON.stringify([...new Set([...names,...scripts])]);`,
  );
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/* ── 取证 ─────────────────────────────────────────────────── */
let evidence = null;
function evidenceDir() {
  if (!evidence) evidence = newEvidenceDir("analytics-beacon-check");
  return evidence;
}
function scene(session, tag, extra) {
  return captureScene({
    dir: evidenceDir(),
    tag,
    screenshot: (p) => cli(session, `screenshot "${p}"`, { timeout: 90000 }),
    pageText: () => {
      try {
        return evalJs(session, `return document.title`);
      } catch (e) {
        return `PAGE_TEXT_FAILED:${e.message}`;
      }
    },
    extra,
  });
}

/**
 * 跑一个场景（不交互 / 交互），返回 {scenario, classified, table, resourceCount}。
 * 会话名按场景派生，两个场景各自独立会话，互不干扰。
 */
async function runScenario(scenario) {
  const session = `${sessionPrefix || `abc-${sessionSuffix()}`}-${scenario}`;
  try {
    open(session, url);
    if (scenario === "no-interaction") {
      settle(session, Math.max(1, waitSeconds) * 1000);
    } else {
      // 真实 CDP 点击（不是 JS 合成事件），点页面主体——只为触发一次性的
      // 首次交互监听器（click/scroll/keydown/touchstart/pointermove 之一）。
      cli(session, `click "body"`);
      settle(session, Math.max(1, interactWaitSeconds) * 1000);
    }
    const resourceUrls = readLoadedResourceUrls(session);
    const classified = classifyBeacons(resourceUrls);
    scene(session, `${scenario}-final`, { resourceCount: resourceUrls.length, classified });
    return { scenario, classified, table: formatBeaconTable(classified), resourceCount: resourceUrls.length };
  } finally {
    if (!keepSession) {
      try { cli(session, "close"); } catch { /* ignore */ }
    }
  }
}

async function main() {
  parseArgs(process.argv.slice(2));

  const scenarios = both ? ["no-interaction", "interaction"] : [interact ? "interaction" : "no-interaction"];
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }

  writeManifest(evidenceDir(), {
    script: "analytics-beacon-check",
    url,
    scenarios,
    results: results.map((r) => ({ scenario: r.scenario, resourceCount: r.resourceCount })),
    finishedAt: new Date().toISOString(),
  });

  if (json) {
    console.log(JSON.stringify({ url, results }, null, 2));
    return;
  }
  for (const r of results) {
    const label = r.scenario === "no-interaction" ? `不交互（等 ${waitSeconds}s）` : `交互后（等 ${interactWaitSeconds}s）`;
    console.log(`── ${url} —— ${label} ──`);
    console.log(r.table);
    console.log();
  }
  console.log(`证据（截图 + manifest）已落 ${evidenceDir()}`);
}

// argv[1] 保留调用时写的路径，import.meta.url 已经过符号链接解析——两边取真实路径
// 再比较，同 check-version.mjs 的 invokedAsScript()。让测试可以只 import
// classifyBeacons / formatBeaconTable 而不触发参数校验或真的浏览器调用。
async function invokedAsScript() {
  if (process.argv[1] === undefined) return false;
  try {
    const resolved = await realpath(resolvePath(process.argv[1]));
    return pathToFileURL(resolved).href === import.meta.url;
  } catch {
    return false;
  }
}

if (await invokedAsScript()) {
  await main();
}
