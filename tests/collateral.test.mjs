import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCollateralPolicy, assertCollateralUsedShape, evaluateCollateral, renderCollateralPolicyText, CollateralError,
} from '../scripts/lib/collateral.mjs';

const GEN = 'cindyplugin/design-inventory.md';

function policy({ legacyEnabled = false } = {}) {
  const p = loadCollateralPolicy();
  p.classes.legacy_test.enabled = legacyEnabled;
  return p;
}

const packet = { group_id: 'PR1', allowed_paths: ['src/a.ts'], scs_inline: [{ id: 'PR1-SC1' }] };
const other = { group_id: 'PR2', allowed_paths: ['src/b.ts', 'src/b.test.ts'], scs_inline: [{ id: 'PR2-SC1' }] };

function item(overrides = {}) {
  return { path: GEN, class: 'generated', sc_id: 'PR1-SC1', reason: '新组件需登记', jev_ref: null, ...overrides };
}

function run(used, { changed = {}, added = {}, pol = policy(), readText } = {}) {
  return evaluateCollateral({
    policy: pol,
    packet,
    otherPackets: [other],
    used,
    changedLines: new Map(Object.entries(changed)),
    addedLines: new Map(Object.entries(added)),
    ...(readText ? { readText } : {}),
  });
}

test('collateral: 真实策略可加载，登记类启用、旧测试类默认未启用', () => {
  const p = loadCollateralPolicy();
  assert.equal(p.max_files, 5);
  assert.equal(p.max_lines, 200);
  assert.equal(p.classes.generated.enabled, true);
  assert.equal(p.classes.legacy_test.enabled, false);
  assert.ok(p.classes.generated.files.some((f) => f.path === GEN));
});

test('collateral: 形状 exact，路径/类别/重复/jev_ref 非法都拒', () => {
  assert.doesNotThrow(() => assertCollateralUsedShape([]));
  assert.throws(() => assertCollateralUsedShape(null), CollateralError);
  assert.throws(() => assertCollateralUsedShape([{ ...item(), extra: 1 }]), /键集不符/);
  assert.throws(() => assertCollateralUsedShape([item({ path: '../etc/x' })]), /path 非法/);
  assert.throws(() => assertCollateralUsedShape([item({ class: 'other' })]), /class 必须是/);
  assert.throws(() => assertCollateralUsedShape([item(), item()]), /重复申报/);
  assert.throws(() => assertCollateralUsedShape([item({ jev_ref: { journal: 'rel.jsonl', line: 1 } })]), /绝对路径/);
});

test('collateral: 清单内登记类文件、有改动、未超限 → 放行', () => {
  const r = run([item()], { changed: { [GEN]: 12 } });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.paths, [GEN]);
});

test('collateral: 登记类不在清单、未改动、本组写域、别组写域、非本组 SC → 各自点名', () => {
  assert.match(run([item({ path: 'docs/x.md' })], { changed: { 'docs/x.md': 1 } }).violations.join(), /不在 generated\.files 清单/);
  assert.match(run([item()]).violations.join(), /没有改动/);
  assert.match(run([item({ path: 'src/a.ts' })], { changed: { 'src/a.ts': 1 } }).violations.join(), /已在本组 allowed_paths/);
  assert.match(run([item({ path: 'src/b.ts' })], { changed: { 'src/b.ts': 1 } }).violations.join(), /跨 PR 写冲突/);
  assert.match(run([item({ sc_id: 'PR2-SC1' })], { changed: { [GEN]: 1 } }).violations.join(), /不是本组 SC/);
});

test('collateral: 任一条不合格，整组连带路径都不放行', () => {
  const r = run([item(), item({ path: 'docs/x.md' })], { changed: { [GEN]: 1, 'docs/x.md': 1 } });
  assert.ok(r.violations.length > 0);
  assert.deepEqual(r.paths, []);
});

test('collateral: 文件数与行数上限', () => {
  const pol = policy();
  pol.max_files = 0;
  assert.match(run([item()], { changed: { [GEN]: 1 }, pol }).violations.join(), /max_files=0/);
  assert.match(run([item()], { changed: { [GEN]: 201 } }).violations.join(), /max_lines=200/);
  assert.match(run([item()], { changed: { [GEN]: Infinity } }).violations.join(), /含二进制/);
});

test('collateral: 旧测试类默认未启用 → 拒', () => {
  const t = 'src/old.test.ts';
  assert.match(run([item({ path: t, class: 'legacy_test', jev_ref: null })], { changed: { [t]: 3 } }).violations.join(), /未启用/);
});

test('collateral: 旧测试类启用后，需测试文件 + Jev 达标 + 不加 skip/only', () => {
  const t = 'src/old.test.ts';
  const journal = '/abs/jev/pr1.jsonl';
  const good = JSON.stringify({ choice: 'update_legacy_assertion', confidence: 0.91, paths: [t] });
  const weak = JSON.stringify({ choice: 'update_legacy_assertion', confidence: 0.6, paths: [t] });
  const pol = policy({ legacyEnabled: true });
  const ref = { journal, line: 1 };
  const ok = run([item({ path: t, class: 'legacy_test', jev_ref: ref })], { changed: { [t]: 4 }, pol, readText: () => `${good}\n` });
  assert.deepEqual(ok.violations, []);
  assert.deepEqual(ok.paths, [t]);
  assert.match(run([item({ path: t, class: 'legacy_test', jev_ref: ref })], { changed: { [t]: 4 }, pol, readText: () => `${weak}\n` }).violations.join(), /Jev 判定不足/);
  assert.match(run([item({ path: t, class: 'legacy_test', jev_ref: null })], { changed: { [t]: 4 }, pol }).violations.join(), /必须附 Jev 判定/);
  assert.match(run([item({ path: 'src/x.ts', class: 'legacy_test', jev_ref: ref })], { changed: { 'src/x.ts': 1 }, pol, readText: () => good }).violations.join(), /不是测试文件路径/);
  assert.match(run([item({ path: t, class: 'legacy_test', jev_ref: ref })], {
    changed: { [t]: 4 }, pol, readText: () => good, added: { [t]: ["  it.skip('old', () => {})"] },
  }).violations.join(), /skip\/only\/todo/);
  assert.match(run([item({ path: t, class: 'legacy_test', jev_ref: { journal, line: 3 } })], { changed: { [t]: 4 }, pol, readText: () => good }).violations.join(), /第 3 行不存在/);
});

test('collateral: 开工包说明文字含上限、清单与必须停', () => {
  const text = renderCollateralPolicyText(loadCollateralPolicy());
  assert.match(text, /上限 5 个文件、200 行/);
  assert.match(text, /cindyplugin\/design-inventory\.md/);
  assert.match(text, /必须停/);
  assert.match(text, /legacy_test：未启用/);
  assert.match(text, /collateral_used/);
});
