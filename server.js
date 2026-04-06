// ============================================
// 웹 API 서버 — Express + WebSocket
// ============================================
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const crypto = require("crypto");
const { CONFIG, validateEnv } = require("./src/config");
const { handleRequest, createPullRequest } = require("./src/web-handler");
const { listConversations, getConversationMessages } = require("./src/database");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket 클라이언트 관리 (requestId → ws)
const wsClients = new Map();

wss.on("connection", (ws) => {
  const clientId = crypto.randomUUID();
  ws.clientId = clientId;
  console.log(`[WS] 클라이언트 연결: ${clientId}`);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      // 클라이언트가 requestId를 등록
      if (msg.type === "subscribe" && msg.requestId) {
        wsClients.set(msg.requestId, ws);
      }
    } catch {}
  });

  ws.on("close", () => {
    console.log(`[WS] 클라이언트 해제: ${clientId}`);
    // 해당 클라이언트의 모든 구독 제거
    for (const [reqId, client] of wsClients) {
      if (client === ws) wsClients.delete(reqId);
    }
  });
});

/** WebSocket으로 진행상황 전송 */
function emitToClient(requestId, type, data) {
  const ws = wsClients.get(requestId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, requestId, data }));
  }
}

// ============================================
// REST API 엔드포인트
// ============================================

/** 헬스 체크 */
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /api/request
 * 메시지 처리 요청
 *
 * Body:
 *   message: string (필수)
 *   threadId?: string
 *   figmaUrl?: string
 *   userName?: string
 *   chatHistory?: string[]
 *
 * Response:
 *   requestId: string — WebSocket 구독용
 *   ... 결과 데이터
 */
/** 대화 목록 조회 */
app.get("/api/conversations", (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
  const conversations = listConversations(deviceId);
  res.json({ conversations });
});

/** 대화 메시지 조회 */
app.get("/api/conversations/:id/messages", (req, res) => {
  const messages = getConversationMessages(req.params.id);
  res.json({ messages });
});

/** PR 생성 */
app.post("/api/pr", async (req, res) => {
  const { branchName } = req.body;
  if (!branchName) return res.status(400).json({ error: "branchName is required" });
  try {
    const result = await createPullRequest(branchName);
    res.json(result);
  } catch (err) {
    console.error("[API] PR 생성 실패:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/request", (req, res) => {
  const { message, threadId, figmaUrl, userName, chatHistory, deviceId, images } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  const requestId = crypto.randomUUID();

  // emit 함수: WebSocket으로 실시간 전송
  const emit = (type, data) => {
    emitToClient(requestId, type, data);
    console.log(`[EMIT:${requestId.slice(0, 8)}] ${type}:`, JSON.stringify(data).slice(0, 100));
  };

  // requestId 즉시 반환 — 클라이언트가 WebSocket 구독할 시간 확보
  res.json({ requestId });

  // 작업은 백그라운드로 실행
  handleRequest({ message, threadId, figmaUrl, userName, chatHistory, deviceId, images }, emit)
    .then((result) => {
      emitToClient(requestId, "complete", result);
    })
    .catch((err) => {
      console.error("[API] 요청 처리 실패:", err.message);
      emitToClient(requestId, "error", { error: err.message });
    });
});

// ============================================
// 서버 시작
// ============================================
const PORT = process.env.PORT || 3001;

validateEnv();

if (!CONFIG.docs.url) console.log("⚠️  DOCS_REPO_URL 미설정 — 스펙 문서 연동 비활성화");
if (!CONFIG.figma.apiKey) console.log("⚠️  FIGMA_API_KEY 미설정 — 피그마 비활성화");

server.listen(PORT, () => {
  console.log(`Design Agent API 실행 중 (port ${PORT})`);
});
