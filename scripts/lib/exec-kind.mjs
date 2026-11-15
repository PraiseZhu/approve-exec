// 执行类型只按范围与验收层判断；保守结果交给混合路线。
import { matchScopeGlob } from '../accept-check.mjs';

export const EXEC_KINDS = ['界面', '逻辑', '混合'];
export const DEFAULT_UI_GLOBS = [
  '**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.css', '**/*.scss', '**/*.html', '**/locales/**', '**/i18n/**',
];
const TEST_GLOBS = ['**/*.test.*', '**/__tests__/**', 'tests/**', '**/fixtures/**'];
const DOC_GLOBS = ['**/*.md', 'docs/**'];
const VISUAL_LAYERS = ['browser-fixture', 'cindy-mac', 'cindy-windows'];
// 现有匹配器把结尾 /** 当路径前缀；补 /* 后可展开前面含 ** 的目录规则。
const match = (file, glob) => matchScopeGlob(file, glob.endsWith('/**') ? `${glob}/*` : glob);
const matches = (file, globs) => globs.some((g) => match(file, g));

export function normalizeExecKind(raw) {
  const kind = ({ 前端: '界面', 后端: '逻辑' })[raw] ?? raw;
  if (!EXEC_KINDS.includes(kind)) throw new Error(`执行类型 只能是 ${EXEC_KINDS.join(' / ')}（兼容前端 / 后端；当前：${raw}）`);
  return kind;
}

export function classifyExecKind({ scopeGlobs, scLayers, repoFiles, uiGlobs = DEFAULT_UI_GLOBS }) {
  const files = new Set();
  for (const glob of scopeGlobs) {
    for (const file of repoFiles) if (match(file, glob)) files.add(file);
    // 新建文件还不在 git ls-files 中；未展开的 glob 不能冒充一个逻辑文件。
    if (!/[\*?\[\]{}]/.test(glob) && !glob.endsWith('/')) files.add(glob.replace(/^\.\//, ''));
  }
  const ui_files = [];
  const logic_files = [];
  for (const file of [...files].sort()) {
    if (matches(file, TEST_GLOBS)) continue;
    // 卡片显式列出的设计文档属于界面；普通文档不算逻辑。
    if (matches(file, uiGlobs)) ui_files.push(file);
    else if (!matches(file, DOC_GLOBS)) logic_files.push(file);
  }
  const visual_layers = [...new Set(scLayers.filter((layer) => VISUAL_LAYERS.includes(layer)))].sort();
  const kind = ui_files.length ? (logic_files.length ? '混合' : '界面')
    : logic_files.length && !visual_layers.length ? '逻辑' : '混合';
  const reasons = [
    `界面文件 ${ui_files.length} 个`, `逻辑文件 ${logic_files.length} 个`,
    visual_layers.length ? `看画面的验收层：${visual_layers.join('、')}` : '没有看画面的验收层',
    ...(!ui_files.length && !logic_files.length ? ['未命中界面或逻辑文件，保守判为混合'] : []),
  ];
  return { kind, ui_files, logic_files, visual_layers, reasons };
}

/** 声明保留派发选择权，但逻辑声明不能绕过界面/画面验收检查。 */
export function checkDeclaredKind(declared, classified) {
  const kind = declared == null ? '混合' : normalizeExecKind(declared);
  if (kind === '逻辑' && classified.kind !== '逻辑') {
    throw new Error(`声明逻辑但判定为${classified.kind}：界面文件 ${classified.ui_files.join('、') || '无'}；验收层 ${classified.visual_layers.join('、') || '无'}；${classified.reasons.join('；')}`);
  }
  return {
    kind,
    ...(declared == null || (kind !== '逻辑' && classified.kind === '逻辑')
      ? { kind_hint: classified.kind, kind_hint_reasons: classified.reasons } : {}),
  };
}
