import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, seed } from './db.js';
import { createApp } from './server.js';

const db = openDb(':memory:');
seed(db);
const server = createApp({ db });
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function client(email) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  if (email) assert.equal((await call('POST', '/api/login', { email })).status, 200);
  return call;
}

test('未ログインは拒否', async () => {
  const c = await client();
  assert.equal((await c('GET', '/api/clinics')).status, 401);
});

test('月次: 新規登録 → 翌月コピー → 終了 → 以降は非表示', async () => {
  const c = await client('a1@example.com');
  assert.equal((await c('POST', '/api/patients', { clinic_id: 1, ym: '2026-10', name: '患者一', birth: '1980-01-01' })).status, 200);
  let s = (await c('GET', '/api/sheet?clinic_id=1&ym=2026-10')).data;
  assert.equal(s.new.length, 1);
  assert.deepEqual(s.items.map((i) => i.label), ['項目1', '項目2']); // A社は項目1,2のみ
  assert.equal(s.new[0].code, 'C1-0001');
  const rid = s.new[0].record_id;
  assert.equal((await c('PUT', `/api/records/${rid}`, { visits: 4, vals: { 1: 3000, 2: 500 } })).status, 200);

  // 翌月: 既存患者として前月内容がコピーされ、未確認
  s = (await c('GET', '/api/sheet?clinic_id=1&ym=2026-11')).data;
  assert.equal(s.new.length, 0);
  assert.equal(s.existing.length, 1);
  assert.equal(s.existing[0].state, 'pending');
  assert.equal(s.existing[0].visits, 4);
  assert.equal(s.existing[0].total, 3500);
  assert.equal(s.totals.existing.total, 3500);

  // 終了 → 同月は表示(終了扱い・合計から除外)、翌々月は非表示
  await c('POST', `/api/records/${s.existing[0].record_id}/state`, { state: 'ended' });
  s = (await c('GET', '/api/sheet?clinic_id=1&ym=2026-11')).data;
  assert.equal(s.existing[0].state, 'ended');
  assert.equal(s.totals.existing.total, 0);
  assert.equal((await c('PUT', `/api/records/${s.existing[0].record_id}`, { visits: 1 })).status, 400);
  s = (await c('GET', '/api/sheet?clinic_id=1&ym=2026-12')).data;
  assert.equal(s.existing.length, 0);
});

test('入力検証: 無効な項目・負数・計算値は受け付けない', async () => {
  const c = await client('a1@example.com');
  await c('POST', '/api/patients', { clinic_id: 1, ym: '2026-11', name: '患者二' });
  const s = (await c('GET', '/api/sheet?clinic_id=1&ym=2026-11')).data;
  const rid = s.new[0].record_id;
  assert.equal((await c('PUT', `/api/records/${rid}`, { vals: { 3: 100 } })).status, 400); // A社に項目3は無い
  assert.equal((await c('PUT', `/api/records/${rid}`, { vals: { 1: -1 } })).status, 400);
  await c('PUT', `/api/records/${rid}`, { visits: 2, vals: { 1: 100 }, total: 99999 });
  const s2 = (await c('GET', '/api/sheet?clinic_id=1&ym=2026-11')).data;
  assert.equal(s2.new.find((r) => r.record_id === rid).total, 100); // total は無視される
});

test('権限: 他院・他社は閲覧/編集不可', async () => {
  const a1 = await client('a1@example.com');
  assert.equal((await a1('GET', '/api/sheet?clinic_id=2&ym=2026-11')).status, 403); // 同社の他院
  assert.equal((await a1('GET', '/api/sheet?clinic_id=3&ym=2026-11')).status, 403); // 他社
  assert.equal((await a1('GET', '/api/manage')).status, 403);
  const aa = await client('a-admin@example.com');
  assert.equal((await aa('GET', '/api/sheet?clinic_id=2&ym=2026-11')).status, 200);
  assert.equal((await aa('GET', '/api/sheet?clinic_id=3&ym=2026-11')).status, 403);
  const rid = (await a1('GET', '/api/sheet?clinic_id=1&ym=2026-11')).data.new[0].record_id;
  const b1 = await client('b1@example.com');
  assert.equal((await b1('PUT', `/api/records/${rid}`, { visits: 9 })).status, 403);
  assert.equal((await b1('POST', '/api/records/' + rid + '/state', { state: 'ended' })).status, 403);
});

test('管理: 会社管理者は自社に院/アカウントを追加可、他社・本部権限は不可', async () => {
  const aa = await client('a-admin@example.com');
  assert.equal((await aa('POST', '/api/clinics', { name: 'A3院', manager: '田中', company_id: 2 })).status, 200);
  const m = (await aa('GET', '/api/manage')).data;
  assert.ok(m.clinics.every((c) => c.company_id === 1) && m.clinics.some((c) => c.name === 'A3院')); // company_id は自社に強制
  const clinicId = m.clinics.find((c) => c.name === 'A3院').id;
  assert.equal((await aa('POST', '/api/users', { email: 'a3@example.com', role: 'clinic_staff', clinic_id: clinicId })).status, 200);
  assert.equal((await aa('POST', '/api/users', { email: 'x@example.com', role: 'admin' })).status, 403);
  assert.equal((await aa('POST', '/api/users', { email: 'y@example.com', role: 'clinic_staff', clinic_id: 3 })).status, 400); // 他社の院
  assert.equal((await aa('PUT', '/api/company-items', { company_id: 1, item_id: 3, enabled: true })).status, 403);
  assert.equal((await aa('POST', '/api/items', { label: 'x' })).status, 403);
});

test('マスター更新は全社に反映 / 会社別の項目切替', async () => {
  const ad = await client('admin@example.com');
  await ad('PUT', '/api/items/1', { label: '施術料' });
  const b1 = await client('b1@example.com');
  let s = (await b1('GET', '/api/sheet?clinic_id=3&ym=2026-11')).data;
  assert.deepEqual(s.items.map((i) => i.label), ['施術料', '項目3']);
  await ad('PUT', '/api/company-items', { company_id: 2, item_id: 4, enabled: true });
  s = (await b1('GET', '/api/sheet?clinic_id=3&ym=2026-11')).data;
  assert.equal(s.items.length, 3);
});

test('同一会社内の重複登録は警告、会社が違えば別ID体系', async () => {
  const a1 = await client('a1@example.com');
  await a1('POST', '/api/patients', { clinic_id: 1, ym: '2026-11', name: '重複', birth: '1990-05-05' });
  assert.equal((await a1('POST', '/api/patients', { clinic_id: 1, ym: '2026-11', name: '重複', birth: '1990-05-05' })).status, 409);
  const a2 = await client('a2@example.com'); // 同社他院でも検出
  assert.equal((await a2('POST', '/api/patients', { clinic_id: 2, ym: '2026-11', name: '重複', birth: '1990-05-05' })).status, 409);
  const b1 = await client('b1@example.com');
  assert.equal((await b1('POST', '/api/patients', { clinic_id: 3, ym: '2026-11', name: '重複', birth: '1990-05-05' })).status, 200);
  const s = (await b1('GET', '/api/sheet?clinic_id=3&ym=2026-11')).data;
  assert.equal(s.new[0].code, 'C2-0001');
});

test('不正な年月・先の月は拒否', async () => {
  const a1 = await client('a1@example.com');
  assert.equal((await a1('GET', '/api/sheet?clinic_id=1&ym=2026-13')).status, 400);
  assert.equal((await a1('GET', '/api/sheet?clinic_id=1&ym=2099-01')).status, 400);
});
