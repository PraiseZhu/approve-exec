// 执行类型只按范围与验收层判断；保守结果交给混合路线。
import { basename, extname } from 'node:path';
import { matchScopeGlob } from '../accept-check.mjs';

export const EXEC_KINDS = ['界面', '逻辑', '混合'];
export const DEFAULT_UI_GLOBS = [
  '**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.css', '**/*.scss', '**/*.html', '**/locales/**', '**/i18n/**',
];
const TEST_GLOBS = ['**/*.test.*', '**/__tests__/**', 'tests/**', '**/fixtures/**'];
const DOC_GLOBS = ['**/*.md', 'docs/**'];
// 未识别的语言/资源保守不计；卡片可显式把任意格式声明为界面。
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.css', '.scss', '.html',
  '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf', '.lock',
  '.py', '.pyi', '.rb', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp',
  '.cs', '.java', '.kt', '.kts', '.swift', '.m', '.mm', '.php', '.pl', '.pm',
  '.lua', '.r', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto', '.dart', '.ex', '.exs', '.erl', '.hrl',
  '.hs', '.clj', '.cljs', '.scala', '.sc', '.groovy', '.gradle', '.cmake', '.tf', '.hcl',
]);
const CODE_NAMES = new Set(['Makefile', 'Dockerfile', 'Containerfile', 'Procfile', 'Gemfile', 'Rakefile', 'Jenkinsfile', 'CMakeLists.txt', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.yarnrc']);
const isCode = (file) => CODE_EXTENSIONS.has(extname(file).toLowerCase()) || CODE_NAMES.has(basename(file));
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
  for (const raw of scopeGlobs) {
    const glob = raw.replace(/^\.\//, '');
    const literal = !/[\*?\[\]{}]/.test(glob) && !glob.endsWith('/');
    const directory = literal && repoFiles.some((file) => file.startsWith(`${glob}/`));
    for (const file of repoFiles) if (match(file, glob) || (directory && file.startsWith(`${glob}/`))) files.add(file);
    // 具体新文件按路径判断；裸目录由索引展开，未知 token 不凭空成为代码。
    if (literal && !directory) files.add(glob);
  }
  const ui_files = [];
  const logic_files = [];
  let unclassified = 0;
  // 通用 **/*.html 不足以把交接 demo 变成界面；只有卡片明确指向文档的规则才覆盖文档排除。
  const documentUiGlobs = uiGlobs.filter((glob) => matches(glob, DOC_GLOBS));
  for (const file of [...files].sort()) {
    if (matches(file, TEST_GLOBS)) continue;
    if (matches(file, DOC_GLOBS) && !matches(file, documentUiGlobs)) continue;
    if (matches(file, uiGlobs)) ui_files.push(file);
    else if (isCode(file)) logic_files.push(file);
    else unclassified += 1;
  }
  const visual_layers = [...new Set(scLayers.filter((layer) => VISUAL_LAYERS.includes(layer)))].sort();
  const kind = ui_files.length ? (logic_files.length ? '混合' : '界面')
    : logic_files.length && !visual_layers.length ? '逻辑' : '混合';
  const reasons = [
    `界面文件 ${ui_files.length} 个`, `逻辑文件 ${logic_files.length} 个`,
    visual_layers.length ? `看画面的验收层：${visual_layers.join('、')}` : '没有看画面的验收层',
    ...(unclassified ? [`${unclassified} 个文件未识别为代码或配置，保守不计入逻辑`] : []),
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
