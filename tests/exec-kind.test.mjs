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

test('回归：交接 HTML/CSS 排除，只有明确文档规则能将设计文档计为界面', () => {
  const repoFiles = ['src/lib/queue.ts', 'docs/pr/1730/demo.html', 'docs/pr/1730/demo.css', 'docs/design.md', 'cindyplugin/DESIGN.md'];
  const uiGlobs = ['**/*.html', '**/*.css', 'docs/design.md', 'cindyplugin/DESIGN.md'];
  const out = classify(['src/lib/*.ts', 'docs/pr/**'], [], { repoFiles, uiGlobs });
  assert.equal(out.kind, '逻辑');
  assert.deepEqual(out.ui_files, []);
  assert.equal(checkDeclaredKind('逻辑', out).kind, '逻辑');
  assert.deepEqual(classify(['docs/design.md', 'cindyplugin/DESIGN.md'], [], { repoFiles, uiGlobs }).ui_files, ['cindyplugin/DESIGN.md', 'docs/design.md']);
  assert.equal(classify(['docs/pr/1730/demo.html'], [], { repoFiles, uiGlobs: ['docs/pr/**'] }).kind, '界面');
});

test('回归：图片、字体、未知格式和裸 token 不足以判逻辑；代码与配置仍计入', () => {
  const out = classify(['assets/icon.png', 'public/icon.svg', 'font.woff2', 'clip.mp4', 'new/unknown.xyz', 'forgetLibraryAck', 'origin/main']);
  assert.equal(out.kind, '混合');
  assert.deepEqual(out.logic_files, []);
  assert.throws(() => checkDeclaredKind('逻辑', out), /未命中/);
  assert.ok(out.reasons.some((r) => r.includes('7 个文件未识别为代码或配置')));
  for (const file of ['src/new.ts', 'server/main.go', 'config/settings.toml', 'Makefile', '.gitignore', 'scripts/run', 'src/data.weird']) {
    const actual = classify([file]);
    assert.equal(actual.kind, ['scripts/run', 'src/data.weird'].includes(file) ? '混合' : '逻辑', file);
  }
});

test('回归：裸目录按索引展开，不冒充新逻辑文件', () => {
  const repoFiles = ['src/canvas/view.tsx', 'src/canvas/sub/anim.ts'];
  const rest = { repoFiles, uiGlobs: ['src/canvas/**'] };
  const plain = classify(['src/canvas'], [], rest);
  const glob = classify(['src/canvas/**'], [], rest);
  assert.deepEqual(plain, glob);
  assert.equal(plain.kind, '界面');
  assert.throws(() => checkDeclaredKind('逻辑', plain), /src\/canvas\/view.tsx/);
  assert.equal(classify(['src/canvas']).kind, '混合', '没有索引证据时保守兜底');
});

test('已知运维配置与标准 hook 文件算逻辑，未知无扩展二进制/资源保持保守', () => {
  for (const file of ['scripts/job.plist.in', 'ops/job.service', 'ops/job.timer', 'scripts/sha256.pins',
    'spec/Ledger.tla', '.github/CODEOWNERS', '.env.example', '.githooks/pre-push']) {
    assert.equal(classify([file]).kind, '逻辑', file);
  }
  for (const file of ['scripts/bin/unknown', 'assets/icon.png.example', 'golden/result.txt']) {
    assert.equal(classify([file]).kind, '混合', file);
  }
});
