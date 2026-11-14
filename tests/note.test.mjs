// note.mjs：运行笔记（PraiseZhu/approve-exec#106 SC1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_TEXT_MAX, add, list } from '../scripts/note.mjs';
import { REPO, commentsKey, ghFrom, parentFixture } from './fixtures/issues/build.mjs';

const ROOT = `${REPO}#10`;
const A = `${REPO}#11`;

test('add 后 list 读回来源、类型、广播标志和正文', () => {
  const fixture = parentFixture();
  const gh = ghFrom(fixture);
  add({ gh, rootRef: ROOT, fromRef: A, kind: 'pitfall', text: '取整后仍会越界 1px，按写入值算平移量', broadcast: true, now: '2026-11-14T02:00:00.000Z' });
  add({ gh, rootRef: ROOT, fromRef: A, kind: 'decision', text: '新建 canvasBoundsEdits.ts 避开行数上限', now: '2026-11-14T03:00:00.000Z' });
  assert.match(fixture[commentsKey(10)][0].body, /^批准执行笔记：acme\/app#11 坑/);
  const { notes } = list({ gh, rootRef: ROOT });
  assert.equal(notes.length, 2);
  assert.deepEqual({ from: notes[0].from, kind: notes[0].kind, broadcast: notes[0].broadcast, text: notes[0].text },
    { from: A, kind: 'pitfall', broadcast: true, text: '取整后仍会越界 1px，按写入值算平移量' });
  assert.equal(notes[1].broadcast, false);
  assert.equal(list({ gh, rootRef: ROOT, since: '2026-11-14T02:30:00.000Z' }).notes.length, 1);
});

test('别人账号发的笔记不采信；超长、类型不对、空正文都拒绝', () => {
  const fixture = parentFixture({ extra: { [commentsKey(10)]: [{ id: 1, user: { login: 'someone-else' }, body: `批准执行笔记：${A} 坑\n\nx\n\n<!-- approve-exec:note v1 {"from":"${A}","kind":"pitfall","broadcast":true,"at":"2026-11-14T02:00:00.000Z"} -->` }] } });
  const gh = ghFrom(fixture);
  assert.equal(list({ gh, rootRef: ROOT }).notes.length, 0);
  assert.throws(() => add({ gh, rootRef: ROOT, fromRef: A, kind: 'pitfall', text: 'x'.repeat(NOTE_TEXT_MAX + 1) }), /最多 1200 个字符（当前：1201）/);
  assert.throws(() => add({ gh, rootRef: ROOT, fromRef: A, kind: 'idea', text: 'x' }), /--kind 只能是/);
  assert.throws(() => add({ gh, rootRef: ROOT, fromRef: A, kind: 'pitfall', text: '  ' }), /--text 要写/);
});
