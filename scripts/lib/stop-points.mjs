// 额外停点（extra stop point）检测：lead 可写的开工包文字（第 2/4/9 段、forbiddenExtra、段外补充）
// 不得在第⑧节五类停之外给 owner 加「停下等 lead / 禁止 push / 派单审 / 压过第 8 段」。
// 教训：2026-09-25 mivo-unlimited-import PR3，lead 补充「优先于第 8 段」要求派 GPT 单审、停下等「开 PR」，
// owner 照做停在 push 前。纯函数；T1 纪律级：防手写补充越权，不防蓄意变形措辞。

const NEGATION = /(禁止|不得|不要|不再|勿|别|无需|不需要|不)\s*$/;

// 强制推送另有硬停，属于合法禁令；先剥掉再判普通 push
const FORCE_PUSH = /force[\s-]*push|push\s+(--force(-with-lease)?|-f)\b|强推/gi;
// 直推默认分支同样是既有红线
const DEFAULT_BRANCH_PUSH = /push[^。；\n]{0,12}(main|master|默认分支)|(main|master|默认分支)[^。；\n]{0,6}push/gi;

const RULES = [
  { id: 'override-section-8', re: /(优先于|压过|覆盖|替代|取代)\s*第\s*[8八⑧]\s*[段节]/ },
  { id: 'wait-for-lead', re: /(停下|停住|暂停|停在)[^。；\n]{0,24}等[^。；\n]{0,8}lead/i },
  { id: 'wait-for-lead', re: /等\s*lead[^。；\n]{0,12}(「|“|")?\s*(开\s*PR|放行|批准|点头|验收)/i },
  { id: 'wait-for-lead', re: /lead[^。；\n]{0,16}(下达|给出|说)[^。；\n]{0,6}(「|“|")?\s*开\s*PR/i },
];

// 「派/加/先做 … 单审/reviewer」前面没有否定词才算加停点
const REVIEW = /(派|加派|先派|需要|必须|要求)[^。；\n]{0,10}(GPT|Claude|gpt|claude)?[^。；\n]{0,4}(单审|reviewer|审核席|review\s*worker)/g;
// 禁做条目里出现普通 push / 开 PR = 把已授权收尾改成禁令
const PUSH_OR_OPEN = /\bgit\s+push\b|\bpush\b|gh\s+pr\s+create|开\s*PR|推送/i;

function reviewHits(line) {
  const hits = [];
  for (const m of line.matchAll(REVIEW)) {
    if (!NEGATION.test(line.slice(0, m.index))) hits.push(m[0]);
  }
  return hits;
}

/**
 * @param {string} text 待查文字
 * @param {{ forbiddenItem?: boolean }} [opts] forbiddenItem=true 时按「禁做条目」口径额外拦普通 push / 开 PR
 * @returns {{ rule: string, excerpt: string }[]}
 */
export function findExtraStopPoints(text, { forbiddenItem = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const found = [];
  for (const line of text.split('\n')) {
    for (const { id, re } of RULES) {
      const m = line.match(re);
      if (m) found.push({ rule: id, excerpt: m[0] });
    }
    for (const hit of reviewHits(line)) found.push({ rule: 'local-review', excerpt: hit });
    if (forbiddenItem) {
      const stripped = line.replace(FORCE_PUSH, '').replace(DEFAULT_BRANCH_PUSH, '');
      const m = stripped.match(PUSH_OR_OPEN);
      if (m) found.push({ rule: 'forbid-authorized-push', excerpt: m[0] });
    }
  }
  return found;
}

export function formatStopPoints(where, hits) {
  return `${where} 含第⑧节五类停以外的停点（${hits.map((h) => `${h.rule}:「${h.excerpt}」`).join('；')}）。`
    + 'owner 的 push / 开 Draft PR / 转 Ready 由第 8 段与 OWNER_STANDING_AUTH 决定，lead 不得另加等待；确需收窄授权请改授权声明或走 replan';
}
