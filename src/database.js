// ============================================
// PostgreSQL 데이터베이스 모듈
// 인터페이스(함수명, 반환값)는 기존 SQLite와 동일 유지
// 모든 함수는 async — 호출 시 await 필요
// ============================================
const { Pool } = require("pg");
const crypto = require("crypto");

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
      max: 10,
    });
    pool.on("error", (err) => console.error("[DB] Pool 에러:", err.message));
  }
  return pool;
}

async function initTables() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      picture TEXT,
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      thread_id TEXT UNIQUE,
      branch_name TEXT,
      title TEXT,
      processing_status JSONB DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  `);
  console.log("[DB] PostgreSQL 테이블 초기화 완료");
}

// 서버 시작 시 호출
initTables().catch((err) => console.error("[DB] 테이블 초기화 실패:", err.message));

// ============================================
// Users
// ============================================

async function findOrCreateUser(email, name, picture) {
  const p = getPool();

  const { rows } = await p.query("SELECT * FROM users WHERE email = $1", [email]);
  if (rows.length > 0) {
    const existing = rows[0];
    return { ...existing, name: existing.name || name, picture: existing.picture || picture, settings: existing.settings || {} };
  }

  const id = crypto.randomUUID();
  await p.query(
    "INSERT INTO users (id, email, name, picture) VALUES ($1, $2, $3, $4)",
    [id, email, name || null, picture || null],
  );

  const { rows: newRows } = await p.query("SELECT * FROM users WHERE id = $1", [id]);
  return { ...newRows[0], settings: newRows[0].settings || {} };
}

async function getUser(id) {
  const p = getPool();
  const { rows } = await p.query("SELECT * FROM users WHERE id = $1", [id]);
  if (rows.length === 0) return null;
  return { ...rows[0], settings: rows[0].settings || {} };
}

async function getUserByEmail(email) {
  const p = getPool();
  const { rows } = await p.query("SELECT * FROM users WHERE email = $1", [email]);
  if (rows.length === 0) return null;
  return { ...rows[0], settings: rows[0].settings || {} };
}

async function updateUserSettings(userId, settings) {
  const p = getPool();
  await p.query(
    "UPDATE users SET settings = $1, updated_at = NOW() WHERE id = $2",
    [JSON.stringify(settings), userId],
  );
}

async function updateUserProfile(userId, { name, picture }) {
  const p = getPool();
  const fields = [];
  const values = [];
  let idx = 1;
  if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
  if (picture !== undefined) { fields.push(`picture = $${idx++}`); values.push(picture); }
  if (fields.length === 0) return;
  fields.push("updated_at = NOW()");
  values.push(userId);
  await p.query(`UPDATE users SET ${fields.join(", ")} WHERE id = $${idx}`, values);
}

// ============================================
// Conversations
// ============================================

async function findOrCreateConversation(userId, threadId) {
  const p = getPool();

  if (threadId) {
    const { rows } = await p.query("SELECT * FROM conversations WHERE thread_id = $1", [threadId]);
    if (rows.length > 0) return rows[0];
  }

  const id = crypto.randomUUID();
  const newThreadId = threadId || crypto.randomUUID();

  await p.query(
    "INSERT INTO conversations (id, user_id, thread_id) VALUES ($1, $2, $3)",
    [id, userId, newThreadId],
  );

  const { rows } = await p.query("SELECT * FROM conversations WHERE id = $1", [id]);
  return rows[0];
}

async function updateConversation(id, updates) {
  const p = getPool();
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (["branch_name", "title", "thread_id"].includes(key) && value !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;

  fields.push("updated_at = NOW()");
  values.push(id);
  await p.query(`UPDATE conversations SET ${fields.join(", ")} WHERE id = $${idx}`, values);
}

async function listConversations(userId, limit = 20) {
  const p = getPool();
  const { rows } = await p.query(
    "SELECT * FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2",
    [userId, limit],
  );
  return rows;
}

async function getConversation(id) {
  const p = getPool();
  const { rows } = await p.query("SELECT * FROM conversations WHERE id = $1", [id]);
  return rows[0] || null;
}

async function updateProcessingStatus(id, status) {
  const p = getPool();
  await p.query(
    "UPDATE conversations SET processing_status = $1 WHERE id = $2",
    [status ? JSON.stringify(status) : null, id],
  );
}

async function getProcessingStatus(id) {
  const p = getPool();
  const { rows } = await p.query("SELECT processing_status FROM conversations WHERE id = $1", [id]);
  if (!rows[0]?.processing_status) return null;
  return typeof rows[0].processing_status === "string"
    ? JSON.parse(rows[0].processing_status)
    : rows[0].processing_status;
}

async function deleteConversation(id, userId) {
  const p = getPool();
  await p.query("DELETE FROM conversations WHERE id = $1 AND user_id = $2", [id, userId]);
}

// ============================================
// Messages
// ============================================

async function saveMessage({ conversationId, role, content, type, metadata }) {
  const p = getPool();
  const id = crypto.randomUUID();

  await p.query(
    "INSERT INTO messages (id, conversation_id, role, content, type, metadata) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, conversationId, role, content, type || null, JSON.stringify(metadata || {})],
  );

  return id;
}

async function getConversationMessages(conversationId, limit = 500) {
  const p = getPool();
  const { rows } = await p.query(
    "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2",
    [conversationId, limit],
  );

  return rows.map((row) => ({
    ...row,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata || {}),
  }));
}

module.exports = {
  getPool,
  initTables,
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
