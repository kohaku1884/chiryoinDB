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
    `SELECT i.id,i.label FROM items i JOIN company_items ci ON ci.item_id=i.id
     WHERE ci.company_id=? ORDER BY i.id`, companyId);

  // ---- 月次シート ----
  // 既存患者（先月以前から継続）の月次レコードを、前月の内容をコピーして自動生成する
  function carryOver(clinicId, ym) {
    const missing = all(
      `SELECT p.id FROM patients p
       WHERE p.clinic_id=? AND p.first_month < ? AND (p.ended_month IS NULL OR p.ended_month >= ?)
         AND NOT EXISTS (SELECT 1 FROM records r WHERE r.patient_id=p.id AND r.ym=?)`,
      clinicId, ym, ym, ym);
    for (const { id } of missing) {
      const prev = get('SELECT visits,vals FROM records WHERE patient_id=? AND ym<? ORDER BY ym DESC LIMIT 1', id, ym);
      run('INSERT INTO records(patient_id,ym,visits,vals,state) VALUES (?,?,?,?,?)',
        id, ym, prev ? prev.visits : 0, prev ? prev.vals : '{}', 'pending');
    }
  }
  function buildSheet(clinic, ym) {
    carryOver(clinic.id, ym);
    const items = enabledItems(clinic.company_id);
    const rows = all(
      `SELECT r.id AS record_id, r.visits, r.vals, r.state, p.id AS patient_id, p.seq, p.name, p.birth, p.first_month
       FROM records r JOIN patients p ON p.id=r.patient_id
       WHERE p.clinic_id=? AND r.ym=? ORDER BY p.seq`, clinic.id, ym).map((r) => {
      const vals = JSON.parse(r.vals);
      const shown = {};
      let total = 0;
      for (const it of items) { shown[it.id] = Number(vals[it.id] || 0); total += shown[it.id]; }
      return {
        record_id: r.record_id, patient_id: r.patient_id,
        code: `C${clinic.company_id}-${String(r.seq).padStart(4, '0')}`,
        name: r.name, birth: r.birth, visits: r.visits, vals: shown, total, state: r.state,
        isNew: r.first_month === ym,
      };
    });
    const sum = (list) => {
      const t = { visits: 0, total: 0, vals: {} };
      for (const it of items) t.vals[it.id] = 0;
      for (const r of list) { t.visits += r.visits; t.total += r.total; for (const it of items) t.vals[it.id] += r.vals[it.id]; }
      return t;
    };
    const active = rows.filter((r) => r.state !== 'ended');
    const newP = rows.filter((r) => r.isNew);
    const existing = rows.filter((r) => !r.isNew);
    return {
      clinic, ym, items, new: newP, existing,
      totals: { new: sum(newP.filter((r) => r.state !== 'ended')), existing: sum(existing.filter((r) => r.state !== 'ended')), all: sum(active) },
    };
  }

  function recordOf(u, id) {
    const r = get(`SELECT r.*, p.clinic_id, p.company_id FROM records r JOIN patients p ON p.id=r.patient_id WHERE r.id=?`, Number(id));
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

  route('POST', '/api/patients', ({ user, body }) => {
    requireAuth(user);
    const clinic = clinicOf(user, body.clinic_id);
    const name = String(body.name || '').trim();
    const birth = String(body.birth || '');
    if (!name || name.length > 50) throw bad('氏名を入力してください（50文字以内）');
    if (birth && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) throw bad('生年月日の形式が不正です');
    if (!ymRe.test(body.ym || '')) throw bad('年月の形式が不正です');
    // 会社内での重複チェック（氏名+生年月日）。force=true で承知の上登録
    const dup = get('SELECT id FROM patients WHERE company_id=? AND name=? AND birth=?', clinic.company_id, name, birth);
    if (dup && !body.force) throw new HttpError(409, '同じ氏名・生年月日の患者が既に登録されています（同一会社内）');
    return tx(() => {
      const seq = get('SELECT COALESCE(MAX(seq),0)+1 s FROM patients WHERE company_id=?', clinic.company_id).s;
      const pid = run('INSERT INTO patients(company_id,clinic_id,seq,name,birth,first_month) VALUES (?,?,?,?,?,?)',
        clinic.company_id, clinic.id, seq, name, birth, body.ym).lastInsertRowid;
      run('INSERT INTO records(patient_id,ym,state) VALUES (?,?,?)', pid, body.ym, 'confirmed');
      return { ok: true };
    });
  });

  // 編集できるのは visits と有効な項目の数値のみ（合計などの計算値は受け付けない）
  route('PUT', '/api/records/:id', ({ user, params, body }) => {
    requireAuth(user);
    const r = recordOf(user, params.id);
    if (r.state === 'ended') throw bad('終了した患者は編集できません');
    const allowed = new Set(enabledItems(r.company_id).map((i) => String(i.id)));
    const vals = JSON.parse(r.vals);
    let visits = r.visits;
    if (body.visits !== undefined) {
      visits = Number(body.visits);
      if (!Number.isInteger(visits) || visits < 0 || visits > 999) throw bad('来院回数は0〜999の整数です');
    }
    for (const [k, v] of Object.entries(body.vals || {})) {
      if (!allowed.has(k)) throw bad('この会社では使用できない項目です');
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 99999999) throw bad('数値が不正です');
      vals[k] = n;
    }
    run('UPDATE records SET visits=?, vals=? WHERE id=?', visits, JSON.stringify(vals), r.id);
    return { ok: true };
  });

  // 既存患者の継続確認 / 終了 / 取消
  route('POST', '/api/records/:id/state', ({ user, params, body }) => {
    requireAuth(user);
    const r = recordOf(user, params.id);
    if (!['confirmed', 'ended', 'pending'].includes(body.state)) throw bad('state が不正です');
    tx(() => {
      run('UPDATE records SET state=? WHERE id=?', body.state, r.id);
      run('UPDATE patients SET ended_month=? WHERE id=?', body.state === 'ended' ? r.ym : null, r.patient_id);
      // 終了を取り消した場合、それ以降の月に作られた自動コピーは破棄してやり直す
      if (body.state !== 'ended') run("DELETE FROM records WHERE patient_id=? AND ym>? AND state='pending'", r.patient_id, r.ym);
    });
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
    return { id: run('INSERT INTO items(label) VALUES (?)', label).lastInsertRowid };
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
