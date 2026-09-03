#!/usr/bin/env node
// mini-watch.json 加载器：盯梢机器段 / ssh / 旧班车 blocklist 的唯一读口。
// fail-closed：缺文件、缺段、非绝对路径一律拒，禁止回落到源码字面量。
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MINI_WATCH_CONFIG_PATH = join(ROOT, 'config/mini-watch.json');

let _cached = null;
let _cachedPath = null;

function fail(msg) {
  throw new Error(`mini-watch-config: ${msg}`);
}

function assertAbs(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} 必须是非空字符串`);
  }
  if (!isAbsolute(value) || value.includes('\0')) {
    fail(`${name} 必须是绝对路径（防 PATH 劫持 / 相对穿越），当前: ${value}`);
  }
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} 必须是非空字符串`);
  }
  return value;
}

export function validateMiniWatchConfig(cfg) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    fail('配置必须是非数组对象');
  }
  assertAbs(cfg.ssh_bin, 'ssh_bin');
  if (cfg.hosts === null || typeof cfg.hosts !== 'object' || Array.isArray(cfg.hosts)) {
    fail('hosts 必须是对象（按机器分段）');
  }
  const mini = cfg.hosts.mini;
  if (mini === null || typeof mini !== 'object' || Array.isArray(mini)) {
    fail('hosts.mini 必须是对象');
  }
  assertNonEmptyString(mini.ssh_host, 'hosts.mini.ssh_host');
  assertAbs(mini.state_dir, 'hosts.mini.state_dir');
  assertAbs(mini.register_bin, 'hosts.mini.register_bin');
  assertNonEmptyString(mini.provider_id, 'hosts.mini.provider_id');
  assertNonEmptyString(mini.schedule_name, 'hosts.mini.schedule_name');
  assertNonEmptyString(mini.agent_kind, 'hosts.mini.agent_kind');
  assertNonEmptyString(mini.model, 'hosts.mini.model');
  assertNonEmptyString(mini.effort, 'hosts.mini.effort');
  const local = cfg.hosts.local;
  if (local === null || typeof local !== 'object' || Array.isArray(local)) {
    fail('hosts.local 必须是对象');
  }
  assertNonEmptyString(local.provider_id, 'hosts.local.provider_id');
  if (!Array.isArray(cfg.old_schedule_ids_blocklist)
    || cfg.old_schedule_ids_blocklist.length === 0
    || cfg.old_schedule_ids_blocklist.some((id) => typeof id !== 'string' || id.length === 0)) {
    fail('old_schedule_ids_blocklist 必须是非空字符串数组');
  }
  if (typeof cfg.auto_merge !== 'boolean') {
    fail('auto_merge 必须是布尔（本轮只读；true 尚未实现）');
  }
  return cfg;
}

export function loadMiniWatchConfig(path = MINI_WATCH_CONFIG_PATH) {
  if (_cached && _cachedPath === path) return _cached;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`读取失败（${path}）: ${err.message}`);
  }
  const cfg = validateMiniWatchConfig(parsed);
  _cached = cfg;
  _cachedPath = path;
  return cfg;
}

export function resetMiniWatchConfigCache() {
  _cached = null;
  _cachedPath = null;
}

export function miniWatchConfigSha256(path = MINI_WATCH_CONFIG_PATH) {
  return createHash('sha256').update(readFileSync(path), 'utf8').digest('hex');
}

export function miniHost(cfg = loadMiniWatchConfig()) {
  return cfg.hosts.mini;
}

export function assertAutoMergeDisabled(cfg = loadMiniWatchConfig()) {
  if (cfg.auto_merge === true) {
    fail('auto_merge=true 尚未实现；本轮只读该字段且必须为 false');
  }
  return false;
}
