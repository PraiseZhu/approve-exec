import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExecKind, classifyExecKind, checkDeclaredKind } from '../scripts/lib/exec-kind.mjs';

const classify = (scopeGlobs, scLayers = [], rest = {}) => classifyExecKind({ scopeGlobs, scLayers, repoFiles: [], ...rest });

test('归一新旧类型，其他值列出合法值并拒绝', () => {
  for (const [raw, expected] of [['前端', '界面'], ['后端', '逻辑'], ['界面', '界面'], ['逻辑', '逻辑'], ['混合', '混合']]) {
    assert.equal(normalizeExecKind(raw), expected);
  }
  for (const raw of ['全栈', '', null, undefined, 'toString']) assert.throws(() => normalizeExecKind(raw), /界面 \/ 逻辑 \/ 混合/);
});

test('五行判定表，纯界面不因视觉验收变成混合', () => {
  for (const [paths, layers, kind] of [
    [['src/a.tsx', 'scripts/a.mjs'], [], '混合'],
    [['src/a.tsx'], [], '界面'],
    [['src/a.tsx'], ['browser-fixture'], '界面'],
    [['src/a.ts'], ['cindy-mac'], '混合'],
    [['src/a.ts'], ['unit'], '逻辑'],
    [[], ['browser-fixture'], '混合'],
    [[], [], '混合'],
  ]) assert.equal(classify(paths, layers).kind, kind);
});

test('用 git 文件列表展开目录/glob，新文件按路径，结果去重排序', () => {
  const out = classify(['src/canvas/**', 'src/canvas/new.vue', 'src/canvas/z.tsx'], [], {
    repoFiles: ['src/canvas/z.tsx', 'src/canvas/sub/a.jsx', 'src/server/a.ts'],
  });
  assert.equal(out.kind, '界面');
  assert.deepEqual(out.ui_files, ['src/canvas/new.vue', 'src/canvas/sub/a.jsx', 'src/canvas/z.tsx']);
  assert.equal(classify(['missing/**/*.ts']).kind, '混合');
});

test('测试、夹具和普通文档不计入；嵌套 locales/i18n 算界面', () => {
  const out = classify(['**/*'], [], { repoFiles: [
    'x.test.tsx', 'src/x.test.ts', 'src/__tests__/a.tsx', 'tests/a.ts', 'src/fixtures/a.ts',
    'README.md', 'docs/a.ts', 'src/locales/en.json', 'i18n/zh.json', 'src/i18n/zh.json',
  ] });
  assert.deepEqual(out.logic_files, []);
  assert.deepEqual(out.ui_files, ['i18n/zh.json', 'src/i18n/zh.json', 'src/locales/en.json']);
});

test('卡片 ui_globs 替换通用表，显式设计文档算界面，测试始终排除', () => {
  const out = classify(['src/a.tsx', 'src/render/a.ts', 'docs/design.md', 'src/render/a.test.ts'], [], {
    uiGlobs: ['src/render/**', 'docs/design.md'],
  });
  assert.deepEqual(out.ui_files, ['docs/design.md', 'src/render/a.ts']);
  assert.deepEqual(out.logic_files, ['src/a.tsx']);
  assert.deepEqual(classify(['src/a.tsx'], [], { uiGlobs: [] }).ui_files, []);
});

test('视觉层只认三种，去重；逻辑声明错误含文件或层，没有代码也拒绝', () => {
  const out = classify(['src/a.ts'], ['paid', 'github-live', 'cindy-windows', 'browser-fixture', 'cindy-windows']);
  assert.deepEqual(out.visual_layers, ['browser-fixture', 'cindy-windows']);
  assert.throws(() => checkDeclaredKind('后端', out), /browser-fixture/);
  assert.throws(() => checkDeclaredKind('逻辑', classify(['src/a.tsx'])), /src\/a.tsx/);
  assert.throws(() => checkDeclaredKind('逻辑', classify([])), /未命中/);
  const logic = classify(['scripts/x.mjs']);
  assert.deepEqual(checkDeclaredKind('后端', logic), { kind: '逻辑' });
  for (const raw of ['前端', '混合', null]) {
    const checked = checkDeclaredKind(raw, logic);
    assert.equal(checked.kind_hint, '逻辑');
    assert.ok(checked.kind_hint_reasons.length);
  }
});
