// Local repair authority. Comment bodies are evidence, never standing permission.
// Pure and bounded: callers provide an already-collected feedback item and HEAD.
export const FEEDBACK_POLICY_VERSION = 1;
const INFRA = new Set(['INCOMPLETE', 'CI-NOT-GREEN', 'SKIP-LLM', 'SKIP-LOCAL', 'REFUSE', 'WINDOW-CLOSED', 'PARSE-FAILED', 'HELPERS-MISSING', 'UNHEALTHY']);
const aliases = { P0: 'P0', CRITICAL: 'P0', P1: 'P1', HIGH: 'P1', P2: 'P2', MEDIUM: 'P2', P3: 'P3', LOW: 'P3' };
const TOKEN = '(P[0-3]|CRITICAL|HIGH|MEDIUM|LOW)';
const severityHeading = new RegExp('^(?:#{1,6}\\s+)?(?:[-*+]\\s+|\\d+[.)]\\s+)?(?:🤖 自动 Review\\s*·\\s*)?(?:\\*\\*|\\[)?' + TOKEN + '(?:\\*\\*|\\])?(?=\\s|:|：|[-—–]|$)(.*)$', 'i');
const verdictHeading = /^## 🤖 自动 Review 结论[：:]\s*(\S+)\s*$/m;

export function isGreptileAuthor(author) {
  const login = typeof author === 'string' ? author : author?.login;
  return login === 'greptile-apps' || login === 'greptile-apps[bot]';
}
function trustedReviewer(item) {
  const author = item.user ?? item.author;
  const login = typeof author === 'string' ? author : author?.login;
  // source=greptile is also the historic collector's normalized provenance.
  return item.source === 'greptile' || isGreptileAuthor(author)
    || ['github-actions', 'github-actions[bot]'].includes(login);
}
function visibleLines(body) {
  const lines = body.replace(/<!--[^]*?-->/g, '').split(/\r?\n|\\n/);
  let fence = null;
  let agentPrompt = false;
  return lines.flatMap(line => {
    const trimmed = line.trim();
    if (agentPrompt) { if (/<\/details>/i.test(trimmed)) agentPrompt = false; return []; }
    const marker = /^(?:`{3,}|~{3,})/.exec(trimmed)?.[0];
    if (marker) { if (!fence) fence = marker[0]; else if (marker[0] === fence) fence = null; return []; }
    if (fence || /^>/.test(trimmed)) return [];
    if (/prompt for (?:ai|coding)|ai (?:agent|coding).*prompt|修复提示词/i.test(trimmed)) { agentPrompt = true; return []; }
    return [trimmed];
  });
}
const result = (action, severities, reason) => ({ policyVersion: FEEDBACK_POLICY_VERSION, action,
  canChangeCode: ['code-fix', 'required-ci-fix', 'conflict-fix'].includes(action), severities, reason });

export function feedbackRepairPolicy(item = {}, { headSha } = {}) {
  if (!item || typeof item !== 'object') return result('needs-triage', [], 'invalid-feedback');
  if (item.actionable === false) return result('ignore-infra', [], 'non-actionable-or-resolved');
  if (headSha && item.sha && item.sha !== headSha) return result('needs-triage', [], 'stale-head');
  if (item.source === 'ci' || item.source === 'conflict') {
    if (!headSha || item.sha !== headSha) return result('needs-triage', [], 'unbound-head');
    if (item.source === 'conflict') return result('conflict-fix', [], 'current-merge-conflict');
    const proof = item.requiredFailure;
    if (proof && (proof.verified !== true || proof.status !== 'failed' || proof.headSha !== headSha)) {
      return result('needs-triage', [], 'invalid-required-ci-evidence');
    }
    // Legacy task CI items were emitted only by failedRequiredCiItems. Do not
    // infer CI authority from a comment mentioning checks or from optional checks.
    return result('required-ci-fix', [], proof ? 'verified-required-ci-failure' : 'legacy-required-ci-failure');
  }
  if (!trustedReviewer(item)) return result('needs-triage', [], 'unverified-review-source');
  const body = String(item.body ?? '');
  if (body.length > 256 * 1024) return result('needs-triage', [], 'feedback-too-large');
  const lines = visibleLines(body);
  const heading = verdictHeading.exec(lines.join('\n'))?.[1]?.toUpperCase();
  if (INFRA.has(heading)) return result('ignore-infra', [], 'review-infrastructure');
  const substantive = lines.filter(line => line && !verdictHeading.test(line)
    && !/^(?:mivo-code-review depth=\S+ head_sha=[a-f0-9]{40}|review-complete head_sha=[a-f0-9]{40} base_sha=[a-f0-9]{40})$/.test(line));
  if (!substantive.length) return result('ignore-infra', [], 'review-marker-only');
  const severities = [];
  let summaryHigh = false;
  for (const line of substantive) {
    if (/三席聚合|(?:findings?|severity)\s*(?:counts?|summary)|汇总|统计/i.test(line)) {
      if (/(?:P[01]|CRITICAL|HIGH)\s*[:：]?\s*[1-9]\d*/i.test(line)) summaryHigh = true;
      continue;
    }
    const findingLine = line
      .replace(/^(?:#{1,6}\s+)?(?:<a\b[^>]*>\s*)?<img\b[^>]*\balt=["'](P[0-3])(?: Badge)?["'][^>]*>\s*(?:<\/a>)?\s*/i, '$1: ')
      .replace(/^(#{1,6}\s*)?!\[(P[0-3])(?: Badge)?\]\([^)]*\)\s*/i, '$1$2: ')
      .replace(/^(#{1,6}\s*)?\*\*\[(P[0-3]|CRITICAL|HIGH|MEDIUM|LOW)\]\*\*/i, '$1$2:')
      .replace(/^(?:severity|priority|严重度|优先级)\s*[:：]\s*/i, '');
    const match = severityHeading.exec(findingLine);
    if (!match) continue;
    const remainder = match[2].replace(/^[:：\s—–-]+/, '');
    // Severity counts and negative declarations are not finding headers.
    if (/^(?:\d+(?:\s|$)|none\b|zero\b|no\b|无|没有|零)/i.test(remainder)) continue;
    if (/^\s*[:：]?\s*0\s*(?:findings?|issues?|项|个)?\s*$/i.test(remainder)) continue;
    const severity = aliases[match[1].toUpperCase()];
    if (!severities.includes(severity)) severities.push(severity);
  }
  const high = severities.some(s => s === 'P0' || s === 'P1');
  const low = severities.some(s => s === 'P2' || s === 'P3');
  if (high && heading === 'APPROVE') return result('needs-triage', severities, 'approve-conflicts-with-high-finding');
  // Structurally separable only when each severity came from its own line (no
  // single line mixes a high token with a low token). A single line mixing
  // both cannot be attributed to one finding or the other, so it can never
  // authorize a split fix even if the header scan only recognized one of them.
  const mixedOnSameLine = substantive.some((line) => {
    if (/三席聚合|(?:findings?|severity)\s*(?:counts?|summary)|汇总|统计/i.test(line)) return false;
    const tokens = line.match(/P[0-3]|CRITICAL|HIGH|MEDIUM|LOW/gi) ?? [];
    if (tokens.length < 2) return false;
    const mapped = tokens.map((t) => aliases[t.toUpperCase()]);
    return mapped.some((s) => s === 'P0' || s === 'P1') && mapped.some((s) => s === 'P2' || s === 'P3');
  });
  if (mixedOnSameLine) return result('needs-triage', severities, 'mixed-severity-inseparable');
  if (high && low) return result('code-fix', severities, 'mixed-severity-high-authorized-low-no-change');
  if (summaryHigh && !high) return result('needs-triage', severities, 'high-summary-without-finding');
  if (high) return result('code-fix', severities, 'explicit-p0-p1-finding');
  if (low) return result('reply-only', severities, 'p2-p3-no-code-authority');
  // A Greptile overview scored 5/5 with no severity finding is a clean bill, not
  // a finding; its inline findings arrive as separate, graded items.
  if (/<!--\s*greptile_summary\s*-->/i.test(body) && /Confidence Score:\s*5\s*\/\s*5/i.test(body)) {
    return result('ignore-infra', [], 'greptile-summary-clean');
  }
  return result('needs-triage', [], 'severity-unconfirmed');
}

export function taskRepairPolicy(task = {}) {
  const feedback = Array.isArray(task.feedback) ? task.feedback : [];
  const items = feedback.map((item, index) => ({ key: item?.key ?? `${item?.source ?? 'unknown'}:${item?.nativeId ?? index}`,
    ...(/^[a-f0-9]{40}$/.test(task.headRefOid ?? '')
      ? feedbackRepairPolicy(item, { headSha: task.headRefOid })
      : result('needs-triage', [], 'task-head-unbound')) }));
  return { policyVersion: FEEDBACK_POLICY_VERSION, canChangeCode: items.some(item => item.canChangeCode), items,
    allowedFeedbackKeys: items.filter(item => item.canChangeCode).map(item => item.key) };
}
