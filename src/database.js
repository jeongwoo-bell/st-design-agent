// ============================================
// SQLite 데이터베이스 초기화 + 채팅 저장 모듈
// DB 교체 시 이 파일 내부만 변경하면 됨 (인터페이스 유지)
// ============================================
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "chat.db");

let db;

function getDb() {
  if (!db) {
    const fs = require("fs");
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      picture TEXT,
      settings TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      thread_id TEXT UNIQUE,
      branch_name TEXT,
      title TEXT,
      processing_status TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  `);

  // 마이그레이션: processing_status 컬럼 추가 (기존 DB 호환)
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN processing_status TEXT DEFAULT NULL");
  } catch {}
}

// ============================================
// Users
// ============================================

function findOrCreateUser(email, name, picture) {
  const d = getDb();

  const existing = d.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (existing) {
    // 기존 유저 — 커스텀 프로필이 있으면 유지, 없으면 Google 정보로 채움
    const updatedName = existing.name || name;
    const updatedPicture = existing.picture || picture;
    return { ...existing, name: updatedName, picture: updatedPicture, settings: JSON.parse(existing.settings || "{}") };
  }

  const id = crypto.randomUUID();
  d.prepare("INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)")
    .run(id, email, name || null, picture || null);

  const newUser = d.prepare("SELECT * FROM users WHERE id = ?").get(id);
  return { ...newUser, settings: JSON.parse(newUser.settings || "{}") };
}

function getUser(id) {
  const d = getDb();
  const user = d.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (user) user.settings = JSON.parse(user.settings || "{}");
  return user;
}

function getUserByEmail(email) {
  const d = getDb();
  const user = d.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (user) user.settings = JSON.parse(user.settings || "{}");
  return user;
}

function updateUserSettings(userId, settings) {
  const d = getDb();
  d.prepare("UPDATE users SET settings = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(settings), userId);
}

function updateUserProfile(userId, { name, picture }) {
  const d = getDb();
  const fields = [];
  const values = [];
  if (name !== undefined) { fields.push("name = ?"); values.push(name); }
  if (picture !== undefined) { fields.push("picture = ?"); values.push(picture); }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(userId);
  d.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

// ============================================
// Conversations
// ============================================

function findOrCreateConversation(userId, threadId) {
  const d = getDb();

  if (threadId) {
    const existing = d.prepare("SELECT * FROM conversations WHERE thread_id = ?").get(threadId);
    if (existing) return existing;
  }

  const id = crypto.randomUUID();
  const newThreadId = threadId || crypto.randomUUID();

  d.prepare("INSERT INTO conversations (id, user_id, thread_id) VALUES (?, ?, ?)")
    .run(id, userId, newThreadId);

  return d.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
}

function updateConversation(id, updates) {
  const d = getDb();
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (["branch_name", "title", "thread_id"].includes(key) && value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  d.prepare(`UPDATE conversations SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

function listConversations(userId, limit = 20) {
  const d = getDb();
  return d.prepare(
    "SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
  ).all(userId, limit);
}

function getConversation(id) {
  const d = getDb();
  return d.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
}

/**
 * 처리 상태 업데이트 — progress 단계마다 호출
 * @param {string} id - conversationId
 * @param {object} status - { processing: bool, steps: [], error?: string }
 */
function updateProcessingStatus(id, status) {
  const d = getDb();
  d.prepare("UPDATE conversations SET processing_status = ? WHERE id = ?")
    .run(JSON.stringify(status), id);
}

function getProcessingStatus(id) {
  const d = getDb();
  const row = d.prepare("SELECT processing_status FROM conversations WHERE id = ?").get(id);
  if (!row?.processing_status) return null;
  try { return JSON.parse(row.processing_status); } catch { return null; }
}

function deleteConversation(id, userId) {
  const d = getDb();
  // messages는 ON DELETE CASCADE로 자동 삭제
  d.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, userId);
}

// ============================================
// Messages
// ============================================

function saveMessage({ conversationId, role, content, type, metadata }) {
  const d = getDb();
  const id = crypto.randomUUID();

  d.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, type, metadata) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, conversationId, role, content, type || null, JSON.stringify(metadata || {}));

  return id;
}

function getConversationMessages(conversationId, limit = 500) {
  const d = getDb();
  const rows = d.prepare(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?",
  ).all(conversationId, limit);

  return rows.map((row) => ({
    ...row,
    metadata: JSON.parse(row.metadata || "{}"),
  }));
}

module.exports = {
  getDb,
  findOrCreateUser,
  getUser,
  getUserByEmail,
  updateUserSettings,
  updateUserProfile,
  findOrCreateConversation,
  updateConversation,
  listConversations,
  getConversation,
  updateProcessingStatus,
  getProcessingStatus,
  deleteConversation,
  saveMessage,
  getConversationMessages,
};
