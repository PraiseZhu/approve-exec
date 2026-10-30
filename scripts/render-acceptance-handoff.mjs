#!/usr/bin/env node
// render-acceptance-handoff.mjs — 总 issue 验收通过后，lead 发给验收机的交接评论（PraiseZhu/approve-exec#79）。
// 首行和「## 请重点查」下的编号列表是验收机（PraiseZhu/vigil#140）解析的锚点，不改格式。
// 交接只是线索：验收机照样逐条自己验，所以这里只写 lead 看到的事实，不写本机路径。

/** 七个二级标题，顺序固定。 */
export const HANDOFF_SECTIONS = Object.freeze(['结论', '子 PR', '整体验收项', '请重点查', 'lead 没验到的', '上线后验证', '范围核对']);
/** lead 对总 issue 每条 SC 的结论。「未通过」不交接：先补子 issue。 */
export const SC_RESULTS = Object.freeze(['通过', '未通过', '人工手测']);
/**
 * 本机绝对路径：交接发到 GitHub，不能带。只认独立出现的路径开头（前面不是字母、数字、`.`、`/`、`:`、`-`），
 * URL 里的 `/tmp/` 这类不算；盘符 `C:\` 和 `C:/` 都算（review-pr82）。
 */
export const LOCAL_PATH_RE = /(?<![\w.\/:-])(?:\/Users\/|\/home\/|\/tmp\/|\/private\/|\/var\/folders\/|[A-Za-z]:[\\/])/;

const SC_LINE = /^\s*[-*]\s*\[[ xX]\]\s*(?:\*\*)?(SC\d+)\b(?:\*\*)?\s*(.*)$/;

export function handoffFirstLine(n) {
  return `[批准执行] 交接验收 · 第 ${n} 次`;
}

/** 总 issue（或独立 issue）正文里的验收项：`- [ ] SC<n> …` 行。 */
export function rootScs(body) {
  const out = [];
  for (const line of String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const m = SC_LINE.exec(line);
    if (m && !out.some((s) => s.id === m[1])) out.push({ id: m[1], text: m[2].trim() });
  }
  return out;
}

const list = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : null);

/** lead 填的结果：结论、每条 SC 一行（覆盖总 issue 的全部 SC、没有「未通过」）、其余几节是字符串数组。返回不合格的地方。 */
export function validateResult({ result, scs }) {
  const problems = [];
  if (!result || typeof result !== 'object') return ['结果文件不是 JSON 对象'];
  if (!String(result.conclusion ?? '').trim()) problems.push('缺 conclusion（结论）');
  const rows = Array.isArray(result.sc) ? result.sc : [];
  if (!Array.isArray(result.sc)) problems.push('sc 必须是数组 [{"id":"SC1","result":"通过","evidence":"…"}]');
  const want = scs.map((s) => s.id);
  const got = rows.map((r) => r?.id);
  const missing = want.filter((id) => !got.includes(id));
  const extra = got.filter((id) => !want.includes(id));
  if (missing.length) problems.push(`缺总 issue 的 ${missing.join('、')}`);
  if (extra.length) problems.push(`总 issue 没有 ${extra.join('、')}`);
  if (new Set(got).size !== got.length) problems.push('sc 有重复的 SC');
  for (const r of rows) {
    if (!SC_RESULTS.includes(r?.result)) problems.push(`${r?.id} 的 result 只能是 ${SC_RESULTS.join(' / ')}（当前: ${r?.result}）`);
    else if (r.result === '未通过') problems.push(`${r.id} 未通过：总 issue 没验过就补子 issue，不交接`);
    if (!String(r?.evidence ?? '').trim()) problems.push(`${r?.id} 缺 evidence（lead 的证据或亲眼看到的情况）`);
  }
  for (const key of ['focus', 'not_verified', 'post_launch', 'scope']) {
    if (result[key] !== undefined && list(result[key]) === null) problems.push(`${key} 必须是字符串数组`);
  }
  return problems;
}

function beijing(iso) {
  return new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim() || '—';

function prRows(check) {
  return check.rows.map((r) => {
    if (r.state === 'closed') return `| ${r.ref} | — | — | — | — | 计划时已关闭 |`;
    const pr = `#${r.pr}${r.merged ? '（已合并）' : ''}`;
    const current = `${r.current_head}${r.head_moved ? '（之后有新提交）' : ''}`;
    const pushers = r.pushed_after_ready ? '会（盯梢按审查意见推）' : '否';
    return `| ${r.ref} | ${pr} | ${r.accepted_head} | ${current} | ${r.lane ?? '—'} | ${pushers} |`;
  });
}

const bullets = (items, numbered = false) => {
  const xs = list(items) ?? [];
  if (!xs.length) return ['- 无'];
  return xs.map((x, i) => (numbered ? `${i + 1}. ${x}` : `- ${x}`));
};

/** 交接评论正文。调用前先过 validateResult；调用后再查一遍 LOCAL_PATH_RE。 */
export function renderAcceptanceHandoff({ ledger, check, result, scs, n, now }) {
  const byId = new Map((result.sc ?? []).map((r) => [r.id, r]));
  const moved = check.rows.filter((r) => r.head_moved).map((r) => `#${r.pr}`);
  return [
    handoffFirstLine(n),
    `总 issue：${ledger.root.ref} · lead 验收：${beijing(now)} · 台账 ${ledger.run_id}`,
    '',
    '## 结论',
    '',
    String(result.conclusion).trim(),
    '',
    '## 子 PR',
    '',
    '| 子 issue | PR | lead 通过时的 head | 当前 head | 车道 | Ready 后还会有人推送吗 |',
    '|---|---|---|---|---|---|',
    ...prRows(check),
    ...(moved.length ? ['', `${moved.join('、')} 在 lead 通过之后又有提交（交接车道，盯梢推的）：这些提交 lead 没看过，请重点查。`] : []),
    '',
    '## 整体验收项',
    '',
    '| SC | lead 结果 | lead 证据 | 给验收机的提示 |',
    '|---|---|---|---|',
    ...scs.map((s) => {
      const r = byId.get(s.id);
      return `| ${s.id} | ${cell(r.result)} | ${cell(r.evidence)} | ${cell(r.hint)} |`;
    }),
    '',
    '## 请重点查',
    '',
    ...bullets(result.focus, true),
    '',
    '## lead 没验到的',
    '',
    ...bullets(result.not_verified),
    '',
    '## 上线后验证',
    '',
    ...bullets(result.post_launch),
    '',
    '## 范围核对',
    '',
    ...bullets(result.scope),
    '',
  ].join('\n');
}
