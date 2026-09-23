// 连带文件（collateral）策略：owner 可在 allowed_paths 之外、按 config/collateral.json 预授权改的文件。
// 纯函数；git 数据由调用方（ready-check）取好传入，便于单测。T1 纪律级：防疏忽越域，不防蓄意伪造 journal。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRepoPath } from './common.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const COLLATERAL_POLICY_PATH = join(ROOT, 'config/collateral.json');
export const COLLATERAL_ITEM_KEYS = Object.freeze(['path', 'class', 'sc_id', 'reason', 'jev_ref']);
export const JEV_REF_KEYS = Object.freeze(['journal', 'line']);
export const COLLATERAL_CLASSES = Object.freeze(['generated', 'legacy_test']);

export class CollateralError extends Error {
  constructor(message) {
    super(message);
    this.code = 'COLLATERAL';
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

function exactKeys(obj, keys, what) {
  if (!isPlainObject(obj)) throw new CollateralError(`${what} 必须是对象`);
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !Object.hasOwn(obj, k));
  if (extra.length || missing.length) {
    throw new CollateralError(`${what} 键集不符（多: ${extra.join(',') || '无'}；缺: ${missing.join(',') || '无'}；期望: ${keys.join(',')}）`);
  }
}

export function loadCollateralPolicy(path = COLLATERAL_POLICY_PATH) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CollateralError(`连带策略读取/解析失败（${path}）: ${err.message}`);
  }
  if (policy.schema_version !== 1) throw new CollateralError(`连带策略 schema_version 必须是 1（当前: ${policy.schema_version}）`);
  for (const k of ['max_files', 'max_lines']) {
    if (!Number.isSafeInteger(policy[k]) || policy[k] < 0) throw new CollateralError(`连带策略 ${k} 必须是非负整数（当前: ${policy[k]}）`);
  }
  const gen = policy.classes?.generated;
  const legacy = policy.classes?.legacy_test;
  if (!isPlainObject(gen) || typeof gen.enabled !== 'boolean' || !Array.isArray(gen.files)) {
    throw new CollateralError('连带策略 classes.generated 需含 enabled(布尔) 与 files(数组)');
  }
  for (const f of gen.files) {
    if (!normalizeRepoPath(f?.path).ok || !nonEmpty(f?.regen) || !nonEmpty(f?.check)) {
      throw new CollateralError(`连带策略 generated.files 条目需含合法 path 与非空 regen/check（当前: ${JSON.stringify(f)}）`);
    }
  }
  if (!isPlainObject(legacy) || typeof legacy.enabled !== 'boolean' || !Array.isArray(legacy.patterns)
    || typeof legacy.min_jev_confidence !== 'number' || !nonEmpty(legacy.jev_choice) || !nonEmpty(legacy.forbidden_added_re)) {
    throw new CollateralError('连带策略 classes.legacy_test 需含 enabled/patterns/min_jev_confidence/jev_choice/forbidden_added_re');
  }
  return policy;
}

/** record-delivery 侧形状校验（exact 键 + 类型）；语义校验在 evaluateCollateral。 */
export function assertCollateralUsedShape(list, what = 'collateral_used') {
  if (!Array.isArray(list)) throw new CollateralError(`${what} 必须是数组（未用连带文件写 []）`);
  const seen = new Set();
  for (const [i, item] of list.entries()) {
    const at = `${what}[${i}]`;
    exactKeys(item, COLLATERAL_ITEM_KEYS, at);
    const norm = normalizeRepoPath(item.path);
    if (!norm.ok) throw new CollateralError(`${at}.path 非法（${norm.reason}）: ${item.path}`);
    if (seen.has(norm.path)) throw new CollateralError(`${at}.path 重复申报: ${item.path}`);
    seen.add(norm.path);
    if (!COLLATERAL_CLASSES.includes(item.class)) throw new CollateralError(`${at}.class 必须是 ${COLLATERAL_CLASSES.join('/')}（当前: ${item.class}）`);
    if (!nonEmpty(item.sc_id)) throw new CollateralError(`${at}.sc_id 必须是非空字符串`);
    if (!nonEmpty(item.reason)) throw new CollateralError(`${at}.reason 必须是非空字符串`);
    if (item.jev_ref !== null) {
      exactKeys(item.jev_ref, JEV_REF_KEYS, `${at}.jev_ref`);
      if (!nonEmpty(item.jev_ref.journal) || !isAbsolute(item.jev_ref.journal)) throw new CollateralError(`${at}.jev_ref.journal 必须是绝对路径`);
      if (!Number.isSafeInteger(item.jev_ref.line) || item.jev_ref.line < 1) throw new CollateralError(`${at}.jev_ref.line 必须是正整数`);
    }
  }
  return list;
}

function readJournalEntry(ref, readText) {
  let text;
  try { text = readText(ref.journal); } catch (err) { return { error: `Jev 留痕读取失败（${ref.journal}）: ${err.message}` }; }
  const line = text.split(/\r?\n/)[ref.line - 1];
  if (!line) return { error: `Jev 留痕 ${ref.journal} 第 ${ref.line} 行不存在` };
  try { return { entry: JSON.parse(line) }; } catch { return { error: `Jev 留痕 ${ref.journal} 第 ${ref.line} 行不是 JSON` }; }
}

/**
 * 语义校验一个 PR 的 collateral_used。
 * @param {object} args
 * @param {object} args.policy          loadCollateralPolicy 结果
 * @param {object} args.packet          本组 packet（allowed_paths / scs_inline）
 * @param {object[]} args.otherPackets  同 run 其它组 packet（跨 PR 写冲突判据）
 * @param {object[]} args.used          交卷里的 collateral_used
 * @param {Map<string,number>} args.changedLines  path → 相对基线新增+删除行数（二进制记 Infinity）
 * @param {Map<string,string[]>} args.addedLines  path → 相对基线新增行文本
 * @param {(p:string)=>string} [args.readText]    读 Jev 留痕（测试注入）
 * @returns {{ paths: string[], violations: string[] }} paths = 通过校验、可并入写域白名单的连带路径
 */
export function evaluateCollateral({ policy, packet, otherPackets = [], used, changedLines, addedLines, readText = (p) => readFileSync(p, 'utf8') }) {
  const violations = [];
  const paths = [];
  try {
    assertCollateralUsedShape(used);
  } catch (err) {
    return { paths, violations: [err.message] };
  }
  if (used.length > policy.max_files) {
    violations.push(`连带文件 ${used.length} 个，超过上限 max_files=${policy.max_files}`);
  }
  const own = new Set(packet?.allowed_paths ?? []);
  const scIds = new Set((packet?.scs_inline ?? []).map((s) => s.id));
  const genFiles = new Set(policy.classes.generated.files.map((f) => f.path));
  const legacy = policy.classes.legacy_test;
  const legacyPatterns = legacy.patterns.map((p) => new RegExp(p));
  const forbiddenAdded = new RegExp(legacy.forbidden_added_re);
  let totalLines = 0;
  for (const item of used) {
    const p = item.path;
    const before = violations.length;
    if (own.has(p)) violations.push(`${p} 已在本组 allowed_paths，不是连带文件，不要申报`);
    const owner = otherPackets.find((op) => (op.allowed_paths ?? []).includes(p));
    if (owner) violations.push(`${p} 在组 ${owner.group_id} 的 allowed_paths 里，跨 PR 写冲突，必须 DECISION_REQUIRED`);
    if (!scIds.has(item.sc_id)) violations.push(`${p} 申报的 sc_id=${item.sc_id} 不是本组 SC`);
    const cls = policy.classes[item.class];
    if (!cls?.enabled) violations.push(`${p} 的类别 ${item.class} 当前未启用（config/collateral.json）`);
    if (item.class === 'generated' && !genFiles.has(p)) {
      violations.push(`${p} 不在 generated.files 清单里，登记类只认清单内路径`);
    }
    if (item.class === 'legacy_test') {
      if (!legacyPatterns.some((re) => re.test(p))) violations.push(`${p} 不是测试文件路径，legacy_test 只允许测试文件`);
      const bad = (addedLines.get(p) ?? []).filter((l) => forbiddenAdded.test(l));
      if (bad.length) violations.push(`${p} 新增了跳过/独占写法（${bad[0].trim()}），不得用 skip/only/todo 绕过`);
      if (item.jev_ref === null) {
        violations.push(`${p} 是 legacy_test，必须附 Jev 判定（jev_ref）`);
      } else {
        const { entry, error } = readJournalEntry(item.jev_ref, readText);
        if (error) violations.push(`${p}: ${error}`);
        else if (entry.choice !== legacy.jev_choice || typeof entry.confidence !== 'number'
          || entry.confidence < legacy.min_jev_confidence || !Array.isArray(entry.paths) || !entry.paths.includes(p)) {
          violations.push(`${p} 的 Jev 判定不足：需 choice=${legacy.jev_choice}、confidence≥${legacy.min_jev_confidence} 且 paths 含该文件（当前 choice=${entry.choice}, confidence=${entry.confidence}）`);
        }
      }
    }
    const lines = changedLines.get(p);
    if (lines === undefined) violations.push(`${p} 申报为连带文件，但相对基线没有改动`);
    else totalLines += lines;
    if (violations.length === before) paths.push(p);
  }
  if (totalLines > policy.max_lines) {
    violations.push(`连带文件改动合计 ${Number.isFinite(totalLines) ? totalLines : '含二进制'} 行，超过上限 max_lines=${policy.max_lines}`);
  }
  return { paths: violations.length ? [] : paths, violations };
}

/** 开工包第 5 段追加文字（与 ready-check 同源读 config/collateral.json）。 */
export function renderCollateralPolicyText(policy) {
  const gen = policy.classes.generated;
  const legacy = policy.classes.legacy_test;
  const lines = [
    `连带文件（包内预授权，逐条申报；上限 ${policy.max_files} 个文件、${policy.max_lines} 行，超限或不符 → 必须停，发 DECISION_REQUIRED）：`,
    gen.enabled
      ? `- generated（已启用）：只限下列清单路径，只提交生成器输出，交卷前跑 check 且通过：${gen.files.map((f) => `${f.path}（写入 ${f.regen}；复核 ${f.check}）`).join('；')}`
      : '- generated：未启用',
    legacy.enabled
      ? `- legacy_test（已启用）：只限测试文件；失败断言针对某条 SC.change 明确要改的旧行为，且 Jev 判定 choice=${legacy.jev_choice}、confidence≥${legacy.min_jev_confidence}；只改断言与夹具，不删用例、不加 skip/only/todo`
      : '- legacy_test：未启用（域外旧测试红仍按必须停处理，附 Jev 选项排序）',
    '- 同波其他 PR 写域里的文件一律不是连带文件；别组写域冲突 → 必须停。',
    '- 交卷 collateral_used[{path, class, sc_id, reason, jev_ref}]，jev_ref 为 {journal, line} 或 null；ready-check 逐条核。',
  ];
  return lines.join('\n');
}
