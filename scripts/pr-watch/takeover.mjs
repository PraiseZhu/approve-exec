#!/usr/bin/env node
// Skill-side proof of a successful scheduler scan, not just registration.
import { join } from 'node:path';
import { withLock } from '../lib/state-lock.mjs';
import { readJson, writeJsonAtomic, isMain, parseArgs } from '../lib/common.mjs';
import { miniWatchConfigSha256, loadMiniWatchConfig } from '../lib/mini-watch-config.mjs';
import { stateFileName, identityMatches } from './register.mjs';

export const TAKEOVER_TTL_MS = 10 * 60_000;

export function acknowledgeTakeover({ stateDir, owner, repo, pr, scheduleId, at = new Date().toISOString() }) {
  if (typeof scheduleId !== 'string' || !scheduleId || loadMiniWatchConfig().old_schedule_ids_blocklist.includes(scheduleId)) {
    throw new Error('takeover 缺当前 script scheduleId，或引用旧班车');
  }
  const file = join(stateDir, stateFileName(owner, repo, pr));
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, pr) || !state.first_scan_ack || state.create_pending) {
      throw new Error('takeover 未完成首扫或 create 结果未知，不得释放本机 owner');
    }
    const takeover = { schedule_id: scheduleId, first_scan_ack: state.first_scan_ack,
      last_scan_at: at, config_sha256: miniWatchConfigSha256() };
    writeJsonAtomic(file, { ...state, takeover });
    return takeover;
  });
}

export function assertTakeover(takeover, { now, readyAt, configHash = miniWatchConfigSha256() }) {
  if (!takeover || typeof takeover.schedule_id !== 'string' || !takeover.schedule_id
    || loadMiniWatchConfig().old_schedule_ids_blocklist.includes(takeover.schedule_id)
    || takeover.config_sha256 !== configHash) throw new Error('Mini 首扫配置/调度身份未确认');
  const first = Date.parse(takeover.first_scan_ack);
  const last = Date.parse(takeover.last_scan_at);
  const current = Date.parse(now);
  if (![first, last, current].every(Number.isFinite) || first > last || last > current
    || current - last > TAKEOVER_TTL_MS || (readyAt && last <= Date.parse(readyAt))) {
    throw new Error('Mini 尚无本 PR Ready 之后的有效首扫心跳（十分钟内，不接受未来时间）');
  }
  return takeover;
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    let result;
    if (args._[0] === 'ack') result = acknowledgeTakeover({ stateDir: args['state-dir'], owner: args.owner,
      repo: args.repo, pr: args.pr, scheduleId: args['schedule-id'] });
    else if (args._[0] === 'read') {
      const state = readJson(join(args['state-dir'], stateFileName(args.owner, args.repo, args.pr)));
      if (!identityMatches(state, args.owner, args.repo, args.pr) || state.branch !== args.branch || state.create_pending) {
        throw new Error('takeover PR/branch 不符或 create 未确认');
      }
      result = assertTakeover(state.takeover, { now: args.now });
    } else throw new Error('takeover ack|read --state-dir --owner --repo --pr');
    console.log(JSON.stringify(result));
  } catch (error) { console.error('takeover: ' + error.message); process.exitCode = 2; }
}
