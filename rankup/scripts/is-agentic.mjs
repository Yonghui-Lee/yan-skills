#!/usr/bin/env node
/**
 * AI Agent 就绪度扫描 —— 包装 is-agentic.com 的公开 API。
 *
 * 用法：
 *   node <rankup-skill-dir>/scripts/is-agentic.mjs scan <domain>
 *   node <rankup-skill-dir>/scripts/is-agentic.mjs scan <domain> --save   # 另存一份带日期的快照
 *   node <rankup-skill-dir>/scripts/is-agentic.mjs diff <domain>          # 与上次对比
 *   node <rankup-skill-dir>/scripts/is-agentic.mjs history <domain>       # 查看历史分数
 *
 * 零配置可跑：公开 API，无需令牌，120 请求/分钟/IP。
 * 扫描由 Ora AI 执行。**报告 API 只返回「最新已存在的报告」，本脚本没有强制重扫**：
 * 2026-09-03 实测同一域名相隔 11 天两次调用仍拿到同一份旧报告（不是 6 小时缓存）。
 * 要新报告得由用户在 is-agentic.com 上手动触发重扫，跑完再来 `scan --save`；判读时看报告里的
 * 时间戳，不看本次调用时间。**`scan`/`diff` 现在会在报告时间戳明显早于最近改动
 * 时打一条醒目警告**（判据是 `scanned_at` 距今超过阈值，见 `isReportStale`），
 * 免得把缓存分当成本次改动的真实结果——两个真实项目都复盘过这个坑：一次是
 * CLI 拿到 76 分的缓存旧报告，浏览器手动 Rescan 后变成 98 分，中间 22 分的差距
 * 全部来自「没有重新测量」，不是真的退步。
 *
 * **手动 Rescan 有未公开的冷却时间**（2026-09-13 实测）：同一域名短时间内
 * （约 25 分钟内点第 3 次）再点 Rescan，按钮会变灰、既不出现"Refreshing the
 * report..."提示，也不产生新的 `scanned_at`——不确定具体冷却时长，本次两次
 * 成功 rescan 间隔约 22 分钟。规划多轮验证同一个站点的分数变化时，两次 Rescan
 * 之间预留至少 30 分钟，不要指望连续改两次代码就能连续拿到两次全新分数；
 * 分数没变时先怀疑是不是撞了冷却窗口，再怀疑修复本身无效。
 *
 * ── 第三波（2026-08-30）两条改动 ──────────────────────────────────────────
 *
 * 1. **原始报告恒久化，不再依赖 `--save`。** 每次拿到响应（成功或失败）都先把
 *    原文落进 `.rankup/agentic/<domain>/raw/<时间戳>.json`，再做任何格式化。
 *    以前不加 `--save` 就只剩终端里那份被脚本改写过的摘要，复核无从谈起；
 *    429/非 200/CLI 失败更是连响应体都丢了——「限流」和「这个站真的没数据」
 *    在输出上完全同形。`--save` 现在只多做一件事：另存一份带日期的快照，
 *    供 `diff` / `history` 用。
 * 2. **待修项的顺序是参考顺序，不是修复顺序。** tier 权重是 API 自带的分类，
 *    脚本按它排只为方便阅读；「先修哪个」取决于你的站型、成本和目标，
 *    是判断，不是排序键能给的答案。
 *
 * 已验证：2026-08-22
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

const API = "https://is-agentic.com/api/v1/report";
const REPORT_URL = "https://is-agentic.com/scan";

const TIER_WEIGHT = { essential: 3, recommended: 2, bonus: 1 };
const RESULT_ICON = { failed: "✗", partial: "△", passed: "✓" };

// ── helpers ──────────────────────────────────────────────────────────────

function usage() {
  console.log(`用法：
  node is-agentic.mjs scan <domain>            扫描并输出报告
  node is-agentic.mjs scan <domain> --save     扫描并另存一份带日期的快照（供 diff/history）
  node is-agentic.mjs diff <domain>            与上次扫描对比
  node is-agentic.mjs history <domain>         查看历史分数曲线

选项：
  --save        另存一份带日期的快照 .rankup/agentic/<domain>/<date>.json，
                供 diff / history 对比用
  --project     项目根目录（默认 cwd）
  --help        显示帮助

原始响应**无条件**落在 .rankup/agentic/<domain>/raw/<时间戳>-<kind>.json，
成功、429、非 200、CLI 失败都留，不受 --save 影响——没有原始件，
「限流」和「这个站真的没数据」在输出上分不开。`);
  process.exit(0);
}

function req(v, name) {
  if (!v) { console.error(`缺少参数 ${name}`); process.exit(1); }
  return v;
}

function normDomain(input) {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function agenticDir(projectRoot, domain) {
  return join(projectRoot, ".rankup", "agentic", domain);
}

/**
 * 每一次响应——成功、429、非 200、CLI 失败——都在这里落原文。
 * **这是无条件的**：没有原始件，一次限流和「这个站真的没数据」在输出上同形。
 * 落盘本身不许把主流程搞挂（磁盘满、只读目录），失败就在 stderr 说一声。
 */
function persistRaw(projectRoot, domain, kind, payload) {
  try {
    const dir = join(agenticDir(projectRoot, domain), "raw");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `${stamp}-${kind}.json`);
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    console.error(`· 原始响应已存 ${file}`);
    return file;
  } catch (e) {
    console.error(`· 原始响应落盘失败（${e.message}）——下面的输出没有可复核的原始件`);
    return null;
  }
}

function latestSnapshot(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .sort()
    .reverse();
  if (!files.length) return null;
  return JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
}

function allSnapshots(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .sort()
    .map(f => {
      const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
      return { file: f, ...data };
    });
}

// ── API ──────────────────────────────────────────────────────────────────

async function fetchReport(domain, projectRoot) {
  const url = `${API}?url=https://${domain}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "rankup-skill/1.0" }
  });
  const meta = { url, domain, requestedAt: new Date().toISOString(), httpStatus: res.status };

  if (res.status === 404) {
    console.log(`· 没有已完成的报告，正在通过 CLI 触发扫描…`);
    let raw = null;
    try {
      raw = execSync(`npx is-agentic ${domain} --json 2>/dev/null`, {
        timeout: 180_000,
        encoding: "utf8",
      });
    } catch (e) {
      // 失败也留现场：stdout/stderr 原样存，别只留一行 message。
      persistRaw(projectRoot, domain, "cli-failed", {
        ...meta, via: "npx is-agentic", error: e.message,
        stdout: e.stdout ? String(e.stdout).slice(0, 200_000) : null,
        stderr: e.stderr ? String(e.stderr).slice(0, 200_000) : null,
      });
      console.error(`扫描失败：${e.message}（这是采集失败，不是「这个站不合格」）`);
      process.exit(1);
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) {
      persistRaw(projectRoot, domain, "cli-non-json", { ...meta, via: "npx is-agentic", body: String(raw).slice(0, 500_000) });
      console.error(`CLI 返回的不是 JSON：${e.message}（原文已落盘，先看它再下结论）`);
      process.exit(1);
    }
    persistRaw(projectRoot, domain, "cli-report", { ...meta, via: "npx is-agentic", report: parsed });
    return parsed;
  }

  if (res.status === 429) {
    const retry = res.headers.get("Retry-After") || "60";
    const body = await res.text();
    persistRaw(projectRoot, domain, "rate-limited", { ...meta, retryAfter: retry, body: body.slice(0, 200_000) });
    console.error(`限流（429），${retry} 秒后重试。**这是配额，不是这个站的分数。**`);
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text();
    persistRaw(projectRoot, domain, `http-${res.status}`, { ...meta, body: body.slice(0, 500_000) });
    console.error(`API 错误 ${res.status}：${body.slice(0, 400)}（采集失败，不是测量结果）`);
    process.exit(1);
  }

  const report = await res.json();
  persistRaw(projectRoot, domain, "report", { ...meta, report });
  return report;
}

// ── 报告格式化 ────────────────────────────────────────────────────────────

// 默认阈值 24 小时：is-agentic 的报告 API 没有强制重扫能力（见文件头），报告
// 时间戳一旦落后于最近一次改动，分数就是"改动前"的快照，不是"改动后"的结果。
// 纯函数，可脱离网络单测；`now` 可注入用于测试固定时间点。
export const DEFAULT_STALE_HOURS = 24;
export function isReportStale(scannedAt, now = new Date(), thresholdHours = DEFAULT_STALE_HOURS) {
  // `new Date(null)` 会被当成 0（epoch），不是"解析失败"——但这里语义上是
  // "没有给时间戳"，不该被判成一个真实的、极端陈旧的日期，所以 null/undefined/
  // 空字符串一律先归为"解析不出"，不进 Date 构造函数。
  if (scannedAt === null || scannedAt === undefined || scannedAt === "") return false;
  const scannedMs = new Date(scannedAt).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(scannedMs) || !Number.isFinite(nowMs)) return false; // 解析不出时间就不误报陈旧
  return nowMs - scannedMs > thresholdHours * 3_600_000;
}

function printReport(report) {
  const { score, score_label, score_breakdown: sb, issues, scanned_at } = report;
  const domain = report.display_target;

  console.log(`\n═══ ${domain} ═══`);
  console.log(`分数：${score}/100  ${score_label}`);
  console.log(`扫描时间：${new Date(scanned_at).toLocaleString("zh-CN")}`);
  if (isReportStale(scanned_at)) {
    const hoursAgo = Math.round((Date.now() - new Date(scanned_at).getTime()) / 3_600_000);
    console.log(
      `⚠️  这份报告距今约 ${hoursAgo} 小时——is-agentic 没有强制重扫能力，这可能是` +
        `旧代码/旧内容的缓存分数，不代表你最近的改动。要拿到反映当前状态的真实分数：` +
        `打开 ${REPORT_URL}/${domain} 手动点 Rescan，等新分数渲染出来（确认扫描时间戳变了）` +
        `再重跑本命令。Rescan 有未公开的冷却时间，两次之间预留至少 30 分钟。`,
    );
  }
  console.log(`报告：${REPORT_URL}/${domain}`);
  console.log();

  // 分数细分
  console.log(`┌─ Essential    ${sb.essential.passing}/${sb.essential.total} 通过    ${sb.essential.earned}/${sb.essential.available} 分`);
  console.log(`├─ Recommended  ${sb.recommended.passing}/${sb.recommended.total} 通过    ${sb.recommended.earned}/${sb.recommended.available} 分`);
  console.log(`└─ Bonus        ${sb.bonus.positive_signals} 个信号    +${sb.bonus.points} 分`);
  console.log();

  if (!issues || !issues.length) {
    // 陈述这次报告里有什么，不替它下「全都做对了」的结论：
    // issues 为空也可能是这次扫描没跑完某几类检查。原始件在 raw/ 下可复核。
    console.log("本次报告的 issues 列表为空（0 条 failed/partial）。原始报告见上面 raw/ 那个路径。");
    return;
  }

  // 只按 API 自带的 tier / result 排一下，**这是阅读顺序，不是修复顺序**。
  // 先修哪个取决于你的站型、改动成本和目标，那是判断，不是排序键能给的答案。
  const sorted = [...issues].sort((a, b) => {
    const tw = (TIER_WEIGHT[b.tier] || 0) - (TIER_WEIGHT[a.tier] || 0);
    if (tw !== 0) return tw;
    if (a.result === "failed" && b.result !== "failed") return -1;
    if (b.result === "failed" && a.result !== "failed") return 1;
    return 0;
  });

  console.log(`待修项（${sorted.length} 项，按 API 自带的 tier / result 排，**参考顺序，不是修复顺序**）：`);
  console.log("─".repeat(72));

  for (const issue of sorted) {
    const icon = RESULT_ICON[issue.result] || "?";
    const tier = issue.tier.toUpperCase().padEnd(11);
    console.log(`${icon} [${tier}] ${issue.name}`);
    if (issue.details) console.log(`  现状：${issue.details}`);
    if (issue.recommendation) {
      const rec = issue.recommendation.length > 200
        ? issue.recommendation.slice(0, 200) + "…"
        : issue.recommendation;
      console.log(`  建议：${rec}`);
    }
    console.log();
  }
}

function printDiff(current, previous) {
  const domain = current.display_target;
  const scoreDelta = current.score - previous.score;
  const sign = scoreDelta > 0 ? "+" : "";

  console.log(`\n═══ ${domain} 变化对比 ═══`);
  console.log(`上次：${previous.score}/100  （${new Date(previous.scanned_at).toLocaleDateString("zh-CN")}）`);
  console.log(`本次：${current.score}/100  （${new Date(current.scanned_at).toLocaleDateString("zh-CN")}）`);
  console.log(`变化：${sign}${scoreDelta} 分`);
  console.log();

  const prevIds = new Set((previous.issues || []).map(i => i.id));
  const currIds = new Set((current.issues || []).map(i => i.id));
  const currMap = Object.fromEntries((current.issues || []).map(i => [i.id, i]));
  const prevMap = Object.fromEntries((previous.issues || []).map(i => [i.id, i]));

  const fixed = [...prevIds].filter(id => !currIds.has(id));
  const newIssues = [...currIds].filter(id => !prevIds.has(id));
  const changed = [...currIds].filter(id => prevIds.has(id) && currMap[id].result !== prevMap[id].result);

  if (fixed.length) {
    console.log(`✓ 已修复（${fixed.length}）：`);
    for (const id of fixed) console.log(`  + ${prevMap[id].name}`);
    console.log();
  }

  if (changed.length) {
    console.log(`△ 状态变化（${changed.length}）：`);
    for (const id of changed) {
      console.log(`  ~ ${currMap[id].name}: ${prevMap[id].result} → ${currMap[id].result}`);
    }
    console.log();
  }

  if (newIssues.length) {
    console.log(`✗ 新问题（${newIssues.length}）：`);
    for (const id of newIssues) console.log(`  - ${currMap[id].name}`);
    console.log();
  }

  if (!fixed.length && !newIssues.length && !changed.length) {
    console.log("无变化。");
  }
}

function printHistory(snapshots, domain) {
  if (!snapshots.length) {
    console.log(`没有 ${domain} 的历史记录。先 scan --save 存一次。`);
    return;
  }
  console.log(`\n═══ ${domain} 历史 ═══`);
  console.log(`${"日期".padEnd(14)}${"分数".padEnd(8)}${"Essential".padEnd(14)}${"Recommended".padEnd(14)}${"Bonus"}`);
  console.log("─".repeat(60));
  for (const s of snapshots) {
    const date = s.file.replace(".json", "");
    const sb = s.score_breakdown;
    console.log(
      `${date.padEnd(14)}` +
      `${String(s.score).padEnd(8)}` +
      `${sb.essential.earned}/${sb.essential.available}`.padEnd(14) +
      `${sb.recommended.earned}/${sb.recommended.available}`.padEnd(14) +
      `+${sb.bonus.points}`
    );
  }
  console.log();
}

// ── 存盘 ─────────────────────────────────────────────────────────────────

function saveSnapshot(report, projectRoot) {
  const domain = normDomain(report.display_target);
  const dir = agenticDir(projectRoot, domain);
  mkdirSync(dir, { recursive: true });
  const date = new Date(report.scanned_at).toISOString().slice(0, 10);
  const file = join(dir, `${date}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(`· 已存入 ${file}`);
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) usage();

  const cmd = args[0];
  const domain = normDomain(req(args[1], "<domain>"));
  const flags = new Set(args.slice(2));
  const projectRoot = (() => {
    const idx = args.indexOf("--project");
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : process.cwd();
  })();

  if (cmd === "scan") {
    const report = await fetchReport(domain, projectRoot);
    printReport(report);
    if (flags.has("--save")) saveSnapshot(report, projectRoot);
  } else if (cmd === "diff") {
    const dir = agenticDir(projectRoot, domain);
    const prev = latestSnapshot(dir);
    if (!prev) {
      console.log(`没有 ${domain} 的历史快照，无法对比。先 scan --save 存一次基线。`);
      process.exit(1);
    }
    const report = await fetchReport(domain, projectRoot);
    printReport(report);
    printDiff(report, prev);
    if (flags.has("--save")) saveSnapshot(report, projectRoot);
  } else if (cmd === "history") {
    const dir = agenticDir(projectRoot, domain);
    const snapshots = allSnapshots(dir);
    printHistory(snapshots, domain);
  } else {
    console.error(`未知命令 ${cmd}。scan / diff / history`);
    process.exit(1);
  }
}

// argv[1] 保留调用时写的路径，import.meta.url 已经过符号链接解析——两边取真实路径
// 再比较，同 check-version.mjs 的 invokedAsScript()。让测试可以只 import 上面的
// 纯函数（isReportStale）而不触发参数校验或真的网络请求。
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
  main().catch(e => { console.error(e); process.exit(1); });
}
