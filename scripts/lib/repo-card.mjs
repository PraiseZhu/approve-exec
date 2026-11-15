// repo-card.mjs — 仓库卡的读取和校验（PraiseZhu/approve-exec#106）。
// 仓库卡是每个目标仓一份的数据文件：必改路径、热点文件、会拦人的检查、常用验证命令、审查规则位置、常见坑。
// 脚本直接读它（验收时放行 always_allowed，开工消息带上 hot_files / guards / pitfalls），不靠执行会话自己记。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class RepoCardError extends Error {}
const reject = (msg) => { throw new RepoCardError(msg); };

export const REPO_CARD_SCHEMA = 'approve-exec/repo-card@1';
export const CARDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../repo-cards');
const KEYS = ['schema', 'repo', 'always_allowed', 'hot_files', 'guards', 'verify', 'review_rules', 'pitfalls', 'ui_globs'];

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x);
const isPairs = (v, a, b) => Array.isArray(v) && v.every((x) => x && typeof x[a] === 'string' && x[a] && typeof x[b] === 'string' && x[b] && Object.keys(x).every((k) => k === a || k === b));

/** 校验仓库卡；不合格时抛错并写出字段名。 */
export function toRepoCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('仓库卡要是一个 JSON 对象');
  const unknown = Object.keys(raw).filter((k) => !KEYS.includes(k));
  if (unknown.length) reject(`仓库卡里有清单外的字段：${unknown.join('、')}`);
  if (raw.schema !== REPO_CARD_SCHEMA) reject(`schema 要是 ${REPO_CARD_SCHEMA}（当前：${raw.schema}）`);
  if (typeof raw.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(raw.repo)) reject(`repo 要是 owner/name（当前：${raw.repo}）`);
  if (!isStrings(raw.always_allowed)) reject('always_allowed 要是 glob 字符串数组');
  if (!isPairs(raw.hot_files, 'path', 'why')) reject('hot_files 要是 [{path, why}] 数组');
  if (!isPairs(raw.guards, 'name', 'rule')) reject('guards 要是 [{name, rule}] 数组');
  if (!isPairs(raw.verify, 'name', 'command')) reject('verify 要是 [{name, command}] 数组');
  if (!isStrings(raw.review_rules)) reject('review_rules 要是文件路径字符串数组');
  if (!isStrings(raw.pitfalls)) reject('pitfalls 要是字符串数组');
  if (raw.ui_globs !== undefined && !isStrings(raw.ui_globs)) reject('ui_globs 要是 glob 字符串数组');
  return raw;
}

export const toCardFile = (repo, dir = CARDS_DIR) => join(dir, `${String(repo).toLowerCase().replace('/', '__')}.json`);

/** 读某个仓的仓库卡；没有这张卡返回 null，卡坏了抛错（不悄悄当成没有）。 */
export function readRepoCard(repo, dir = CARDS_DIR) {
  const file = toCardFile(repo, dir);
  if (!existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { reject(`仓库卡 ${file} 不是合法 JSON（${err.message}）`); }
  return toRepoCard(raw);
}

/** always_allowed 里的 {pr} 换成 PR 号。 */
export function selectAlwaysAllowed(card, pr) {
  return (card?.always_allowed ?? []).map((g) => g.replaceAll('{pr}', String(pr)));
}
