// repo-card.mjs：仓库卡的读取和校验（PraiseZhu/approve-exec#106 SC2）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARDS_DIR, readRepoCard, selectAlwaysAllowed, toRepoCard } from '../scripts/lib/repo-card.mjs';

test('仓里每张仓库卡都通过校验，文件名和 repo 字段对得上', () => {
  const files = readdirSync(CARDS_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('xindong__mivo-canvas-plugin.json'));
  for (const f of files) {
    const card = toRepoCard(JSON.parse(readFileSync(join(CARDS_DIR, f), 'utf8')));
    assert.equal(`${card.repo.toLowerCase().replace('/', '__')}.json`, f);
  }
});

test('第一张卡：交接目录自动放行，首屏体积基线是热点文件，审查规则有出处', () => {
  const card = readRepoCard('xindong/mivo-canvas-plugin');
  assert.deepEqual(selectAlwaysAllowed(card, 2141), ['docs/pr/2141/**']);
  assert.ok(card.hot_files.some((h) => h.path === 'scripts/ci/first-screen-size.baseline.json'));
  assert.ok(card.review_rules.includes('docs/review/severity.md'));
  assert.equal(readRepoCard('acme/app'), null, '没有卡的仓返回 null');
});

test('多一个未知字段、always_allowed 写成字符串、schema 不对都校验失败并指出字段名', () => {
  const good = JSON.parse(readFileSync(join(CARDS_DIR, 'xindong__mivo-canvas-plugin.json'), 'utf8'));
  assert.throws(() => toRepoCard({ ...good, owner: 'x' }), /清单外的字段：owner/);
  assert.throws(() => toRepoCard({ ...good, always_allowed: 'docs/**' }), /always_allowed/);
  assert.throws(() => toRepoCard({ ...good, schema: 'v0' }), /schema/);
  assert.throws(() => toRepoCard({ ...good, hot_files: [{ path: 'a' }] }), /hot_files/);
});

test('#111 ui_globs 可选，存在时必须为字符串数组，Mivo 卡覆盖通用与自有界面路径', () => {
  const card = readRepoCard('xindong/mivo-canvas-plugin');
  for (const glob of ['**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.css', '**/*.scss', '**/*.html', '**/locales/**', '**/i18n/**', 'src/render/**', 'src/canvas/**', 'cindyplugin/DESIGN.md', 'docs/design.md']) assert.ok(card.ui_globs.includes(glob), glob);
  const { ui_globs, ...oldCard } = card;
  assert.equal(toRepoCard(oldCard).ui_globs, undefined);
  assert.deepEqual(toRepoCard({ ...card, ui_globs: [] }).ui_globs, []);
  for (const invalid of ['src/**', null, [1], ['']]) assert.throws(() => toRepoCard({ ...card, ui_globs: invalid }), /ui_globs/);
});
