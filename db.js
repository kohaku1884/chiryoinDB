// SQLite (node:sqlite) によるデータ層。プロトタイプ用。
// 本番ではここを Firestore 等に差し替える想定（API 層は変えない）。
import { DatabaseSync } from 'node:sqlite';

export function openDb(file = process.env.DB_FILE || 'data.db') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS companies(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS clinics(
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      name TEXT NOT NULL, manager TEXT NOT NULL DEFAULT '');
    -- role: admin(運営=自社) / company_admin(会社管理者) / clinic_staff(院担当者)
    CREATE TABLE IF NOT EXISTS users(
      email TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
      company_id INTEGER REFERENCES companies(id),
      clinic_id INTEGER REFERENCES clinics(id));
    -- マスター項目（月ごとに入力する項目）。
    --   key: 検証・集計に使う固定キー（運営が追加した項目は NULL）
    --   type: number / check
    --   carry: 1 = 翌月に前月の値を引き継ぐ（弁護士紹介済みなど状態を表す項目）
    CREATE TABLE IF NOT EXISTS items(
      id INTEGER PRIMARY KEY, key TEXT UNIQUE, label TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'number', carry INTEGER NOT NULL DEFAULT 0);
    -- 会社ごとに有効な項目（行があれば有効）
    CREATE TABLE IF NOT EXISTS company_items(
      company_id INTEGER NOT NULL REFERENCES companies(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      PRIMARY KEY(company_id, item_id));
    -- 患者（人）。氏名+生年月日で会社内一意。seq は会社内連番で、表示IDは会社IDに紐付く
    CREATE TABLE IF NOT EXISTS patients(
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      seq INTEGER NOT NULL, name TEXT NOT NULL, birth TEXT NOT NULL,
      UNIQUE(company_id, seq), UNIQUE(company_id, name, birth));
    -- 事故案件。同一人物が複数の事故に遭った場合は、事故ごとに1行（case_no=1,2,...）
    CREATE TABLE IF NOT EXISTS cases(
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      clinic_id INTEGER NOT NULL REFERENCES clinics(id), case_no INTEGER NOT NULL,
      accident_date TEXT NOT NULL, first_visit TEXT NOT NULL,
      first_month TEXT NOT NULL, ended_month TEXT,
      UNIQUE(patient_id, case_no), UNIQUE(patient_id, accident_date));
    -- 月次記録（事故案件 × 月）。vals は {項目ID: 値}。state: pending / confirmed / ended
    CREATE TABLE IF NOT EXISTS records(
      id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES cases(id),
      ym TEXT NOT NULL, vals TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(case_id, ym));
    -- 運営が解除した過去月（行があればロックされない）
    CREATE TABLE IF NOT EXISTS month_unlocks(
      clinic_id INTEGER NOT NULL REFERENCES clinics(id), ym TEXT NOT NULL,
      PRIMARY KEY(clinic_id, ym));
  `);
  return db;
}

// 交通事故コンサル用のマスター項目（氏名・初診日・事故日は案件の基本情報として別管理）
export const DEFAULT_ITEMS = [
  { key: 'd10', label: '通院日数（10日時点）', type: 'number', carry: 0 },
  { key: 'd15', label: '通院日数（15日時点）', type: 'number', carry: 0 },
  { key: 'd20', label: '通院日数（20日時点）', type: 'number', carry: 0 },
  { key: 'dend', label: '通院日数（末日）', type: 'number', carry: 0 },
  { key: 'amount', label: '請求金額', type: 'number', carry: 0 },
  { key: 'parts', label: '請求部位数', type: 'number', carry: 0 },
  { key: 'lawyer', label: '弁護士紹介済み', type: 'check', carry: 1 },
];

export function seed(db) {
  if (db.prepare('SELECT COUNT(*) c FROM companies').get().c > 0) return;
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  ins("INSERT INTO companies(id,name) VALUES (1,'A社'),(2,'B社')");
  ins(`INSERT INTO clinics(id,company_id,name,manager) VALUES
       (1,1,'A院','山田'),(2,1,'A2院','佐藤'),(3,2,'B院','鈴木')`);
  for (const it of DEFAULT_ITEMS) ins('INSERT INTO items(key,label,type,carry) VALUES (?,?,?,?)', it.key, it.label, it.type, it.carry);
  ins('INSERT INTO company_items SELECT c.id, i.id FROM companies c, items i'); // 初期は全社で全項目を使用
  ins(`INSERT INTO users(email,name,role,company_id,clinic_id) VALUES
    ('admin@example.com','運営 管理者','admin',NULL,NULL),
    ('a-admin@example.com','A社 管理者','company_admin',1,NULL),
    ('a1@example.com','A院 担当','clinic_staff',1,1),
    ('a2@example.com','A2院 担当','clinic_staff',1,2),
    ('b-admin@example.com','B社 管理者','company_admin',2,NULL),
    ('b1@example.com','B院 担当','clinic_staff',2,3)`);
}
