import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, seed } from './db.js';
import { createApp } from './server.js';

// 月はテスト実行日からの相対で決める（ロック期限を跨いでも壊れないように）
const ymOf = (n) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 7); };
const PREV = ymOf(-1), CUR = ymOf(0), NEXT = ymOf(1), OLD = ymOf(-4);

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

const itemId = (key) => db.prepare('SELECT id FROM items WHERE key=?').get(key).id;
const sheet = async (c, clinic, ym) => (await c('GET', `/api/sheet?clinic_id=${clinic}&ym=${ym}`)).data;
const newCase = (clinic, ym, o = {}) => ({ clinic_id: clinic, ym, name: '患者', birth: '1980-01-01', accident_date: `${ym}-01`, first_visit: `${ym}-03`, ...o });
const put = (c, rid, key, v) => c('PUT', `/api/records/${rid}`, { vals: { [itemId(key)]: v } });

test('未ログインは拒否', async () => {
  assert.equal((await (await client())('GET', '/api/clinics')).status, 401);
});

test('マスター項目は交通事故用の7項目（氏名・初診日・事故日は案件の基本情報）', async () => {
  const c = await client('a1@example.com');
  const s = await sheet(c, 1, CUR);
  assert.deepEqual(s.items.map((i) => i.label), [
    '通院日数（10日時点）', '通院日数（15日時点）', '通院日数（20日時点）', '通院日数（末日）',
    '請求金額', '請求部位数', '弁護士紹介済み']);
  assert.equal(s.items.at(-1).type, 'check');
});

test('同一人物の複数事故は同じ患者の別案件になる', async () => {
  const c = await client('a1@example.com');
  const r1 = await c('POST', '/api/cases', newCase(1, CUR, { name: '事故太郎', accident_date: `${PREV}-05`, first_visit: `${PREV}-10` }));
  assert.equal(r1.status, 200); assert.equal(r1.data.existing_patient, false);
  const r2 = await c('POST', '/api/cases', newCase(1, CUR, { name: '事故太郎', accident_date: `${CUR}-02`, first_visit: `${CUR}-04` }));
  assert.equal(r2.status, 200); assert.equal(r2.data.existing_patient, true); assert.equal(r2.data.case_no, 2);
  const rows = (await sheet(c, 1, CUR)).new.filter((r) => r.name === '事故太郎');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.code), ['C1-0001-1', 'C1-0001-2']); // 同じ患者ID、事故ごとの枝番
  assert.ok(rows.every((r) => r.multi));
  // 同じ事故日の二重登録は拒否
  assert.equal((await c('POST', '/api/cases', newCase(1, CUR, { name: '事故太郎', accident_date: `${CUR}-02`, first_visit: `${CUR}-04` }))).status, 409);
  // 別の人（生年月日が違う）は別患者
  const r3 = await c('POST', '/api/cases', newCase(1, CUR, { name: '事故太郎', birth: '1990-02-02' }));
  assert.equal(r3.data.existing_patient, false);
});

test('日付の検証: 初診日は事故日以降、存在する日付のみ', async () => {
  const c = await client('a1@example.com');
  assert.equal((await c('POST', '/api/cases', newCase(1, CUR, { name: 'X', accident_date: `${CUR}-10`, first_visit: `${CUR}-05` }))).status, 400);
  assert.equal((await c('POST', '/api/cases', newCase(1, CUR, { name: 'X', accident_date: '2026-02-30' }))).status, 400);
  assert.equal((await c('POST', '/api/cases', newCase(1, CUR, { name: 'X', birth: '' }))).status, 400);
  assert.equal((await c('POST', '/api/cases', newCase(1, PREV, { name: 'X', accident_date: `${CUR}-01`, first_visit: `${CUR}-02` }))).status, 400); // 初診日がシートの月より後
});

test('月次入力: 通院日数の上限・順序、金額・部位数・チェック', async () => {
  const c = await client('a1@example.com');
  await c('POST', '/api/cases', newCase(1, CUR, { name: '入力花子' }));
  const rid = (await sheet(c, 1, CUR)).new.find((r) => r.name === '入力花子').record_id;
  assert.equal((await put(c, rid, 'd10', 11)).status, 400); // 10日時点は10日まで
  assert.equal((await put(c, rid, 'd15', 16)).status, 400);
  assert.equal((await put(c, rid, 'dend', 32)).status, 400);
  assert.equal((await put(c, rid, 'amount', -1)).status, 400);
  assert.equal((await put(c, rid, 'amount', 1.5)).status, 400);
  assert.equal((await put(c, rid, 'parts', 100)).status, 400);
  assert.equal((await put(c, rid, 'lawyer', 'yes')).status, 400);
  assert.equal((await put(c, rid, 'd10', 6)).status, 200);
  assert.equal((await put(c, rid, 'd15', 9)).status, 200);
  assert.equal((await put(c, rid, 'd15', 5)).status, 400); // 10日時点(6)より少ない
  assert.equal((await put(c, rid, 'amount', 120000)).status, 200);
  assert.equal((await put(c, rid, 'parts', 3)).status, 200);
  assert.equal((await put(c, rid, 'lawyer', true)).status, 200);
  const row = (await sheet(c, 1, CUR)).new.find((r) => r.name === '入力花子');
  assert.equal(row.vals[itemId('amount')], 120000);
  assert.equal(row.vals[itemId('lawyer')], 1);
  // 計算値は受け付けない
  assert.equal((await c('PUT', `/api/records/${rid}`, { vals: { cumulative: 99 } })).status, 400);
});

test('翌月: 通院日数・金額は0から、弁護士紹介済みだけ引き継ぎ、累計通院日数は積み上がる', async () => {
  const c = await client('b1@example.com');
  await c('POST', '/api/cases', newCase(3, PREV, { name: '繰越', accident_date: `${PREV}-01`, first_visit: `${PREV}-02` }));
  const rid = (await sheet(c, 3, PREV)).new[0].record_id;
  await put(c, rid, 'dend', 12); await put(c, rid, 'amount', 80000); await put(c, rid, 'lawyer', true);
  let s = await sheet(c, 3, CUR);
  assert.equal(s.new.length, 0);
  let row = s.existing.find((r) => r.name === '繰越');
  assert.equal(row.state, 'pending');
  assert.equal(row.vals[itemId('amount')], 0);
  assert.equal(row.vals[itemId('dend')], 0);
  assert.equal(row.vals[itemId('lawyer')], 1);
  assert.equal(row.cumulative, 12);
  await put(c, row.record_id, 'dend', 7);
  row = (await sheet(c, 3, CUR)).existing.find((r) => r.name === '繰越');
  assert.equal(row.cumulative, 19);
  // 終了 → 同月は表示（合計から除外）、翌月は非表示
  await c('POST', `/api/records/${row.record_id}/state`, { state: 'ended' });
  s = await sheet(c, 3, CUR);
  assert.equal(s.existing.find((r) => r.name === '繰越').state, 'ended');
  assert.equal(s.totals.existing.cumulative, 0);
  assert.equal((await put(c, row.record_id, 'dend', 8)).status, 400);
  assert.equal((await sheet(c, 3, NEXT)).existing.find((r) => r.name === '繰越'), undefined);
});

test('事故日・初診日の訂正', async () => {
  const c = await client('a1@example.com');
  await c('POST', '/api/cases', newCase(1, CUR, { name: '訂正', birth: '1971-01-01', accident_date: `${CUR}-05`, first_visit: `${CUR}-06` }));
  const row = (await sheet(c, 1, CUR)).new.find((r) => r.name === '訂正');
  assert.equal((await c('PUT', `/api/cases/${row.case_id}`, { ym: CUR, first_visit: `${CUR}-04` })).status, 400); // 事故日より前
  assert.equal((await c('PUT', `/api/cases/${row.case_id}`, { ym: CUR, accident_date: `${CUR}-03` })).status, 200);
  assert.equal((await sheet(c, 1, CUR)).new.find((r) => r.name === '訂正').accident_date, `${CUR}-03`);
});

test('権限: 他院・他社は閲覧/編集不可', async () => {
  const a1 = await client('a1@example.com');
  assert.equal((await a1('GET', `/api/sheet?clinic_id=2&ym=${CUR}`)).status, 403);
  assert.equal((await a1('GET', `/api/sheet?clinic_id=3&ym=${CUR}`)).status, 403);
  assert.equal((await a1('GET', '/api/manage')).status, 403);
  const aa = await client('a-admin@example.com');
  assert.equal((await aa('GET', `/api/sheet?clinic_id=2&ym=${CUR}`)).status, 200);
  assert.equal((await aa('GET', `/api/sheet?clinic_id=3&ym=${CUR}`)).status, 403);
  const rid = (await sheet(a1, 1, CUR)).new[0].record_id;
  const b1 = await client('b1@example.com');
  assert.equal((await put(b1, rid, 'amount', 1)).status, 403);
  assert.equal((await b1('POST', `/api/records/${rid}/state`, { state: 'ended' })).status, 403);
  assert.equal((await b1('POST', '/api/cases', newCase(1, CUR))).status, 403);
});

test('管理: 会社管理者は自社に院/アカウントを追加可。項目設定は運営のみ', async () => {
  const aa = await client('a-admin@example.com');
  assert.equal((await aa('POST', '/api/clinics', { name: 'A3院', manager: '田中', company_id: 2 })).status, 200);
  const m = (await aa('GET', '/api/manage')).data;
  assert.ok(m.clinics.every((c) => c.company_id === 1) && m.clinics.some((c) => c.name === 'A3院'));
  const clinicId = m.clinics.find((c) => c.name === 'A3院').id;
  assert.equal((await aa('POST', '/api/users', { email: 'a3@example.com', role: 'clinic_staff', clinic_id: clinicId })).status, 200);
  assert.equal((await aa('POST', '/api/users', { email: 'x@example.com', role: 'admin' })).status, 403);
  assert.equal((await aa('POST', '/api/users', { email: 'y@example.com', role: 'clinic_staff', clinic_id: 3 })).status, 400);
  assert.equal((await aa('PUT', '/api/company-items', { company_id: 1, item_id: 1, enabled: false })).status, 403);
  assert.equal((await aa('POST', '/api/items', { label: 'x' })).status, 403);
});

test('マスター更新は全社に反映 / 会社別の項目オン・オフ / 追加項目', async () => {
  const ad = await client('admin@example.com');
  await ad('PUT', `/api/items/${itemId('amount')}`, { label: '請求金額（円）' });
  await ad('PUT', '/api/company-items', { company_id: 2, item_id: itemId('parts'), enabled: false });
  const b1 = await client('b1@example.com');
  let s = await sheet(b1, 3, CUR);
  assert.ok(s.items.some((i) => i.label === '請求金額（円）'));
  assert.ok(!s.items.some((i) => i.key === 'parts')); // B社は請求部位数をオフ
  const rid = s.new.concat(s.existing)[0].record_id;
  assert.equal((await put(b1, rid, 'parts', 2)).status, 400); // オフの項目には書けない
  const a1 = await client('a1@example.com');
  assert.ok((await sheet(a1, 1, CUR)).items.some((i) => i.key === 'parts')); // A社は使用中のまま
  await ad('POST', '/api/items', { label: '備考件数', type: 'number' });
  await ad('PUT', '/api/company-items', { company_id: 2, item_id: db.prepare('SELECT MAX(id) m FROM items').get().m, enabled: true });
  assert.equal((await sheet(b1, 3, CUR)).items.at(-1).label, '備考件数');
});

test('不正な年月・先の月は拒否', async () => {
  const a1 = await client('a1@example.com');
  assert.equal((await a1('GET', `/api/sheet?clinic_id=1&ym=2026-13`)).status, 400);
  assert.equal((await a1('GET', `/api/sheet?clinic_id=1&ym=2099-01`)).status, 400);
});

test('2か月経過でロック、解除は運営のみ', async () => {
  const a1 = await client('a1@example.com');
  assert.equal((await sheet(a1, 1, ymOf(-2))).locked, false); // 2か月前はまだ編集可
  db.prepare("INSERT INTO patients(company_id,seq,name,birth) VALUES (1,900,'古い','1950-01-01')").run();
  const pid = db.prepare('SELECT id FROM patients WHERE seq=900').get().id;
  const cid = db.prepare(`INSERT INTO cases(patient_id,company_id,clinic_id,case_no,accident_date,first_visit,first_month) VALUES (?,1,1,1,?,?,?)`).run(pid, `${OLD}-01`, `${OLD}-02`, OLD).lastInsertRowid;
  const rid = db.prepare("INSERT INTO records(case_id,ym,state) VALUES (?,?,'confirmed')").run(cid, OLD).lastInsertRowid;
  assert.equal((await sheet(a1, 1, OLD)).locked, true);
  assert.equal((await put(a1, rid, 'amount', 1)).status, 423);
  assert.equal((await a1('POST', `/api/records/${rid}/state`, { state: 'ended' })).status, 423);
  assert.equal((await a1('POST', '/api/cases', newCase(1, OLD, { name: '追加' }))).status, 423);
  assert.equal((await a1('PUT', `/api/cases/${cid}`, { ym: OLD, first_visit: `${OLD}-05` })).status, 423);
  assert.equal((await a1('POST', '/api/lock', { clinic_id: 1, ym: OLD, locked: false })).status, 403);
  const aa = await client('a-admin@example.com');
  assert.equal((await aa('POST', '/api/lock', { clinic_id: 1, ym: OLD, locked: false })).status, 403);
  const ad = await client('admin@example.com');
  assert.equal((await ad('POST', '/api/lock', { clinic_id: 1, ym: OLD, locked: false })).status, 200);
  assert.equal((await put(a1, rid, 'amount', 1)).status, 200);
  assert.equal((await ad('POST', '/api/lock', { clinic_id: 1, ym: OLD, locked: true })).status, 200);
  assert.equal((await put(a1, rid, 'amount', 2)).status, 423);
});
