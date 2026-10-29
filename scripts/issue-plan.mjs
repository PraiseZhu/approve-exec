#!/usr/bin/env node
// issue-plan.mjs — issue 入口：读总 issue（或独立 issue / 单个子 issue），按 task-issue/v1 模板校验每个
// 子 issue，按「依赖」段分批，并为每个子 issue 生成 keel_run 参数。只读 GitHub，不创建会话。
//
// CLI:
//   node scripts/issue-plan.mjs --issue <owner/repo#号> --lead-agent <claude-code|codex>
//     --repo-dir <owner/repo>=<目标仓主目录绝对路径> [--repo-dir ...]
//     (--authorization <授权原话> | --entry <入口消息原文>) [--source chat|script]
//     --out <plan.json> [--now <ISO>] [--gh-fixture <夹具.json>（测试用，代替 gh）]
// 输出：stdout 一行 JSON 摘要；exit 0 成功 / 2 拒绝（stderr 点名 issue 与原因，不产出计划文件）。
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { hashObject, isMain, nowIso, parseArgs, writeJsonAtomic } from './lib/common.mjs';

export const PLAN_SCHEMA = 'issue-plan-v1';
// 与 ~/AI-Agent/Claude/capabilities/source/scripts/check-pr-issue.sh 同口径：五个二级标题按行首前缀匹配。
export const CHILD_ANCHORS = ['## 目标', '## 范围', '## 不做', '## 依赖', '## 验收标准'];
export const LEADS = ['claude-code', 'codex'];
// 验证层 → keel_run.sc.min_level。browser-fixture 与 KEEL scVerifyImpliesLiveUi（playwright/cypress）同口径。
export const LAYER_LEVEL = Object.freeze({
  static: 'type-check-only',
  unit: 'unit-test-verified',
  contract: 'unit-test-verified',
  'browser-fixture': 'live-ui-verified',
});
// 合并前拿不到证据的层：不进 keel_run.sc（否则 KEEL done 门只能 revise / waive / stop）。
export const MANUAL_LAYERS = Object.freeze(['github-live', 'cindy-mac', 'cindy-windows', 'paid']);

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.code = 'PLAN';
  }
}
const reject = (msg) => { throw new PlanError(msg); };

// helpers

const REF_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/;

export function parseIssueRef(raw) {
  const s = String(raw ?? '').trim();
  const m = REF_RE.exec(s) ?? URL_RE.exec(s);
  if (!m) reject(`issue 引用必须是 owner/repo#号 或 issue 链接（当前: ${raw}）`);
  const repo = `${m[1]}/${m[2]}`;
  const number = Number(m[3]);
  return { repo, number, ref: `${repo}#${number}` };
}

function cleanBody(body) {
  return String(body ?? '').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
}

/** 按二级标题切段；代码块内的 `## ` 不算标题。返回 [{heading, lines}]，首个标题之前的内容 heading=''. */
export function splitSections(body) {
  const sections = [{ heading: '', lines: [] }];
  let inFence = false;
  for (const line of cleanBody(body).split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
      sections.push({ heading: line.slice(3).trim(), lines: [] });
      continue;
    }
    sections.at(-1).lines.push(line);
  }
  return sections;
}

function sectionText(sections, prefix) {
  const hit = sections.find((s) => s.heading.startsWith(prefix));
  return hit ? hit.lines.join('\n').trim() : null;
}

const SC_ANY_RE = /^\s*[-*]\s*(\[[ xX]\])?\s*(\*\*)?SC[0-9]+\b/m;

export function assertChildTemplate(body, ref) {
  const text = cleanBody(body);
  for (const anchor of CHILD_ANCHORS) {
    if (!text.split('\n').some((l) => l.startsWith(anchor))) {
      reject(`${ref} 没按 task-issue-child.md 写：缺「${anchor}」段。先补齐 issue（「开 issue」）再批准执行`);
    }
  }
  if (!SC_ANY_RE.test(text)) reject(`${ref} 的验收标准没有 SC<n> 编号项。先补齐 issue 再批准执行`);
}

const SC_LINE_RE = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?(?:\*\*)?(SC\d+)\b(?:\*\*)?\s*(.*)$/;
const KNOWN_LAYERS = [...Object.keys(LAYER_LEVEL), ...MANUAL_LAYERS];

/** 验收标准段 → { sc: keel_run.sc, manual: 合并前拿不到证据的项 }。 */
export function toKeelSc(text, ref) {
  const sc = [];
  const manual = [];
  const seen = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const m = SC_LINE_RE.exec(line);
    if (!m) continue;
    const [, id, rest] = m;
    if (seen.has(id)) reject(`${ref} 验收标准里 ${id} 重复`);
    seen.add(id);
    const lm = /验证[：:]\s*([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    if (!lm) reject(`${ref} ${id} 缺「验证：<层>」：${line.trim()}`);
    const layer = lm[1];
    if (!KNOWN_LAYERS.includes(layer)) {
      reject(`${ref} ${id} 的验证层「${layer}」不认识（只认 ${KNOWN_LAYERS.join(' / ')}）：${line.trim()}`);
    }
    const textOut = `${id} ${rest}`.trim();
    if (MANUAL_LAYERS.includes(layer)) manual.push({ id, text: textOut, layer });
    else sc.push({ id, text: textOut, min_level: LAYER_LEVEL[layer] });
  }
  if (seen.size === 0) reject(`${ref} 的验收标准没有 SC<n> 编号项`);
  return { sc, manual };
}

/** `a/{b,c}.mjs` → ['a/b.mjs', 'a/c.mjs']；KEEL 的 scope 匹配不认花括号，所以在这里展开。 */
export function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  return m[1].split(',').flatMap((alt) => expandBraces(head + alt.trim() + tail));
}

const isPathLike = (t) => !/\s/.test(t) && (t.includes('/') || t.includes('*') || /\.[A-Za-z0-9]+$/.test(t));
const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());

/** 列表项按反引号外的第一个冒号拆成「文件或模块」格与说明。 */
function splitHead(line) {
  let inTick = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '`') inTick = !inTick;
    else if (!inTick && (ch === '：' || ch === ':')) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, ''];
}

/**
 * 范围段 → scope glob 列表。模板格式是 `- \`<文件或模块>\`：<改什么>`：冒号前那一格里的反引号内容都当路径
 * （`Makefile` 这类无扩展名文件也收）；说明里只收像路径的词（含 `/`、`*` 或扩展名），
 * `TEST_FILES`、`checkpoint` 这类标识符不收。每个列表项至少要有一个路径。
 */
export function toScope(text, ref) {
  const scope = [];
  let bullets = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!/^\s*[-*]\s+/.test(line)) continue;
    bullets += 1;
    const [head, rest] = splitHead(line.replace(/^\s*[-*]\s+/, ''));
    const tokens = [...ticks(head).filter((t) => t && !/\s/.test(t)), ...ticks(rest).filter(isPathLike)];
    if (tokens.length === 0) {
      reject(`${ref} 「范围」这一行没有反引号包住的文件路径或 glob（例如测试要写成 \`tests/**/*.test.mjs\`）：${line.trim()}`);
    }
    for (const t of tokens.flatMap(expandBraces)) {
      const p = t.replace(/^\.\//, '');
      if (p.startsWith('/') || p.split('/').includes('..')) reject(`${ref} 「范围」里的路径必须是仓内相对路径：${t}`);
      if (!scope.includes(p)) scope.push(p);
    }
  }
  if (bullets === 0) reject(`${ref} 「范围」段没有任何文件路径列表项`);
  return scope;
}

const DEP_REF_RE = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/g;

/**
 * 依赖段 → { hard: 要等它合入才开工, after: 只是排在它后面合 }。按句号、分号和逗号拆成小句逐句判断，
 * 「与 #11 并行开发，等 #12 合进 main 后开工」只把 #12 算开工依赖。判断不了的小句直接拒绝。
 */
export function parseDeps(text, selfRepo, selfRef) {
  const hard = [];
  const after = [];
  const body = String(text ?? '').trim();
  for (const clause of body.split(/[；;。\n，,]/)) {
    const refs = [...clause.matchAll(DEP_REF_RE)]
      .map((m) => `${m[1] ?? selfRepo}#${m[2]}`)
      .filter((r) => r !== selfRef);
    if (refs.length === 0) continue;
    let bucket;
    if (/等/.test(clause) && /(合进|合入)/.test(clause)) bucket = hard;
    else if (/先(合|进)/.test(clause)) bucket = after;
    else if (/并行/.test(clause)) bucket = null;
    else reject(`${selfRef} 「依赖」这一句判断不了是「等合入再开工」还是「只是先后合」：${clause.trim()}`);
    if (bucket) for (const r of refs) if (!bucket.includes(r)) bucket.push(r);
  }
  return { hard, after: after.filter((r) => !hard.includes(r)) };
}

/** 首行引用里的「并行组 X」与「PR 指向 <分支>」。 */
export function parseHeader(sections) {
  const intro = sections[0]?.lines.join('\n') ?? '';
  const group = /并行组\s*([A-Za-z0-9]+)/.exec(intro)?.[1] ?? null;
  const target = /PR 指向\s*`?([A-Za-z0-9._/*-]+)`?/.exec(intro)?.[1] ?? null;
  return { group, base_ref: target && target !== 'main' ? target : null };
}

export function pendingQuestions(text) {
  return String(text ?? '')
    .split('\n')
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => l && !l.includes('已定'));
}

/** 单个子 issue（GitHub issue 对象）→ 计划条目（未分批）。 */
export function toItem(issue, { repo, repoDirs, lead }) {
  const ref = `${repo}#${issue.number}`;
  const body = issue.body ?? '';
  assertChildTemplate(body, ref);
  const sections = splitSections(body);
  const { sc, manual } = toKeelSc(sectionText(sections, '验收标准'), ref);
  const scope = toScope(sectionText(sections, '范围'), ref);
  const deps = parseDeps(sectionText(sections, '依赖'), repo, ref);
  const header = parseHeader(sections);
  const repoDir = repoDirs[repo];
  if (!repoDir) reject(`${ref} 所在仓 ${repo} 没有给 --repo-dir ${repo}=<主目录绝对路径>`);
  const goalText = (sectionText(sections, '目标') ?? '').replace(/\s+/g, ' ').trim();
  const keelRun = {
    goal: `按 ${ref}「${issue.title}」完成：${goalText}`,
    sc,
    scope,
    repo_dir: repoDir,
    lead,
    ...(header.base_ref ? { base_ref: header.base_ref } : {}),
  };
  return {
    ref,
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.html_url ?? `https://github.com/${repo}/issues/${issue.number}`,
    closed: issue.state === 'closed',
    group: header.group,
    hard_deps: deps.hard,
    merge_after: deps.after,
    pending_questions: pendingQuestions(sectionText(sections, '待定问题')),
    manual_scs: manual,
    keel_run: keelRun,
  };
}

/** 按 hard_deps 分批（只看计划内的条目；计划外的依赖记在 external_deps，派发时再查 GitHub）。 */
export function toWaves(items) {
  const inPlan = new Set(items.map((i) => i.ref));
  const waveOf = new Map();
  let remaining = items.slice();
  const waves = [];
  while (remaining.length) {
    const ready = remaining.filter((i) => i.hard_deps.filter((d) => inPlan.has(d)).every((d) => waveOf.has(d)));
    if (ready.length === 0) reject(`依赖成环，无法分批：${remaining.map((i) => i.ref).join('、')}`);
    const n = waves.length;
    for (const i of ready) waveOf.set(i.ref, n);
    waves.push(ready.map((i) => i.ref));
    remaining = remaining.filter((i) => !waveOf.has(i.ref));
  }
  return {
    waves,
    items: items.map((i) => ({
      ...i,
      wave: waveOf.get(i.ref) + 1,
      external_deps: i.hard_deps.filter((d) => !inPlan.has(d)),
    })),
  };
}

export function buildPlan({ root, children, repoDirs, lead, authorization, entry, source = 'chat', now = nowIso() }) {
  if (lead === 'pi') reject('KEEL 不接受 Pi 当主控：lead 会话必须是 claude-code 或 codex');
  if (!LEADS.includes(lead)) reject(`--lead-agent 只能是 ${LEADS.join(' / ')}（当前: ${lead}）`);
  if (!['chat', 'script'].includes(source)) reject(`--source 只能是 chat / script（当前: ${source}）`);
  const authorizationSource = String(authorization ?? entry ?? '').trim();
  if (!authorizationSource) reject('缺授权原话：传 --authorization <原话>，或用 --entry 传入口消息原文');
  for (const [repo, dir] of Object.entries(repoDirs)) {
    if (!isAbsolute(dir)) reject(`--repo-dir ${repo} 必须是绝对路径（当前: ${dir}）`);
    let st;
    try { st = statSync(dir); } catch { reject(`--repo-dir ${repo} 目录不存在: ${dir}`); }
    if (!st.isDirectory()) reject(`--repo-dir ${repo} 不是目录: ${dir}`);
  }
  const kind = children.length > 0 ? 'parent' : 'single';
  if (kind === 'single' && /^\[总\]/.test(root.issue.title ?? '')) reject(`${root.ref} 是总 issue 却没有挂子 issue`);
  const sources = kind === 'parent' ? children : [{ repo: root.repo, issue: root.issue }];
  const raw = sources.map(({ repo, issue }) => toItem(issue, { repo, repoDirs, lead }));
  const { waves, items } = toWaves(raw);
  const plan = {
    schema: PLAN_SCHEMA,
    created_at: now,
    root: {
      ref: root.ref,
      title: root.issue.title,
      url: root.issue.html_url ?? `https://github.com/${root.repo}/issues/${root.number}`,
      kind,
    },
    lead_agent: lead,
    source,
    authorization_source: authorizationSource,
    entry: entry ?? null,
    waves,
    items,
  };
  return { ...plan, plan_sha256: hashObject(plan) };
}

// github

/** 夹具里的评论写入：追加到「读评论」那一项，后续读取能读到。纯函数，CLI 夹具与测试共用。 */
export function fixturePost(fixture, args) {
  const path = args[3];
  const body = (args.find((a) => a.startsWith('body=')) ?? 'body=').slice(5);
  const key = `api ${path}?per_page=100`;
  const list = Array.isArray(fixture[key]) ? fixture[key] : [];
  const comment = { body, html_url: `https://github.com/${path.replace(/^repos\//, '')}#fixture-${list.length + 1}` };
  fixture[key] = [...list, comment];
  return comment;
}

export function ghRunner(fixturePath) {
  if (fixturePath) {
    return (args) => {
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
      if (args[1] === '-X' && args[2] === 'POST') {
        const out = fixturePost(fixture, args);
        writeFileSync(fixturePath, JSON.stringify(fixture));
        return out;
      }
      const key = args.join(' ');
      if (!Object.hasOwn(fixture, key)) throw new Error(`gh 夹具缺少: ${key}`);
      return fixture[key];
    };
  }
  return (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

export function readIssue(gh, repo, number) {
  return gh(['api', `repos/${repo}/issues/${number}`]);
}

export function readRoot(gh, ref) {
  const root = parseIssueRef(ref);
  const issue = readIssue(gh, root.repo, root.number);
  // GitHub 每个父 issue 最多挂 100 个子 issue，一页取完。
  const subs = gh(['api', `repos/${root.repo}/issues/${root.number}/sub_issues?per_page=100`]);
  const children = (Array.isArray(subs) ? subs : []).map((s) => {
    const repo = String(s.repository_url ?? '').split('/').slice(-2).join('/');
    if (!/^[^/]+\/[^/]+$/.test(repo)) reject(`${root.ref} 的子 issue #${s.number} 读不出所在仓`);
    return { repo, issue: typeof s.body === 'string' ? s : readIssue(gh, repo, s.number) };
  });
  return { root: { ...root, issue }, children };
}

// cli

function repoDirsFrom(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out = {};
  for (const item of list) {
    const eq = String(item).indexOf('=');
    if (eq < 1) reject(`--repo-dir 格式是 <owner/repo>=<绝对路径>（当前: ${item}）`);
    out[String(item).slice(0, eq)] = String(item).slice(eq + 1);
  }
  return out;
}

/** parseArgs 只保留最后一个同名参数；--repo-dir 可重复，单独收集。 */
function collectRepeated(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  try {
    if (!args.issue || args.issue === true) reject('缺 --issue <owner/repo#号>');
    if (!args.out || args.out === true) reject('缺 --out <plan.json>');
    const gh = ghRunner(typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null);
    const { root, children } = readRoot(gh, args.issue);
    const plan = buildPlan({
      root,
      children,
      repoDirs: repoDirsFrom(collectRepeated(argv, 'repo-dir')),
      lead: args['lead-agent'],
      authorization: typeof args.authorization === 'string' ? args.authorization : undefined,
      entry: typeof args.entry === 'string' ? args.entry : undefined,
      source: typeof args.source === 'string' ? args.source : 'chat',
      now: typeof args.now === 'string' ? args.now : nowIso(),
    });
    writeJsonAtomic(args.out, plan);
    process.stdout.write(JSON.stringify({
      ok: true,
      plan: args.out,
      root: plan.root.ref,
      waves: plan.waves,
      manual_scs: plan.items.reduce((n, i) => n + i.manual_scs.length, 0),
    }) + '\n');
    return 0;
  } catch (err) {
    if (!(err instanceof PlanError)) throw err;
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
