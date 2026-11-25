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
    -- マスター項目（項目1, 項目2 ...）
    CREATE TABLE IF NOT EXISTS items(
      id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    -- 会社ごとに有効な項目（行があれば有効）
    CREATE TABLE IF NOT EXISTS company_items(
      company_id INTEGER NOT NULL REFERENCES companies(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      PRIMARY KEY(company_id, item_id));
    -- 患者。seq は会社内連番。表示ID(code)は会社IDに紐付く => 他社と混ざらない
    CREATE TABLE IF NOT EXISTS patients(
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      clinic_id INTEGER NOT NULL REFERENCES clinics(id), seq INTEGER NOT NULL,
      name TEXT NOT NULL, birth TEXT NOT NULL DEFAULT '',
      first_month TEXT NOT NULL, ended_month TEXT,
      UNIQUE(company_id, seq));
    -- 月次レコード。state: pending(未確認) / confirmed(継続確認済) / ended(終了)
    CREATE TABLE IF NOT EXISTS records(
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id),
      ym TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 0,
      vals TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(patient_id, ym));
    -- 運営が解除した過去月（行があればロックされない）
    CREATE TABLE IF NOT EXISTS month_unlocks(
      clinic_id INTEGER NOT NULL REFERENCES clinics(id), ym TEXT NOT NULL,
      PRIMARY KEY(clinic_id, ym));
  `);
  return db;
}

export function seed(db) {
  if (db.prepare('SELECT COUNT(*) c FROM companies').get().c > 0) return;
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  ins("INSERT INTO companies(id,name) VALUES (1,'A社'),(2,'B社')");
  ins(`INSERT INTO clinics(id,company_id,name,manager) VALUES
       (1,1,'A院','山田'),(2,1,'A2院','佐藤'),(3,2,'B院','鈴木')`);
  for (let i = 1; i <= 5; i++) ins('INSERT INTO items(id,label) VALUES (?,?)', i, `項目${i}`);
  // 手書きメモの例: A社=項目1,2 / B社=項目1,3
  ins('INSERT INTO company_items VALUES (1,1),(1,2),(2,1),(2,3)');
  ins(`INSERT INTO users(email,name,role,company_id,clinic_id) VALUES
    ('admin@example.com','運営 管理者','admin',NULL,NULL),
    ('a-admin@example.com','A社 管理者','company_admin',1,NULL),
    ('a1@example.com','A院 担当','clinic_staff',1,1),
    ('a2@example.com','A2院 担当','clinic_staff',1,2),
    ('b-admin@example.com','B社 管理者','company_admin',2,NULL),
    ('b1@example.com','B院 担当','clinic_staff',2,3)`);
}
