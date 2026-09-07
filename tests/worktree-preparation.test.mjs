import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorktree } from '../scripts/pr-watch/prepare-worktree.mjs';
import { stateFileName } from '../scripts/pr-watch/register.mjs';

function fixture(action, statePatch = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ae-worktree-'));
  const stateDir = join(directory, 'state');
  mkdirSync(stateDir);
  const state = { owner: 'acme', repo: 'app', pr_number: 7, branch: 'fix/pr-7', push_repo: null,
    push_remote: 'origin', session_id: 'mini-7', lead_signal: { signal_id: 'lead-signal', head_sha: 'a'.repeat(40), owner_title: '项目-修复丨 0906' }, ...statePatch };
  writeFileSync(join(stateDir, stateFileName('acme', 'app', 7)), JSON.stringify(state));
  const commands = [];
  const control = {
    actualHead: 'a'.repeat(40),
    fetchedHead: 'a'.repeat(40),
    fastForward: true,
    status: '',
    remotes: 'origin',
    remoteUrl: 'https://github.com/' + (state.push_repo ?? 'acme/app') + '.git',
  };
  const run = (bin, args) => {
    commands.push([bin, ...args]);
    if (bin === 'gh') mkdirSync(args[3], { recursive: true });
    if (args.includes('get-url')) return control.remoteUrl;
    if (args.includes('remote') && args.includes('rename')) {
      control.remotes = state.push_remote;
      return '';
    }
    if (args.includes('remote')) return control.remotes;
    if (args.includes('status')) return control.status;
    if (args.includes('merge-base')) {
      if (!control.fastForward) throw new Error('not ancestor');
      return '';
    }
    if (args.includes('merge')) {
      control.actualHead = control.fetchedHead;
      return '';
    }
    if (args.includes('rev-parse') && args.includes('FETCH_HEAD')) return control.fetchedHead;
    if (args.includes('rev-parse')) return control.actualHead;
    if (args.includes('add')) mkdirSync(args.at(-2), { recursive: true });
    if (args.includes('--show-current')) return 'fix/pr-7';
    return '';
  };
  try { action({ stateDir, owner: 'acme', repo: 'app', prNumber: 7, sessionId: 'mini-7', headSha: 'a'.repeat(40), run }, commands, control); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('Mini prepares and reuses only its PR-bound worktree', () => {
  fixture((options, commands) => {
    const first = prepareWorktree(options);
    assert.equal(first.resumed, false);
    assert.equal(first.session_id, 'mini-7');
    assert.ok(first.path.includes('/worktrees/'));
    assert.equal(first.path.endsWith('.json'), false);
    assert.equal(prepareWorktree(options).resumed, true);
    assert.equal(commands.filter((command) => command.includes('add')).length, 1);
  });
});

test('wrong Mini session cannot create a clone', () => {
  fixture((options, commands) => {
    assert.throws(() => prepareWorktree({ ...options, sessionId: 'another-session' }), /尚未绑定/);
    assert.equal(commands.length, 0);
  });
});

test('head changes do not reset or create a worktree', () => {
  fixture((options, commands) => {
    assert.throws(() => prepareWorktree({ ...options, headSha: 'b'.repeat(40) }), /head 已变化/);
    assert.equal(commands.some((command) => command.includes('add')), false);
  });
});

function recordPendingHead(options, head) {
  const file = join(options.stateDir, stateFileName('acme', 'app', 7));
  const state = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...state, pending_dispatch: { head_sha: head } }));
}

test('clean old worktree only fast-forwards to the pending head', () => {
  fixture((options, commands, control) => {
    prepareWorktree(options);
    control.fetchedHead = 'b'.repeat(40);
    recordPendingHead(options, control.fetchedHead);
    const resumed = prepareWorktree({ ...options, headSha: control.fetchedHead });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.fast_forwarded, true);
    assert.ok(commands.some((command) => command.includes('merge') && command.includes('--ff-only')));
    assert.equal(commands.some((command) => command.includes('reset')), false);
  });
});

test('dirty old worktree refuses a changed pending head without reset', () => {
  fixture((options, commands, control) => {
    prepareWorktree(options);
    control.fetchedHead = 'b'.repeat(40);
    control.status = ' M src/file.js';
    recordPendingHead(options, control.fetchedHead);
    assert.throws(() => prepareWorktree({ ...options, headSha: control.fetchedHead }), /dirty/);
    assert.equal(commands.some((command) => command.includes('merge') || command.includes('reset')), false);
  });
});

test('non-fast-forward old worktree is rejected', () => {
  fixture((options, commands, control) => {
    prepareWorktree(options);
    control.fetchedHead = 'b'.repeat(40);
    control.fastForward = false;
    recordPendingHead(options, control.fetchedHead);
    assert.throws(() => prepareWorktree({ ...options, headSha: control.fetchedHead }), /快进后继/);
    assert.equal(commands.some((command) => command.includes('merge') || command.includes('reset')), false);
  });
});

test('fork wiring is carried into the worktree and fetches the fork remote', () => {
  fixture((options, commands) => {
    const result = prepareWorktree(options);
    assert.equal(result.push_repo, 'fork/app');
    assert.equal(result.push_remote, 'fork');
    assert.ok(commands.some((command) => command.includes('rename') && command.includes('origin') && command.includes('fork')));
    assert.ok(commands.some((command) => command.includes('fetch') && command.includes('fork')));
  }, { push_repo: 'fork/app', push_remote: 'fork' });
});

test('fork remote pointing to upstream is rejected before worktree creation', () => {
  fixture((options, commands, control) => {
    control.remoteUrl = 'https://github.com/acme/app.git';
    assert.throws(() => prepareWorktree(options), /未绑定 fork\/app/);
    assert.equal(commands.some((command) => command.includes('worktree') && command.includes('add')), false);
  }, { push_repo: 'fork/app', push_remote: 'fork' });
});
