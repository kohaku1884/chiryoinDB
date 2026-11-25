// 整骨院 患者管理シート プロトタイプ サーバー（依存パッケージなし）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, seed } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m = '権限がありません') => new HttpError(403, m);
const notFound = (m = '見つかりません') => new HttpError(404, m);

const ymRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const curYm = () => new Date().toISOString().slice(0, 7);
// 月が終わってから LOCK_MONTHS か月が過ぎると編集ロック（当月・翌月・翌々月は編集可）
const LOCK_MONTHS = 2;
const addYm = (ym, n) => { for (let i = 0; i < n; i++) ym = nextYm(ym); return ym; };

export function createApp({ db, devLogin = true }) {
  const sessions = new Map(); // token -> email（本番は Google ログインの検証に置換）
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  // ---- 権限 ----
  const requireAuth = (u) => { if (!u) throw new HttpError(401, 'ログインしてください'); return u; };
  const canCompany = (u, companyId) => u.role === 'admin' || u.company_id === companyId;
  function clinicOf(u, clinicId) {
    const c = get('SELECT * FROM clinics WHERE id=?', Number(clinicId));
    if (!c) throw notFound('院が見つかりません');
    const ok = u.role === 'admin' || (u.role === 'company_admin' && u.company_id === c.company_id)
      || (u.role === 'clinic_staff' && u.clinic_id === c.id);
    if (!ok) throw forbidden();
    return c;
  }
  const scopedClinics = (u) => u.role === 'admin' ? all('SELECT * FROM clinics ORDER BY id')
    : u.role === 'company_admin' ? all('SELECT * FROM clinics WHERE company_id=? ORDER BY id', u.company_id)
    : all('SELECT * FROM clinics WHERE id=?', u.clinic_id);
  const enabledItems = (companyId) => all(
    `SELECT i.id,i.key,i.label,i.type FROM items i JOIN company_items ci ON ci.item_id=i.id
     WHERE ci.company_id=? ORDER BY i.id`, companyId);

  // ---- 編集ロック ----
  const isLocked = (clinicId, ym) => curYm() > addYm(ym, LOCK_MONTHS)
    && !get('SELECT 1 FROM month_unlocks WHERE clinic_id=? AND ym=?', clinicId, ym);
  const assertEditable = (clinicId, ym) => {
    if (isLocked(clinicId, ym)) throw new HttpError(423, `${ym} は編集ロックされています。解除は運営にご依頼ください`);
  };

  // ---- 日付・値の検証 ----
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const daysIn = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
  const DAY_KEYS = ['d10', 'd15', 'd20', 'dend']; // 時点の順（後の時点ほど値は大きくなる）
  const maxOf = (key, ym) => ({ d10: 10, d15: 15, d20: 20, dend: daysIn(ym), parts: 99 }[key] ?? 99_999_999);
  const itemById = (list, id) => list.find((i) => String(i.id) === String(id));

  // 入力値を検証して vals にマージする（数値は0以上の整数、チェックは0/1）
  function mergeVals(items, vals, input, ym) {
    for (const [id, raw] of Object.entries(input || {})) {
      const it = itemById(items, id);
      if (!it) throw bad('この会社では使用できない項目です');
      if (it.type === 'check') {
        if (raw !== true && raw !== false && raw !== 0 && raw !== 1) throw bad(`${it.label}の値が不正です`);
        vals[it.id] = raw ? 1 : 0;
      } else {
        const n = Number(raw);
        if (raw === '' || raw === null || !Number.isInteger(n) || n < 0) throw bad(`${it.label}は0以上の整数で入力してください`);
        if (n > maxOf(it.key, ym)) throw bad(`${it.label}は${maxOf(it.key, ym).toLocaleString('ja-JP')}以下で入力してください`);
        vals[it.id] = n;
      }
    }
    // 通院日数: 後の時点の値が（入力済みで）前の時点より小さいのは不正
    let prev = 0, prevLabel = '';
    for (const key of DAY_KEYS) {
      const it = items.find((i) => i.key === key);
      if (!it) continue;
      const v = Number(vals[it.id] || 0);
      if (v > 0 && v < prev) throw bad(`${it.label}が${prevLabel}より少なくなっています`);
      if (v > 0) { prev = v; prevLabel = it.label; }
    }
    return vals;
  }

  // ---- 月次シート ----
  // 既存案件（先月以前から継続）の月次レコードを自動生成。引き継ぐのは carry=1 の項目（弁護士紹介済みなど）だけ。
  // 通院日数・請求金額などは毎月0から入力する。
  function carryOver(clinicId, ym) {
    const carryIds = all('SELECT id FROM items WHERE carry=1').map((i) => String(i.id));
    const missing = all(
      `SELECT c.id FROM cases c
       WHERE c.clinic_id=? AND c.first_month < ? AND (c.ended_month IS NULL OR c.ended_month >= ?)
         AND NOT EXISTS (SELECT 1 FROM records r WHERE r.case_id=c.id AND r.ym=?)`,
      clinicId, ym, ym, ym);
    for (const { id } of missing) {
      const prev = get('SELECT vals FROM records WHERE case_id=? AND ym<? ORDER BY ym DESC LIMIT 1', id, ym);
      const pv = prev ? JSON.parse(prev.vals) : {};
      const vals = {};
      for (const k of carryIds) if (pv[k] !== undefined) vals[k] = pv[k];
      run('INSERT INTO records(case_id,ym,vals,state) VALUES (?,?,?,?)', id, ym, JSON.stringify(vals), 'pending');
    }
  }
  function buildSheet(clinic, ym) {
    carryOver(clinic.id, ym);
    const items = enabledItems(clinic.company_id);
    const dend = items.find((i) => i.key === 'dend');
    // 累計通院日数 = 事故案件ごとの「通院日数（末日）」の月次合計（この月まで）
    const cumulative = {};
    if (dend) {
      for (const r of all(`SELECT r.case_id, r.vals FROM records r JOIN cases c ON c.id=r.case_id WHERE c.clinic_id=? AND r.ym<=?`, clinic.id, ym)) {
        cumulative[r.case_id] = (cumulative[r.case_id] || 0) + Number(JSON.parse(r.vals)[dend.id] || 0);
      }
    }
    const caseCount = Object.fromEntries(all('SELECT patient_id, COUNT(*) n FROM cases WHERE company_id=? GROUP BY patient_id', clinic.company_id).map((x) => [x.patient_id, x.n]));
    const rows = all(
      `SELECT r.id AS record_id, r.vals, r.state, c.id AS case_id, c.case_no, c.accident_date, c.first_visit, c.first_month,
              p.id AS patient_id, p.seq, p.name, p.birth
       FROM records r JOIN cases c ON c.id=r.case_id JOIN patients p ON p.id=c.patient_id
       WHERE c.clinic_id=? AND r.ym=? ORDER BY p.seq, c.case_no`, clinic.id, ym).map((r) => {
      const vals = JSON.parse(r.vals);
      const shown = {};
      for (const it of items) shown[it.id] = Number(vals[it.id] || 0);
      return {
        record_id: r.record_id, case_id: r.case_id, patient_id: r.patient_id,
        code: `C${clinic.company_id}-${String(r.seq).padStart(4, '0')}-${r.case_no}`,
        name: r.name, birth: r.birth, accident_date: r.accident_date, first_visit: r.first_visit,
        case_no: r.case_no, multi: caseCount[r.patient_id] > 1,
        vals: shown, cumulative: cumulative[r.case_id] || 0, state: r.state, isNew: r.first_month === ym,
      };
    });
    const sum = (list) => {
      const t = { cumulative: 0, vals: {} };
      for (const it of items) t.vals[it.id] = 0;
      for (const r of list) { t.cumulative += r.cumulative; for (const it of items) t.vals[it.id] += r.vals[it.id]; } // チェック項目は件数になる
      return t;
    };
    const live = (list) => list.filter((r) => r.state !== 'ended');
    const newP = rows.filter((r) => r.isNew);
    const existing = rows.filter((r) => !r.isNew);
    return {
      clinic, ym, items, locked: isLocked(clinic.id, ym), past: curYm() > addYm(ym, LOCK_MONTHS), new: newP, existing,
      totals: { new: sum(live(newP)), existing: sum(live(existing)), all: sum(live(rows)) },
    };
  }

  function recordOf(u, id) {
    const r = get(`SELECT r.*, c.clinic_id, c.company_id, c.patient_id FROM records r JOIN cases c ON c.id=r.case_id WHERE r.id=?`, Number(id));
    if (!r) throw notFound();
    clinicOf(u, r.clinic_id);
    return r;
  }

  // ---- ルーティング ----
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  route('POST', '/api/login', ({ body, setSession }) => {
    if (!devLogin) throw forbidden('開発用ログインは無効です');
    const u = get('SELECT * FROM users WHERE email=?', String(body.email || '').toLowerCase());
    if (!u) throw new HttpError(401, '登録されていないアカウントです');
    setSession(u.email);
    return u;
  });
  route('POST', '/api/logout', ({ clearSession }) => { clearSession(); return { ok: true }; });
  route('GET', '/api/dev-users', () => { if (!devLogin) throw notFound(); return all('SELECT email,name,role FROM users ORDER BY rowid'); });
  route('GET', '/api/me', ({ user }) => requireAuth(user));

  route('GET', '/api/clinics', ({ user }) => scopedClinics(requireAuth(user)));

  route('GET', '/api/sheet', ({ user, query }) => {
    requireAuth(user);
    const clinic = clinicOf(user, query.clinic_id);
    const ym = query.ym;
    if (!ymRe.test(ym || '')) throw bad('年月の形式が不正です');
    if (ym > nextYm(curYm())) throw bad('翌月より先のシートは作成できません');
    return tx(() => buildSheet(clinic, ym));
  });

  function checkCaseDates(accident, firstVisit) {
    if (!isDate(accident)) throw bad('事故日を正しく入力してください');
    if (!isDate(firstVisit)) throw bad('初診日を正しく入力してください');
    if (firstVisit < accident) throw bad('初診日が事故日より前になっています');
  }

  // 事故案件の登録。同じ氏名+生年月日の患者が会社内にいれば同一人物として、その人の事故として追加する
  route('POST', '/api/cases', ({ user, body }) => {
    requireAuth(user);
    const clinic = clinicOf(user, body.clinic_id);
    const name = String(body.name || '').trim();
    const birth = String(body.birth || '');
    if (!name || name.length > 50) throw bad('氏名を入力してください（50文字以内）');
    if (!isDate(birth)) throw bad('生年月日を正しく入力してください');
    if (!ymRe.test(body.ym || '')) throw bad('年月の形式が不正です');
    assertEditable(clinic.id, body.ym);
    checkCaseDates(body.accident_date, body.first_visit);
    if (body.first_visit.slice(0, 7) > body.ym) throw bad('初診日がこの月より後になっています');
    return tx(() => {
      let p = get('SELECT * FROM patients WHERE company_id=? AND name=? AND birth=?', clinic.company_id, name, birth);
      const existingPatient = !!p;
      if (!p) {
        const seq = get('SELECT COALESCE(MAX(seq),0)+1 s FROM patients WHERE company_id=?', clinic.company_id).s;
        const id = run('INSERT INTO patients(company_id,seq,name,birth) VALUES (?,?,?,?)', clinic.company_id, seq, name, birth).lastInsertRowid;
        p = { id };
      } else if (get('SELECT 1 FROM cases WHERE patient_id=? AND accident_date=?', p.id, body.accident_date)) {
        throw new HttpError(409, '同じ患者・同じ事故日の案件が既に登録されています');
      }
      const caseNo = get('SELECT COALESCE(MAX(case_no),0)+1 n FROM cases WHERE patient_id=?', p.id).n;
      const cid = run(`INSERT INTO cases(patient_id,company_id,clinic_id,case_no,accident_date,first_visit,first_month) VALUES (?,?,?,?,?,?,?)`,
        p.id, clinic.company_id, clinic.id, caseNo, body.accident_date, body.first_visit, body.ym).lastInsertRowid;
      run('INSERT INTO records(case_id,ym,state) VALUES (?,?,?)', cid, body.ym, 'confirmed');
      return { ok: true, existing_patient: existingPatient, case_no: caseNo };
    });
  });

  // 事故日・初診日の修正（入力ミスの訂正用）
  route('PUT', '/api/cases/:id', ({ user, params, body }) => {
    requireAuth(user);
    const c = get('SELECT * FROM cases WHERE id=?', Number(params.id));
    if (!c) throw notFound();
    clinicOf(user, c.clinic_id);
    if (!ymRe.test(body.ym || '')) throw bad('年月の形式が不正です');
    assertEditable(c.clinic_id, body.ym);
    const accident = body.accident_date ?? c.accident_date;
    const firstVisit = body.first_visit ?? c.first_visit;
    checkCaseDates(accident, firstVisit);
    if (get('SELECT 1 FROM cases WHERE patient_id=? AND accident_date=? AND id<>?', c.patient_id, accident, c.id)) {
      throw new HttpError(409, '同じ患者・同じ事故日の案件が既に登録されています');
    }
    run('UPDATE cases SET accident_date=?, first_visit=? WHERE id=?', accident, firstVisit, c.id);
    return { ok: true };
  });

  // 編集できるのは有効な項目の値だけ（累計などの計算値は受け付けない）
  route('PUT', '/api/records/:id', ({ user, params, body }) => {
    requireAuth(user);
    const r = recordOf(user, params.id);
    assertEditable(r.clinic_id, r.ym);
    if (r.state === 'ended') throw bad('終了した案件は編集できません');
    const vals = mergeVals(enabledItems(r.company_id), JSON.parse(r.vals), body.vals, r.ym);
    run('UPDATE records SET vals=? WHERE id=?', JSON.stringify(vals), r.id);
    return { ok: true };
  });

  // 既存案件の継続確認 / 終了 / 取消
  route('POST', '/api/records/:id/state', ({ user, params, body }) => {
    requireAuth(user);
    const r = recordOf(user, params.id);
    if (!['confirmed', 'ended', 'pending'].includes(body.state)) throw bad('state が不正です');
    assertEditable(r.clinic_id, r.ym);
    tx(() => {
      run('UPDATE records SET state=? WHERE id=?', body.state, r.id);
      run('UPDATE cases SET ended_month=? WHERE id=?', body.state === 'ended' ? r.ym : null, r.case_id);
      // 終了を取り消した場合、それ以降の月に作られた自動コピーは破棄してやり直す
      if (body.state !== 'ended') run("DELETE FROM records WHERE case_id=? AND ym>? AND state='pending'", r.case_id, r.ym);
    });
    return { ok: true };
  });

  // 運営(自社)のみ: 過去月のロック解除 / 再ロック
  route('POST', '/api/lock', ({ user, body }) => {
    if (requireAuth(user).role !== 'admin') throw forbidden();
    const clinic = clinicOf(user, body.clinic_id);
    if (!ymRe.test(body.ym || '')) throw bad('年月の形式が不正です');
    if (body.locked) run('DELETE FROM month_unlocks WHERE clinic_id=? AND ym=?', clinic.id, body.ym);
    else run('INSERT OR IGNORE INTO month_unlocks(clinic_id,ym) VALUES (?,?)', clinic.id, body.ym);
    return { ok: true };
  });

  // ---- 管理 ----
  route('GET', '/api/manage', ({ user }) => {
    requireAuth(user);
    if (user.role === 'clinic_staff') throw forbidden();
    const cid = user.role === 'admin' ? null : user.company_id;
    const w = cid ? ' WHERE company_id=?' : '';
    const a = cid ? [cid] : [];
    return {
      companies: cid ? all('SELECT * FROM companies WHERE id=?', cid) : all('SELECT * FROM companies ORDER BY id'),
      clinics: all(`SELECT * FROM clinics${w} ORDER BY id`, ...a),
      users: all(`SELECT * FROM users${w} ORDER BY rowid`, ...a),
      items: all('SELECT * FROM items ORDER BY id'),
      company_items: all(`SELECT * FROM company_items${w}`, ...a),
    };
  });
  route('POST', '/api/companies', ({ user, body }) => {
    if (requireAuth(user).role !== 'admin') throw forbidden();
    const name = String(body.name || '').trim();
    if (!name) throw bad('会社名を入力してください');
    return tx(() => {
      const id = run('INSERT INTO companies(name) VALUES (?)', name).lastInsertRowid;
      run('INSERT INTO company_items SELECT ?, id FROM items', id);
      return { id };
    });
  });
  route('POST', '/api/clinics', ({ user, body }) => {
    requireAuth(user);
    if (user.role === 'clinic_staff') throw forbidden();
    const companyId = user.role === 'admin' ? Number(body.company_id) : user.company_id;
    if (!get('SELECT 1 FROM companies WHERE id=?', companyId)) throw bad('会社が不正です');
    const name = String(body.name || '').trim();
    if (!name) throw bad('院名を入力してください');
    const id = run('INSERT INTO clinics(company_id,name,manager) VALUES (?,?,?)', companyId, name, String(body.manager || '').trim()).lastInsertRowid;
    return { id };
  });
  route('POST', '/api/users', ({ user, body }) => {
    requireAuth(user);
    if (user.role === 'clinic_staff') throw forbidden();
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('メールアドレスが不正です');
    if (get('SELECT 1 FROM users WHERE email=?', email)) throw new HttpError(409, '既に登録されています');
    const name = String(body.name || '').trim() || email;
    let { role, company_id, clinic_id } = body;
    if (user.role === 'company_admin') { // 会社管理者は自社内のアカウントのみ追加可
      if (!['company_admin', 'clinic_staff'].includes(role)) throw forbidden();
      company_id = user.company_id;
    }
    if (!['admin', 'company_admin', 'clinic_staff'].includes(role)) throw bad('権限が不正です');
    if (role === 'admin') { company_id = null; clinic_id = null; }
    else {
      if (!get('SELECT 1 FROM companies WHERE id=?', Number(company_id))) throw bad('会社が必要です');
      if (role === 'company_admin') clinic_id = null;
      else {
        const c = get('SELECT company_id FROM clinics WHERE id=?', Number(clinic_id));
        if (!c || c.company_id !== Number(company_id)) throw bad('院が不正です');
      }
    }
    run('INSERT INTO users(email,name,role,company_id,clinic_id) VALUES (?,?,?,?,?)',
      email, name, role, company_id == null ? null : Number(company_id), clinic_id == null ? null : Number(clinic_id));
    return { ok: true };
  });
  route('POST', '/api/items', ({ user, body }) => {
    if (requireAuth(user).role !== 'admin') throw forbidden();
    const label = String(body.label || '').trim();
    if (!label) throw bad('項目名を入力してください');
    const type = body.type === 'check' ? 'check' : 'number';
    return { id: run('INSERT INTO items(label,type,carry) VALUES (?,?,0)', label, type).lastInsertRowid };
  });
  route('PUT', '/api/items/:id', ({ user, params, body }) => {
    if (requireAuth(user).role !== 'admin') throw forbidden();
    const label = String(body.label || '').trim();
    if (!label) throw bad('項目名を入力してください');
    run('UPDATE items SET label=? WHERE id=?', label, Number(params.id)); // 全社に反映
    return { ok: true };
  });
  route('PUT', '/api/company-items', ({ user, body }) => {
    if (requireAuth(user).role !== 'admin') throw forbidden();
    const cid = Number(body.company_id), iid = Number(body.item_id);
    if (!get('SELECT 1 FROM companies WHERE id=?', cid) || !get('SELECT 1 FROM items WHERE id=?', iid)) throw bad('不正な指定です');
    if (body.enabled) run('INSERT OR IGNORE INTO company_items VALUES (?,?)', cid, iid);
    else run('DELETE FROM company_items WHERE company_id=? AND item_id=?', cid, iid);
    return { ok: true };
  });

  // ---- HTTP ----
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((s) => s.trim().split('=')).filter((p) => p[0]));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, data, headers = {}) => {
      const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(body);
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        const token = parseCookies(req.headers.cookie).sid;
        const email = token && sessions.get(token);
        const user = email ? get('SELECT * FROM users WHERE email=?', email) : null;
        let body = {};
        if (req.method !== 'GET') {
          const chunks = []; let size = 0;
          for await (const c of req) { size += c.length; if (size > 100_000) throw bad('リクエストが大きすぎます'); chunks.push(c); }
          try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw bad('JSON が不正です'); }
        }
        const extra = {};
        const ctx = {
          user, body, query: Object.fromEntries(url.searchParams),
          setSession: (e) => { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, e); extra['Set-Cookie'] = `sid=${t}; HttpOnly; SameSite=Strict; Path=/`; },
          clearSession: () => { if (token) sessions.delete(token); extra['Set-Cookie'] = 'sid=; Max-Age=0; Path=/'; },
        };
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (m) return send(200, r.handler({ ...ctx, params: m.groups || {} }), extra);
        }
        throw notFound('API が見つかりません');
      }
      // 静的ファイル
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw notFound();
      send(200, fs.readFileSync(file), { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'サーバーエラー' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  seed(db);
  const port = Number(process.env.PORT || 3000);
  createApp({ db, devLogin: process.env.DEV_LOGIN !== '0' }).listen(port, () => console.log(`http://localhost:${port}`));
}
