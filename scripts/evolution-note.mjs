#!/usr/bin/env node
// evolution-note.mjs — approve-exec 自进化台账的唯一读写通道（对应 SKILL ⑱）。
// 抄 task-priority：默认不碰 git；显式 --sync 才 commit+push 两个台账文件。
//
//   - <SKILL_ROOT>/evolution/ledger.json : 唯一事实源
//   - <SKILL_ROOT>/EVOLUTION.md          : 由 ledger 全量再生成（手改会被覆盖）
//
// tier: by-design | proposal | auto。扩权与拿不准 = proposal，永不自动落地。
// 测试隔离：APPROVE_EXEC_SKILL_ROOT 重定向根目录。

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = process.env.APPROVE_EXEC_SKILL_ROOT
  ? resolve(process.env.APPROVE_EXEC_SKILL_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_DIR = join(SKILL_ROOT, 'evolution');
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.json');
const MD_FILE = join(SKILL_ROOT, 'EVOLUTION.md');

const FINGERPRINT_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TIERS = ['by-design', 'proposal', 'auto'];
const STATUSES = ['open', 'landed', 'adopted', 'rejected', 'tracked'];

const print = (obj) => console.log(JSON.stringify(obj, null, 2));
const fail = (e) => {
  console.error(String(e?.message || e));
  process.exit(1);
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
}

function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeLedger(ledger) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2) + '\n');
  writeFileSync(MD_FILE, renderMd(ledger));
}

function syncLedger(message) {
  if (!process.argv.includes('--sync')) return { skipped: 'no-sync-default' };
  const git = (a) => execFileSync('git', ['-C', SKILL_ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['rev-parse', '--is-inside-work-tree']);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (branch !== 'main' && branch !== 'master') return { ok: false, reason: `非 main 分支:${branch},不自动推送` };
    git(['add', '--', 'evolution/ledger.json', 'EVOLUTION.md']);
    const status = git(['status', '--porcelain', '--', 'evolution/ledger.json', 'EVOLUTION.md']).trim();
    if (!status) return { ok: true, skipped: 'no-change' };
    git(['commit', '-m', message, '--', 'evolution/ledger.json', 'EVOLUTION.md']);
    try {
      git(['push', 'origin', branch]);
      return { ok: true, committed: true, pushed: true };
    } catch (e) {
      return { ok: true, committed: true, pushed: false, pushError: String(e?.stderr || e?.message || e).slice(0, 200) };
    }
  } catch (e) {
    return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 300) };
  }
}

const fmtDate = (iso) => (iso ?? '').slice(0, 10);

function renderMd(ledger) {
  const groups = [
    ['proposal', '## 待维护者拍板(扩权类提案,永不自动落地)', (e) => e.status !== 'rejected'],
    ['auto', '## 已自动落地(拆错/补救工具缺口,不放宽口径)', () => true],
    ['by-design', '## 无法自动化(by-design,只计数观察)', () => true],
  ];
  const rejected = ledger.entries.filter((e) => e.tier === 'proposal' && e.status === 'rejected');
  let md = '# approve-exec 自进化台账\n\n';
  md += '自动生成:由 `scripts/evolution-note.mjs` 从 `evolution/ledger.json` 再生成,**手改本文件会被覆盖**。\n';
  md += '条目按根因 fingerprint 去重;分类与落地规则见 SKILL.md 第⑱节。\n';
  for (const [tier, heading, keep] of groups) {
    const entries = ledger.entries.filter((e) => e.tier === tier && keep(e));
    if (!entries.length) continue;
    md += `\n${heading}\n\n`;
    for (const e of entries.slice().sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))) {
      md += `- \`${e.fingerprint}\` **${e.title}** — 出现 ${e.occurrences} 次,首见 ${fmtDate(e.firstSeen)},最近 ${fmtDate(e.lastSeen)},status: ${e.status}${e.commit ? `,commit \`${e.commit}\`` : ''}\n`;
      if (e.detail) md += `  - 现象:${e.detail}\n`;
      if (e.proposal) md += `  - 提案:${e.proposal}\n`;
      if (e.note) md += `  - 备注:${e.note}\n`;
    }
  }
  if (rejected.length) {
    md += '\n## 已否决的提案(留档防止重复提出)\n\n';
    for (const e of rejected) {
      md += `- \`${e.fingerprint}\` ${e.title}${e.note ? ` — ${e.note}` : ''}\n`;
    }
  }
  return md;
}

try {
  const cmd = process.argv[2];
  const ledger = readLedger();

  if (cmd === 'list') {
    print({ ok: true, ledgerFile: LEDGER_FILE, mdFile: MD_FILE, count: ledger.entries.length, entries: ledger.entries });
    process.exit(0);
  }

  const fingerprint = arg('fingerprint');
  if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
    throw new Error('缺少或不合法的 --fingerprint(根因 slug:小写字母/数字/连字符,3-64 位)');
  }

  if (cmd === 'add') {
    const tier = arg('tier');
    const title = arg('title');
    if (!TIERS.includes(tier)) throw new Error(`--tier 必须是 ${TIERS.join('|')}`);
    if (!title) throw new Error('缺少 --title(一句话根因)');
    const detail = arg('detail');
    const proposal = arg('proposal');
    const commit = arg('commit');
    const now = new Date().toISOString();

    let entry = ledger.entries.find((e) => e.fingerprint === fingerprint);
    const isNew = !entry;
    if (isNew) {
      entry = {
        fingerprint,
        tier,
        title,
        detail: detail ?? null,
        proposal: proposal ?? null,
        status: tier === 'auto' ? (commit ? 'landed' : 'open') : tier === 'proposal' ? 'open' : 'tracked',
        commit: commit ?? null,
        note: null,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
      };
      ledger.entries.push(entry);
    } else {
      entry.occurrences += 1;
      entry.lastSeen = now;
      if (detail) entry.detail = detail;
      if (proposal) entry.proposal = proposal;
      if (commit) { entry.commit = commit; if (entry.tier === 'auto') entry.status = 'landed'; }
      if (tier && tier !== entry.tier && entry.tier !== 'proposal') entry.tier = tier;
    }
    writeLedger(ledger);
    const sync = syncLedger(`evo: ledger ${fingerprint}`);
    print({
      ok: true, isNew, entry, sync, ledgerFile: LEDGER_FILE, mdFile: MD_FILE,
      note: isNew ? '新根因:在收尾摘要「自进化」组里向用户报告' : '已知根因(去重命中):只自增计数,不必重复分析与报告',
    });
    process.exit(0);
  }

  if (cmd === 'set-status') {
    const status = arg('status');
    if (!STATUSES.includes(status)) throw new Error(`--status 必须是 ${STATUSES.join('|')}`);
    const entry = ledger.entries.find((e) => e.fingerprint === fingerprint);
    if (!entry) throw new Error(`台账中没有 fingerprint=${fingerprint} 的条目`);
    entry.status = status;
    const note = arg('note');
    if (note) entry.note = note;
    writeLedger(ledger);
    const sync = syncLedger(`evo: ledger ${fingerprint} status=${status}`);
    print({ ok: true, entry, sync, ledgerFile: LEDGER_FILE, mdFile: MD_FILE });
    process.exit(0);
  }

  throw new Error('用法:evolution-note.mjs <add|set-status|list> …');
} catch (e) {
  fail(e);
}
