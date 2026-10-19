#!/usr/bin/env node
// End-to-end check of the web service over HTTP. Runs the server binary against a
// temporary data dir and temporary fixture folders; never touches real user files.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = process.env.BACKURAU_SERVER_BIN ?? join(root, `server/target/debug/backurau-server${exe}`);
assert.ok(existsSync(bin), `build the server first: cargo build --manifest-path server/Cargo.toml (${bin})`);

const tmp = mkdtempSync(join(tmpdir(), 'backurau-it-'));
const [data, src, dst, restore] = ['data', 'src', 'dst', 'restore'].map((d) => {
  const p = join(tmp, d);
  mkdirSync(p);
  return p;
});
writeFileSync(join(src, 'a.txt'), 'alpha');
mkdirSync(join(src, 'sub'));
writeFileSync(join(src, 'sub/b.txt'), 'beta');
writeFileSync(join(dst, 'old.txt'), 'stale');

const port = 20000 + Math.floor(Math.random() * 20000);
const token = 'integration-token-0123456789';
const server = spawn(bin, [], {
  env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', BACKURAU_DATA_DIR: data, BACKURAU_TOKEN: token },
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;

const api = (method, args = {}, headers = {}) =>
  fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(args),
  });
const ok = async (method, args) => {
  const r = await api(method, args);
  const body = await r.json();
  assert.equal(r.status, 200, `${method}: ${JSON.stringify(body)}`);
  return body;
};

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    assert.ok(i < 100, 'server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }

  // Auth and origin.
  assert.equal((await fetch(`${base}/api/get_state`, { method: 'POST', body: '{}' })).status, 401, 'missing token');
  assert.equal((await api('get_state', {}, { Authorization: 'Bearer wrong-token-wrong-token' })).status, 401, 'wrong token');
  assert.equal((await api('get_state', {}, { Origin: 'https://evil.example' })).status, 403, 'foreign origin');
  assert.equal((await api('nope')).ok, false, 'unknown method');

  // Plan -> compare -> run -> restore.
  const state = await ok('get_state');
  assert.equal(state.plans.length, 0);
  const plan = await ok('save_plan', {
    plan: {
      id: '', name: 'Integration', mode: 'mirror', method: 'time_size', include: [], exclude: [],
      conflict_policy: 'ask', snapshot_mode: 'versions', retention: 5, engine: 'native',
      pairs: [{ id: '', left: src, right: dst, overrides: null }],
      schedule: { enabled: false, interval_minutes: 60, on_change: false, on_available: false },
      custom: { left_only: 'copy_right', right_only: 'delete_right', different: 'copy_right' },
    },
  });
  const cmp = await ok('compare_plan', { plan_id: plan.id });
  assert.equal(cmp.totals.added, 3, 'a.txt, sub, sub/b.txt');
  assert.equal(cmp.totals.deleted, 1, 'old.txt');

  const refused = await api('run_plan', { comparison_id: cmp.id, selected: cmp.rows.filter((r) => r.selected).map((r) => r.id), resolutions: {}, confirm_destructive: false });
  assert.equal(refused.status, 422, 'destructive run needs confirmation');

  const run = await ok('run_plan', { comparison_id: cmp.id, selected: cmp.rows.filter((r) => r.selected).map((r) => r.id), resolutions: {}, confirm_destructive: true });
  assert.equal(run.status, 'completed');
  assert.equal(readFileSync(join(dst, 'sub/b.txt'), 'utf8'), 'beta');
  assert.equal(existsSync(join(dst, 'old.txt')), false);

  const full = await ok('get_run', { id: run.id });
  assert.equal(full.versions.length, 1);
  const restored = await ok('restore_versions', { run_id: run.id, version_ids: [full.versions[0].id], target: restore, overwrite: false });
  assert.equal(restored.restored, 1);
  assert.equal(readFileSync(join(restore, 'old.txt'), 'utf8'), 'stale');

  console.log('integration passed');
} finally {
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
