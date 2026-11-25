// フロントエンド（依存なし）。計算値はすべてサーバーが返すため、画面上で数式を編集する手段は存在しない。
const $app = document.getElementById('app');
const ROLE = { admin: '運営（自社）', company_admin: '会社管理者', clinic_staff: '院担当者' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => Number(n).toLocaleString('ja-JP');
const curYm = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const shiftYm = (ym, d) => { const [y, m] = ym.split('-').map(Number); const t = new Date(y, m - 1 + d, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `エラー (${res.status})`); e.status = res.status; throw e; }
  return data;
}

const S = { me: null, tab: 'sheet', clinics: [], clinicId: null, ym: curYm(), sheet: null, manage: null, error: '' };

async function boot() {
  try { S.me = await api('GET', '/api/me'); } catch { S.me = null; }
  if (!S.me) return renderLogin();
  S.clinics = await api('GET', '/api/clinics');
  S.clinicId = S.clinicId || S.clinics[0]?.id || null;
  await loadSheet();
}

async function renderLogin() {
  let users = [];
  try { users = await api('GET', '/api/dev-users'); } catch { /* 本番では無効 */ }
  $app.innerHTML = `<div class="login section card">
    <h2>患者管理シート</h2>
    <p class="sub">開発用ログイン（本番では「Googleでログイン」に置き換わります）</p>
    ${users.map((u) => `<button class="ghost" data-email="${esc(u.email)}"><b>${esc(u.name)}</b><br><span class="sub">${esc(u.email)} ／ ${ROLE[u.role]}</span></button>`).join('')}
    <div class="err" id="err"></div></div>`;
  $app.querySelectorAll('[data-email]').forEach((b) => b.onclick = async () => {
    try { await api('POST', '/api/login', { email: b.dataset.email }); await boot(); }
    catch (e) { document.getElementById('err').textContent = e.message; }
  });
}

async function loadSheet(error = null, info = '') {
  S.error = error || '';
  S.info = info;
  S.sheet = null;
  if (S.clinicId) {
    try { S.sheet = await api('GET', `/api/sheet?clinic_id=${S.clinicId}&ym=${S.ym}`); }
    catch (e) { S.error = e.message; }
  }
  render();
}

function render() {
  const canManage = S.me.role !== 'clinic_staff';
  $app.innerHTML = `
    <header><h1>患者管理シート</h1>
      <span class="who">${esc(S.me.name)}（${ROLE[S.me.role]}）</span>
      <button class="ghost" id="logout">ログアウト</button></header>
    <nav><button data-tab="sheet" class="${S.tab === 'sheet' ? 'on' : ''}">月次シート</button>
      ${canManage ? `<button data-tab="manage" class="${S.tab === 'manage' ? 'on' : ''}">管理</button>` : ''}</nav>
    <main id="main"></main>`;
  document.getElementById('logout').onclick = async () => { await api('POST', '/api/logout'); S.me = null; renderLogin(); };
  $app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = async () => {
    S.tab = b.dataset.tab;
    if (S.tab === 'manage') S.manage = await api('GET', '/api/manage');
    render();
  });
  if (S.tab === 'manage') renderManage(); else renderSheet();
}

// ---------------- 月次シート ----------------
function renderSheet() {
  const main = document.getElementById('main');
  const sh = S.sheet;
  main.innerHTML = `
    <div class="bar">
      <select id="clinic">${S.clinics.map((c) => `<option value="${c.id}" ${c.id === S.clinicId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <button class="ghost" id="prev">◀</button>
      <input type="month" id="ym" value="${esc(S.ym)}" max="${shiftYm(curYm(), 1)}">
      <button class="ghost" id="next">▶</button>
    </div>
    <div class="err" id="err">${esc(S.error)}</div>
    ${S.info ? `<div class="note">${esc(S.info)}</div>` : ''}
    ${sh ? sheetHtml(sh) : ''}`;
  document.getElementById('clinic').onchange = (e) => { S.clinicId = Number(e.target.value); loadSheet(); };
  document.getElementById('ym').onchange = (e) => { if (e.target.value) { S.ym = e.target.value; loadSheet(); } };
  document.getElementById('prev').onclick = () => { S.ym = shiftYm(S.ym, -1); loadSheet(); };
  document.getElementById('next').onclick = () => { S.ym = shiftYm(S.ym, 1); loadSheet(); };
  if (!sh) return;
  const fail = (e) => { document.getElementById('err').textContent = e.message; };
  main.querySelectorAll('input[data-rec]').forEach((inp) => inp.onchange = async () => {
    const value = inp.type === 'checkbox' ? inp.checked : inp.value;
    try { await api('PUT', `/api/records/${inp.dataset.rec}`, { vals: { [inp.dataset.item]: value } }); await loadSheet(); } catch (e) { fail(e); await loadSheet(e.message); }
  });
  main.querySelectorAll('input[data-case]').forEach((inp) => inp.onchange = async () => {
    try { await api('PUT', `/api/cases/${inp.dataset.case}`, { ym: S.ym, [inp.dataset.field]: inp.value }); await loadSheet(); } catch (e) { await loadSheet(e.message); }
  });
  main.querySelectorAll('button[data-state]').forEach((b) => b.onclick = async () => {
    try { await api('POST', `/api/records/${b.dataset.rec}/state`, { state: b.dataset.state }); await loadSheet(); } catch (e) { fail(e); }
  });
  main.querySelectorAll('button[data-lock]').forEach((b) => b.onclick = async () => {
    try { await api('POST', '/api/lock', { clinic_id: S.clinicId, ym: S.ym, locked: b.dataset.lock === '1' }); await loadSheet(); } catch (e) { fail(e); }
  });
  const form = document.getElementById('add');
  if (form) form.onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { clinic_id: S.clinicId, ym: S.ym, name: form.name.value, birth: form.birth.value, accident_date: form.accident_date.value, first_visit: form.first_visit.value };
    try {
      const r = await api('POST', '/api/cases', body);
      await loadSheet(null, r.existing_patient ? `既存の患者「${body.name}」に、${r.case_no}件目の事故として追加しました` : '');
    } catch (e) { fail(e); }
  };
}

const DAY_MAX = { d10: 10, d15: 15, d20: 20, dend: 31, parts: 99 };
function sheetHtml(sh) {
  const showCum = sh.items.some((i) => i.key === 'dend');
  const head = `<th>ID</th><th>氏名</th><th>生年月日</th><th>事故日</th><th>初診日</th>
    ${sh.items.map((i) => `<th class="${i.type === 'check' ? 'chk' : 'num'}">${esc(i.label)}</th>`).join('')}${showCum ? '<th class="num">累計通院日数</th>' : ''}`;
  const row = (r, existing) => {
    const ended = r.state === 'ended';
    const ro = ended || sh.locked; // 終了済み・ロック中は入力不可
    const date = (field, v) => ro ? `<td>${esc(v)}</td>` : `<td><input type="date" data-case="${r.case_id}" data-field="${field}" value="${esc(v)}"></td>`;
    const cell = (i) => {
      const v = r.vals[i.id], at = `data-rec="${r.record_id}" data-item="${i.id}"`;
      if (i.type === 'check') return `<td class="chk"><input type="checkbox" ${at} ${v ? 'checked' : ''} ${ro ? 'disabled' : ''} aria-label="${esc(i.label)}"></td>`;
      return ro ? `<td class="num">${yen(v)}</td>` : `<td class="num"><input type="number" min="0" step="1" ${DAY_MAX[i.key] ? `max="${DAY_MAX[i.key]}"` : ''} ${at} value="${v}"></td>`;
    };
    return `<tr class="${ended ? 'ended' : ''}"><td>${esc(r.code)}</td><td>${esc(r.name)}${r.multi ? ` <span class="tag ended">事故${r.case_no}件目</span>` : ''}</td><td>${esc(r.birth)}</td>
      ${date('accident_date', r.accident_date)}${date('first_visit', r.first_visit)}
      ${sh.items.map(cell).join('')}
      ${showCum ? `<td class="calc">${r.cumulative}</td>` : ''}
      ${existing ? `<td><span class="tag ${r.state}">${{ pending: '未確認', confirmed: '継続', ended: '終了' }[r.state]}</span></td>
        <td>${sh.locked ? '' : ended ? `<button class="ghost" data-rec="${r.record_id}" data-state="pending">終了を取消</button>`
          : `${r.state === 'pending' ? `<button class="btn" data-rec="${r.record_id}" data-state="confirmed">継続</button> ` : ''}<button class="ghost danger" data-rec="${r.record_id}" data-state="ended">終了</button>`}</td>` : ''}
    </tr>`;
  };
  // 合計行: 数値項目は合計、チェック項目は件数
  const sumRow = (label, t, extraCols) => `<tr class="sum"><td colspan="5">${label}</td>
    ${sh.items.map((i) => `<td class="${i.type === 'check' ? 'chk' : 'num'}">${i.type === 'check' ? `${t.vals[i.id]}件` : yen(t.vals[i.id])}</td>`).join('')}${showCum ? `<td class="num">${t.cumulative}</td>` : ''}${extraCols}</tr>`;
  const pendingCount = sh.existing.filter((r) => r.state === 'pending').length;
  const lockBar = sh.locked
    ? `<div class="note">この月は編集ロック中です（月が終わって2か月経過）。${S.me.role === 'admin' ? `<button class="ghost" data-lock="0">ロックを解除</button>` : '修正が必要な場合は運営にご連絡ください。'}</div>`
    : (S.me.role === 'admin' && sh.past ? `<div class="note">この月は運営によりロック解除中です。<button class="ghost" data-lock="1">再ロック</button></div>` : '');
  return `${lockBar}
    <section class="card"><h2>新規案件（今月から通院）</h2><p class="sub">${esc(sh.clinic.name)} ／ ${esc(sh.ym)}</p>
      ${sh.new.length ? `<table><thead><tr>${head}</tr></thead><tbody>${sh.new.map((r) => row(r, false)).join('')}${sumRow('小計', sh.totals.new, '')}</tbody></table>` : '<div class="empty">新規の案件はありません</div>'}
      ${sh.locked ? '' : `<form id="add" class="inline-form">
        <input name="name" placeholder="氏名" aria-label="氏名" required maxlength="50">
        <label class="f">生年月日<input name="birth" type="date" required></label>
        <label class="f">事故日<input name="accident_date" type="date" required></label>
        <label class="f">初診日<input name="first_visit" type="date" required></label>
        <button class="btn">案件を追加</button></form>
      <p class="sub">同じ氏名・生年月日の患者がいる場合は同一人物として、その人の新しい事故として追加されます。</p>`}
    </section>
    <section class="card"><h2>既存案件（先月以前から継続）</h2>
      <p class="sub">通院日数・請求金額・請求部位数は毎月0から入力します（累計通院日数は自動集計）。弁護士紹介済みは前月の状態を引き継ぎます。通院を続けている案件は「継続」、通院をやめた案件は「終了」を押してください。</p>
      ${pendingCount ? `<div class="note">未確認の案件が ${pendingCount} 名います</div>` : ''}
      ${sh.existing.length ? `<table><thead><tr>${head}<th>状態</th><th></th></tr></thead><tbody>${sh.existing.map((r) => row(r, true)).join('')}${sumRow('小計（終了を除く）', sh.totals.existing, '<td></td><td></td>')}</tbody></table>` : '<div class="empty">既存の案件はありません</div>'}
    </section>
    <section class="card"><h2>院合計</h2><table><thead><tr><th colspan="5"></th>${sh.items.map((i) => `<th class="${i.type === 'check' ? 'chk' : 'num'}">${esc(i.label)}</th>`).join('')}${showCum ? '<th class="num">累計通院日数</th>' : ''}</tr></thead>
      <tbody>${sumRow('新規 + 既存（終了を除く）', sh.totals.all, '')}</tbody></table></section>`;
}

// ---------------- 管理 ----------------
function renderManage() {
  const m = S.manage;
  const main = document.getElementById('main');
  const isAdmin = S.me.role === 'admin';
  const coName = (id) => esc(m.companies.find((c) => c.id === id)?.name ?? '-');
  const clName = (id) => esc(m.clinics.find((c) => c.id === id)?.name ?? '-');
  const companyOpts = m.companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  main.innerHTML = `
    <div class="err" id="err"></div>
    ${isAdmin ? `<section class="card"><h2>マスター項目</h2><p class="sub">名称を変更すると全社に反映されます。会社ごとの使用可否はチェックで設定します。</p>
      <table><thead><tr><th>項目</th>${m.companies.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>
      ${m.items.map((i) => `<tr><td><input data-item-label="${i.id}" value="${esc(i.label)}"> <span class="tag ended">${i.type === 'check' ? 'チェック' : '数値'}</span></td>
        ${m.companies.map((c) => `<td><input type="checkbox" data-ci="${c.id}:${i.id}" ${m.company_items.some((x) => x.company_id === c.id && x.item_id === i.id) ? 'checked' : ''}></td>`).join('')}</tr>`).join('')}
      </tbody></table>
      <form class="inline-form" id="f-item"><input name="label" placeholder="新しい項目名" required><select name="type"><option value="number">数値</option><option value="check">チェック</option></select><button class="btn">項目を追加</button></form></section>` : ''}
    <div class="grid">
      ${isAdmin ? `<section class="card"><h2>会社</h2><table><tbody>${m.companies.map((c) => `<tr><td>${esc(c.name)}</td></tr>`).join('')}</tbody></table>
        <form class="inline-form" id="f-company"><input name="name" placeholder="会社名" required><button class="btn">会社を追加</button></form></section>` : ''}
      <section class="card"><h2>院</h2><p class="sub">院の追加は会社管理者でも行えます。</p>
        <table><tbody>${m.clinics.map((c) => `<tr><td>${coName(c.company_id)}</td><td>${esc(c.name)}</td><td>${esc(c.manager)}</td></tr>`).join('')}</tbody></table>
        <form class="inline-form" id="f-clinic">${isAdmin ? `<select name="company_id">${companyOpts}</select>` : ''}
          <input name="name" placeholder="院名" required><input name="manager" placeholder="担当者"><button class="btn">院を追加</button></form></section>
    </div>
    <section class="card"><h2>アカウント（Googleアカウント）</h2><p class="sub">ここに登録したGoogleアカウントだけがログインでき、権限に応じた範囲のみ閲覧・編集できます。</p>
      <table><thead><tr><th>メール</th><th>名前</th><th>権限</th><th>会社</th><th>院</th></tr></thead><tbody>
      ${m.users.map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.name)}</td><td>${ROLE[u.role]}</td><td>${u.company_id ? coName(u.company_id) : '-'}</td><td>${u.clinic_id ? clName(u.clinic_id) : '-'}</td></tr>`).join('')}</tbody></table>
      <form class="inline-form" id="f-user"><input name="email" type="email" placeholder="メールアドレス" required><input name="name" placeholder="名前">
        <select name="role">${isAdmin ? '<option value="admin">運営（自社）</option>' : ''}<option value="company_admin">会社管理者</option><option value="clinic_staff" selected>院担当者</option></select>
        ${isAdmin ? `<select name="company_id">${companyOpts}</select>` : ''}
        <select name="clinic_id">${m.clinics.map((c) => `<option value="${c.id}">${coName(c.company_id)} / ${esc(c.name)}</option>`).join('')}</select>
        <button class="btn">アカウントを追加</button></form></section>`;
  const fail = (e) => { document.getElementById('err').textContent = e.message; };
  const reload = async () => { S.manage = await api('GET', '/api/manage'); S.clinics = await api('GET', '/api/clinics'); renderManage(); };
  const submit = (id, url, build) => { const f = document.getElementById(id); if (f) f.onsubmit = async (ev) => { ev.preventDefault(); try { await api('POST', url, build(Object.fromEntries(new FormData(f)))); await reload(); } catch (e) { fail(e); } }; };
  submit('f-item', '/api/items', (d) => d);
  submit('f-company', '/api/companies', (d) => d);
  submit('f-clinic', '/api/clinics', (d) => d);
  submit('f-user', '/api/users', (d) => d);
  main.querySelectorAll('[data-item-label]').forEach((i) => i.onchange = async () => { try { await api('PUT', `/api/items/${i.dataset.itemLabel}`, { label: i.value }); await reload(); } catch (e) { fail(e); } });
  main.querySelectorAll('[data-ci]').forEach((i) => i.onchange = async () => {
    const [company_id, item_id] = i.dataset.ci.split(':');
    try { await api('PUT', '/api/company-items', { company_id, item_id, enabled: i.checked }); await reload(); } catch (e) { fail(e); }
  });
}

boot();
