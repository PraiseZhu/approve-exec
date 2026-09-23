#!/usr/bin/env node
// context-intake.mjs — 上下文入口：把 lead 按对话里已批准方案写的 brief，确定性转成与 task-priority final
// 同形的 manifest（receipts=[]，另带 provenance），再过本仓输入门（readManifest + assertManifestComplete）。
// 不替代 task-priority：没有七面覆盖与对抗质询，派工总表与 PR 描述须如实标注来源。
//
// CLI: node scripts/context-intake.mjs --brief <brief.json> --out-dir <目录> --now <ISO> [--repo-dir <worktree>]
//   --out-dir 建议 ~/.claude/.goal/<slug>/（不进 worktree，防宿主自动 commit 卷走）
//   --repo-dir 给出时额外核：摘录文件与行号真实存在；验证命令里的 npm script 与仓内路径真实存在
// 输出：stdout 一行 JSON 摘要；exit 0 成功 / 2 拒绝（stderr 点名原因）。
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashObject, isMain, normalizeRepoPath } from './lib/common.mjs';
import { layers } from './lib/pr-plan.mjs';
import { LedgerError, manifestCoreHash, readManifest, assertManifestComplete } from './run-ledger.mjs';
import { assertTaskHasHan, assertExcerpts } from './vnext-owner-contract.mjs';

export const BRIEF_SCHEMA = 'approve-exec-brief-v1';
export const MANIFEST_SCHEMA = 'approve-exec-context-v1';
export const PROVENANCE_KIND = 'context-brief';
const BRIEF_KEYS = ['schema', 'slug', 'goal', 'repo', 'base', 'source', 'prs'];
const SOURCE_KEYS = ['session_id', 'approved_message', 'approved_at'];
const PR_KEYS = ['pr_id', 'title_cn', 'why', 'how', 'excerpts', 'allowed_paths', 'forbidden', 'scs', 'verify_cmds', 'needs_three_review', 'depends_on'];
const SC_KEYS = ['id', 'kind', 'change', 'holds', 'expect', 'anchor_paths'];
const SC_KINDS = ['fix', 'verify'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SUBMIT_FORMAT = '按开工包第 10 段回报：candidate record-delivery（含 collateral_used）+ pr_ready note-event + decision_required 人读报告';

const reject = (msg) => { throw new LedgerError('BRIEF', msg); };
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function exact(obj, keys, what) {
  if (!isObj(obj)) reject(`${what} 必须是对象`);
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !Object.hasOwn(obj, k));
  if (extra.length || missing.length) reject(`${what} 键集不符（多: ${extra.join(',') || '无'}；缺: ${missing.join(',') || '无'}）`);
}

function repoPaths(list, what, { allowEmpty }) {
  if (!Array.isArray(list) || (!allowEmpty && list.length === 0)) reject(`${what} 必须是${allowEmpty ? '' : '非空'}数组`);
  return list.map((p, i) => {
    const n = normalizeRepoPath(p);
    if (!n.ok) reject(`${what}[${i}] 非法（${n.reason}）: ${p}`);
    return n.path;
  });
}

/** 纯校验：brief 形状与语义（不碰磁盘，除非给 repoDir）。返回规范化后的 prs。 */
export function validateBrief(brief, { repoDir } = {}) {
  exact(brief, BRIEF_KEYS, 'brief');
  if (brief.schema !== BRIEF_SCHEMA) reject(`brief.schema 必须是 ${BRIEF_SCHEMA}（当前: ${brief.schema}）`);
  if (!ID_RE.test(brief.slug ?? '')) reject(`brief.slug 只允许字母数字与 _.-（当前: ${brief.slug}）`);
  if (!text(brief.goal)) reject('brief.goal 必须是非空字符串');
  if (!REPO_RE.test(brief.repo ?? '')) reject(`brief.repo 必须是 owner/name（当前: ${brief.repo}）`);
  if (!SHA_RE.test(brief.base ?? '')) reject(`brief.base 必须是 40 位小写十六进制 SHA（当前: ${brief.base}）`);
  exact(brief.source, SOURCE_KEYS, 'brief.source');
  for (const k of SOURCE_KEYS) if (!text(brief.source[k])) reject(`brief.source.${k} 必须是非空字符串`);
  if (!Number.isFinite(Date.parse(brief.source.approved_at))) reject(`brief.source.approved_at 不是可解析时间: ${brief.source.approved_at}`);
  if (!Array.isArray(brief.prs) || brief.prs.length === 0) reject('brief.prs 必须是非空数组');

  const prIds = new Set();
  const scIds = new Set();
  const prs = brief.prs.map((pr, i) => {
    const at = `brief.prs[${i}]`;
    exact(pr, PR_KEYS, at);
    if (!ID_RE.test(pr.pr_id ?? '')) reject(`${at}.pr_id 只允许字母数字与 _.-（当前: ${pr.pr_id}）`);
    if (prIds.has(pr.pr_id)) reject(`${at}.pr_id 重复: ${pr.pr_id}`);
    prIds.add(pr.pr_id);
    try { assertTaskHasHan(pr.title_cn, `${at}.title_cn`); } catch (err) { reject(err.message); }
    if (!text(pr.why)) reject(`${at}.why 必须是非空字符串（一条用户能看见的失败）`);
    if (!text(pr.how)) reject(`${at}.how 必须是非空字符串（具体改法）`);
    if (pr.how.trim() === pr.why.trim()) reject(`${at}.how 不得复制 why`);
    if (!Array.isArray(pr.excerpts) || pr.excerpts.length === 0) reject(`${at}.excerpts 至少 1 条 {file,line,behavior}`);
    const excerpts = pr.excerpts.map((e, j) => {
      exact(e, ['file', 'line', 'behavior'], `${at}.excerpts[${j}]`);
      const n = normalizeRepoPath(e.file);
      if (!n.ok) reject(`${at}.excerpts[${j}].file 非法（${n.reason}）: ${e.file}`);
      if (!Number.isSafeInteger(e.line) || e.line < 1) reject(`${at}.excerpts[${j}].line 必须是正整数`);
      if (!text(e.behavior)) reject(`${at}.excerpts[${j}].behavior 必须是非空字符串`);
      return { file: n.path, line: e.line, behavior: e.behavior };
    });
    const allowed = repoPaths(pr.allowed_paths, `${at}.allowed_paths`, { allowEmpty: false });
    if (new Set(allowed).size !== allowed.length) reject(`${at}.allowed_paths 含重复路径`);
    if (!Array.isArray(pr.forbidden) || pr.forbidden.some((f) => !text(f))) reject(`${at}.forbidden 必须是非空字符串数组（可为空数组）`);
    if (!Array.isArray(pr.verify_cmds) || pr.verify_cmds.length === 0 || pr.verify_cmds.some((c) => !text(c))) {
      reject(`${at}.verify_cmds 必须是非空字符串数组`);
    }
    if (typeof pr.needs_three_review !== 'boolean') reject(`${at}.needs_three_review 必须是布尔（功能 PR=true；禁止缺省成 false）`);
    if (!Array.isArray(pr.depends_on) || pr.depends_on.some((d) => !text(d))) reject(`${at}.depends_on 必须是字符串数组（可为空数组）`);
    if (!Array.isArray(pr.scs) || pr.scs.length === 0) reject(`${at}.scs 必须是非空数组`);
    const scs = pr.scs.map((sc, j) => {
      const sat = `${at}.scs[${j}]`;
      exact(sc, SC_KEYS, sat);
      if (!ID_RE.test(sc.id ?? '')) reject(`${sat}.id 只允许字母数字与 _.-（当前: ${sc.id}）`);
      if (scIds.has(sc.id)) reject(`${sat}.id 全局重复: ${sc.id}`);
      scIds.add(sc.id);
      if (!SC_KINDS.includes(sc.kind)) reject(`${sat}.kind 只允许 ${SC_KINDS.join('/')}（probe 阶段须走 task-priority + pr-map）`);
      for (const k of ['change', 'holds', 'expect']) if (!text(sc[k])) reject(`${sat}.${k} 必须是非空字符串`);
      const anchors = repoPaths(sc.anchor_paths, `${sat}.anchor_paths`, { allowEmpty: false });
      return { id: sc.id, priority_id: pr.pr_id, kind: sc.kind, granularity: 'pr', change: sc.change, holds: sc.holds, expect: sc.expect, anchor_paths: anchors };
    });
    return { ...pr, excerpts, allowed_paths: allowed, scs };
  });
  for (const pr of prs) {
    for (const d of pr.depends_on) {
      if (!prIds.has(d)) reject(`${pr.pr_id}.depends_on 指向不存在的 PR: ${d}`);
      if (d === pr.pr_id) reject(`${pr.pr_id}.depends_on 不能依赖自己`);
    }
  }
  if (repoDir) checkAgainstRepo(prs, repoDir);
  return prs;
}

function checkAgainstRepo(prs, repoDir) {
  if (!existsSync(repoDir)) reject(`--repo-dir 不存在: ${repoDir}`);
  let scripts = null;
  const pkgPath = join(repoDir, 'package.json');
  if (existsSync(pkgPath)) {
    try { scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {}; } catch (err) { reject(`读取 ${pkgPath} 失败: ${err.message}`); }
  }
  for (const pr of prs) {
    try { assertExcerpts(pr.excerpts, { worktree: repoDir }); } catch (err) { reject(`${pr.pr_id}: ${err.message}`); }
    // 写域只收文件：下游 ready-check 把 allowed_paths 当前缀白名单，给目录等于放开整棵子树
    for (const p of pr.allowed_paths) {
      if (existsSync(join(repoDir, p)) && statSync(join(repoDir, p)).isDirectory()) reject(`${pr.pr_id} allowed_paths 只能写文件，不能写目录: ${p}`);
    }
    const willCreate = new Set(pr.allowed_paths);
    for (const cmd of pr.verify_cmds) {
      const npmRun = cmd.match(/\bnpm\s+run\s+([^\s;&|]+)/g) ?? [];
      for (const m of npmRun) {
        const name = m.split(/\s+/).pop().replace(/^(['"])(.*)\1$/, '$2');
        if (!scripts || !Object.hasOwn(scripts, name)) reject(`${pr.pr_id} 验证命令引用了仓里不存在的 npm script: ${name}（${cmd}）`);
      }
      for (const token of cmd.split(/\s+/)) {
        const t = token.replace(/^['"]|['"]$/g, '');
        if (!/^[\w.@-]+(\/[\w.@-]+)+\.[A-Za-z0-9]+$/.test(t)) continue; // 只核形如 a/b.ext 的仓内相对路径
        if (!existsSync(join(repoDir, t)) && !willCreate.has(t)) {
          reject(`${pr.pr_id} 验证命令引用了不存在、也不在本 PR 写域里的路径: ${t}（${cmd}）`);
        }
      }
    }
  }
}

function planWaves(prs) {
  const deps = new Map(prs.map((pr) => [pr.pr_id, new Set(pr.depends_on)]));
  let order;
  try { order = layers(prs.map((pr) => pr.pr_id), deps); } catch (err) { reject(`depends_on 无法分层：${err.message}`); }
  const byId = new Map(prs.map((pr) => [pr.pr_id, pr]));
  order.forEach((ids) => {
    for (let a = 0; a < ids.length; a += 1) for (let b = a + 1; b < ids.length; b += 1) {
      // 相等或一方是另一方的目录前缀都算撞写域（brief 没带 --repo-dir 时也能拦住 scripts vs scripts/x.mjs）
      const overlaps = (x, y) => x === y || y.startsWith(x + '/') || x.startsWith(y + '/');
      const shared = byId.get(ids[a]).allowed_paths.filter((p) => byId.get(ids[b]).allowed_paths.some((q) => overlaps(p, q)));
      if (shared.length) reject(`${ids[a]} 与 ${ids[b]} 同波并行却写同一文件（${shared.join(', ')}）；用 depends_on 串行或拆开写域`);
    }
  });
  return order.map((ids, wave) => ({ wave, groups: ids.map((id) => ({ group_id: id, sc_ids: byId.get(id).scs.map((s) => s.id), worker_count: 1 })) }));
}

/** 纯函数：brief → manifest（含 manifest_core_hash）。 */
export function buildManifest(brief, { repoDir } = {}) {
  const prs = validateBrief(brief, { repoDir });
  const waves = planWaves(prs);
  const briefSha = hashObject(brief);
  const manifest = {
    schema_version: MANIFEST_SCHEMA,
    slug: brief.slug,
    goal: brief.goal,
    context_refs: [],
    provenance: {
      kind: PROVENANCE_KIND,
      brief_sha256: briefSha,
      repo: brief.repo,
      base: brief.base,
      source: { ...brief.source },
      note: '上下文方案入口：未经 task-priority 七面覆盖与对抗质询；派工总表与 PR 描述须标注来源',
    },
    // 不写 pr_split：run-ledger init 见到 pr_split 会当作分阶段计划、要求 --pr-map；上下文方案本身就是一 PR 一组
    priorities: prs.map((pr) => ({ id: pr.pr_id, title: pr.title_cn, why: pr.why })),
    scs: prs.flatMap((pr) => pr.scs),
    waves,
    dispatch: {
      capacity: { source: 'context-intake', max_parallel: Math.max(...waves.map((w) => w.groups.length)) },
      packets: prs.map((pr) => ({
        group_id: pr.pr_id,
        title_cn: pr.title_cn,
        scs_inline: pr.scs,
        allowed_paths: pr.allowed_paths,
        forbidden: pr.forbidden,
        verify_cmds: pr.verify_cmds,
        submit_format: SUBMIT_FORMAT,
        instruction: pr.why,
        why: pr.why,
        how: pr.how,
        excerpts: pr.excerpts,
        needs_three_review: pr.needs_three_review,
      })),
    },
    receipts: [],
  };
  manifest.manifest_core_hash = manifestCoreHash(manifest);
  assertManifestComplete(manifest);
  return manifest;
}

function writeJsonAtomicNew(path, obj) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, path);
}

export function runIntake({ briefPath, outDir, now, repoDir }) {
  if (!briefPath || !outDir) reject('缺 --brief 或 --out-dir');
  if (!text(now) || !Number.isFinite(Date.parse(now))) reject('缺 --now <ISO 时间>（确定性写入，禁止缺省）');
  let brief;
  try { brief = JSON.parse(readFileSync(resolve(briefPath), 'utf8')); } catch (err) { reject(`brief 读取/解析失败（${briefPath}）: ${err.message}`); }
  const manifest = buildManifest(brief, { repoDir: repoDir ? resolve(repoDir) : undefined });
  const dir = resolve(outDir);
  const manifestPath = join(dir, 'task-manifest.json');
  if (existsSync(manifestPath)) {
    let prev = null;
    try { prev = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* 下行按非本入口产物拒 */ }
    if (prev?.provenance?.kind !== PROVENANCE_KIND) reject(`${manifestPath} 已存在且不是上下文入口产物（可能是 task-priority final），拒绝覆盖；换 --out-dir`);
  }
  mkdirSync(dir, { recursive: true });
  writeJsonAtomicNew(manifestPath, manifest);
  readManifest(manifestPath); // 回读过同一输入门，防写坏
  const receipt = {
    schema: 'approve-exec-intake-receipt-v1',
    slug: manifest.slug,
    brief_path: resolve(briefPath),
    brief_sha256: manifest.provenance.brief_sha256,
    manifest_path: manifestPath,
    manifest_core_hash: manifest.manifest_core_hash,
    source: manifest.provenance.source,
    repo_checked: Boolean(repoDir),
    created_at: now,
  };
  const receiptPath = join(dir, 'intake-receipt.json');
  writeJsonAtomicNew(receiptPath, receipt);
  return {
    ok: true,
    manifest_path: manifestPath,
    receipt_path: receiptPath,
    manifest_core_hash: manifest.manifest_core_hash,
    waves: manifest.waves.map((w) => w.groups.map((g) => g.group_id)),
    repo_checked: Boolean(repoDir),
  };
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) reject(`非法参数: ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) reject(`参数 ${a} 缺值`);
    flags[a.slice(2)] = v;
    i += 1;
  }
  return flags;
}

if (isMain(import.meta.url)) {
  try {
    const f = parseFlags(process.argv.slice(2));
    const out = runIntake({ briefPath: f.brief, outDir: f['out-dir'], now: f.now, repoDir: f['repo-dir'] });
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    const code = err instanceof LedgerError ? err.code : 'UNEXPECTED';
    console.error(`context-intake: [${code}] ${err.message}`);
    process.exit(2);
  }
}
