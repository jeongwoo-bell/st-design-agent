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
const { listConversations, getConversationMessages, getUser, updateUserSettings } = require("./src/database");
const { authMiddleware } = require("./src/auth");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// ============================================
// 요청 로깅 미들웨어
// ============================================
app.use((req, res, next) => {
  const start = Date.now();
  const method = req.method;
  const url = req.originalUrl;

  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const user = req.user?.email || "anonymous";
    const color = status >= 400 ? "\x1b[31m" : status >= 300 ? "\x1b[33m" : "\x1b[32m";
    console.log(`${color}[API]\x1b[0m ${method} ${url} → ${status} (${duration}ms) [${user}]`);
  });

  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket 클라이언트 관리 (requestId → ws)
const wsClients = new Map();

// 진행 중인 요청 추적 (threadId → { processing, steps[], result })
const activeRequests = new Map();

wss.on("connection", (ws) => {
  const clientId = crypto.randomUUID().slice(0, 8);
  ws.clientId = clientId;
  console.log(`\x1b[36m[WS]\x1b[0m 연결: ${clientId} (현재 ${wsClients.size + 1}개)`);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "subscribe" && msg.requestId) {
        wsClients.set(msg.requestId, ws);
        console.log(`\x1b[36m[WS]\x1b[0m subscribe: ${msg.requestId.slice(0, 8)} ← client:${clientId}`);
      }
    } catch {}
  });

  ws.on("close", () => {
    let cleaned = 0;
    for (const [reqId, client] of wsClients) {
      if (client === ws) { wsClients.delete(reqId); cleaned++; }
    }
    console.log(`\x1b[36m[WS]\x1b[0m 해제: ${clientId} (구독 ${cleaned}개 정리, 남은 ${wsClients.size}개)`);
  });
});

function emitToClient(requestId, type, data, retries = 0) {
  const ws = wsClients.get(requestId);
  const reqShort = requestId.slice(0, 8);

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, requestId, data }));
    // complete/error는 중요 이벤트라 강조 로그
    if (type === "complete" || type === "error") {
      const color = type === "error" ? "\x1b[31m" : "\x1b[32m";
      console.log(`${color}[EMIT:${reqShort}]\x1b[0m ${type}: ${JSON.stringify(data).slice(0, 150)}`);
    } else {
      console.log(`\x1b[90m[EMIT:${reqShort}]\x1b[0m ${type}: ${JSON.stringify(data).slice(0, 100)}`);
    }
  } else if (retries < 10) {
    if (retries === 0) console.log(`\x1b[33m[EMIT:${reqShort}]\x1b[0m 클라이언트 대기 중... (${type})`);
    setTimeout(() => emitToClient(requestId, type, data, retries + 1), 100);
  } else {
    console.log(`\x1b[31m[EMIT:${reqShort}]\x1b[0m 전달 실패 (클라이언트 없음): ${type}`);
  }
}

// ============================================
// REST API 엔드포인트
// ============================================

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/me", authMiddleware, (req, res) => {
  console.log(`\x1b[90m[USER]\x1b[0m 프로필 조회: ${req.user.email}`);
  res.json({ user: req.user });
});

app.put("/api/me/profile", authMiddleware, async (req, res) => {
  const { name, picture } = req.body;
  const { updateUserProfile } = require("./src/database");
  await updateUserProfile(req.user.id, { name, picture });
  console.log(`\x1b[34m[USER]\x1b[0m 프로필 업데이트: ${req.user.email} → name=${name ? '변경' : '유지'}, picture=${picture ? '변경' : '유지'}`);
  res.json({ ok: true });
});

app.put("/api/me/settings", authMiddleware, async (req, res) => {
  const { settings } = req.body;
  if (!settings) return res.status(400).json({ error: "settings is required" });
  await updateUserSettings(req.user.id, settings);
  console.log(`\x1b[34m[USER]\x1b[0m 설정 업데이트: ${req.user.email} → ${JSON.stringify(settings)}`);
  res.json({ ok: true });
});

app.get("/api/conversations", authMiddleware, async (req, res) => {
  const conversations = await listConversations(req.user.id);
  console.log(`\x1b[90m[CONV]\x1b[0m 목록 조회: ${req.user.email} → ${conversations.length}개`);
  res.json({ conversations });
});

app.get("/api/conversations/:id/messages", authMiddleware, async (req, res) => {
  const messages = await getConversationMessages(req.params.id);
  console.log(`\x1b[90m[CONV]\x1b[0m 메시지 조회: ${req.params.id.slice(0, 8)} → ${messages.length}개`);
  res.json({ messages });
});

/** 대화 처리 상태 조회 — DB에서 직접 읽음 */
app.get("/api/conversations/:id/status", authMiddleware, async (req, res) => {
  const { getProcessingStatus } = require("./src/database");
  const status = await getProcessingStatus(req.params.id);
  if (!status) {
    res.json({ processing: false });
  } else {
    res.json(status);
  }
});

app.delete("/api/conversations/:id", authMiddleware, async (req, res) => {
  const { deleteConversation } = require("./src/database");
  await deleteConversation(req.params.id, req.user.id);
  console.log(`\x1b[31m[CONV]\x1b[0m 대화 삭제: ${req.params.id.slice(0, 8)} by ${req.user.email}`);
  res.json({ ok: true });
});

app.post("/api/pr", authMiddleware, async (req, res) => {
  const { branchName } = req.body;
  if (!branchName) return res.status(400).json({ error: "branchName is required" });
  console.log(`\x1b[35m[PR]\x1b[0m 생성 요청: ${branchName} by ${req.user.email}`);
  try {
    const result = await createPullRequest(branchName);
    console.log(`\x1b[32m[PR]\x1b[0m 생성 완료: ${result.prUrl || 'URL 없음'}`);
    res.json(result);
  } catch (err) {
    console.error(`\x1b[31m[PR]\x1b[0m 생성 실패:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 피드백/리포트 이메일 발송
// ============================================
app.post("/api/report", authMiddleware, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: "title and content are required" });

  const from = req.user.email;
  console.log(`\x1b[35m[REPORT]\x1b[0m 피드백 접수: "${title}" from ${from}`);

  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"Sleep Agent 피드백" <${process.env.GMAIL_USER}>`,
      to: "jeongwoo.lee@belltherapeutics.com",
      replyTo: from,
      subject: `[Sleep Agent 피드백] ${title}`,
      text: `보낸 사람: ${req.user.name} (${from})\n\n${content}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px;">
          <h2 style="color: #4F46E5;">[Sleep Agent 피드백]</h2>
          <p><strong>제목:</strong> ${title}</p>
          <p><strong>보낸 사람:</strong> ${req.user.name} (${from})</p>
          <hr style="border: 1px solid #eee;" />
          <div style="white-space: pre-wrap;">${content}</div>
        </div>
      `,
    });

    console.log(`\x1b[32m[REPORT]\x1b[0m 이메일 발송 완료 → jeongwoo.lee@belltherapeutics.com`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`\x1b[31m[REPORT]\x1b[0m 이메일 발송 실패:`, err.message);
    res.status(500).json({ error: "이메일 발송에 실패했어요. 다시 시도해주세요." });
  }
});

app.post("/api/request", authMiddleware, (req, res) => {
  const { message, threadId, figmaUrl, chatHistory, images } = req.body;

  if (!message && (!images || images.length === 0)) {
    return res.status(400).json({ error: "message or images required" });
  }

  const requestId = crypto.randomUUID();
  const reqShort = requestId.slice(0, 8);

  console.log(`\x1b[35m[REQ:${reqShort}]\x1b[0m 새 요청 — user:${req.user.email} msg:"${(message || '').slice(0, 60)}" thread:${threadId?.slice(0, 8) || 'new'} images:${images?.length || 0} figma:${!!figmaUrl}`);

  const trackingId = threadId || requestId;
  const trackingState = { processing: true, requestId, steps: [], startedAt: new Date().toISOString() };
  activeRequests.set(trackingId, trackingState);

  const emit = (type, data) => {
    emitToClient(requestId, type, data);
    // progress/status 단계를 추적 상태에도 저장
    if ((type === "progress" || type === "status") && data?.step) {
      const existing = trackingState.steps.find((s) => s.step === data.step);
      if (existing) {
        Object.assign(existing, data);
      } else {
        trackingState.steps.push({ ...data });
      }
    }
  };

  res.json({ requestId });

  const startTime = Date.now();

  handleRequest({
    message,
    threadId,
    figmaUrl,
    userName: req.user.name,
    chatHistory,
    userId: req.user.id,
    images,
  }, emit)
    .then((result) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\x1b[32m[REQ:${reqShort}]\x1b[0m 완료 (${duration}s) — type:${result.type} thread:${result.threadId?.slice(0, 8) || '?'}`);

      // 처리 완료 — 결과 저장 (5분 후 정리)
      activeRequests.set(trackingId, { processing: false, result, completedAt: new Date().toISOString() });
      if (result.threadId) activeRequests.set(result.threadId, { processing: false, result, completedAt: new Date().toISOString() });
      setTimeout(() => { activeRequests.delete(trackingId); activeRequests.delete(result.threadId); }, 300000);

      emitToClient(requestId, "complete", result);
    })
    .catch(async (err) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`\x1b[31m[REQ:${reqShort}]\x1b[0m 실패 (${duration}s):`, err.message);
      console.error(err.stack);

      // 에러를 유저 친화적으로 변환
      let userMessage;
      try {
        const { callHaiku } = require("./src/claude");
        userMessage = await callHaiku(
          `너는 에러 메시지 번역기야. 아래 서버 에러를 비개발자가 이해할 수 있게 1문장으로 요약해.
"처리 중 문제가 발생했어요." 로 시작해. 해결 방향도 간단히 제시해.`,
          err.message.slice(0, 500),
        );
      } catch {
        userMessage = "처리 중 문제가 발생했어요. 다시 시도해주세요.";
      }

      // 에러도 추적
      activeRequests.set(trackingId, { processing: false, error: userMessage, completedAt: new Date().toISOString() });
      setTimeout(() => activeRequests.delete(trackingId), 300000);

      emitToClient(requestId, "error", {
        error: userMessage,
        rawError: err.message,
        canRetry: true,
      });
    });
});

// ============================================
// 서버 시작
// ============================================
const PORT = process.env.PORT || 3001;

validateEnv();

console.log("");
console.log("╔══════════════════════════════════════╗");
console.log("║     Design Agent API Server          ║");
console.log("╚══════════════════════════════════════╝");
console.log("");
if (!process.env.GOOGLE_CLIENT_ID) console.log("⚠️  GOOGLE_CLIENT_ID 미설정 — 인증 비활성화 (개발 모드)");
if (!CONFIG.docs.url) console.log("⚠️  DOCS_REPO_URL 미설정 — 스펙 문서 연동 비활성화");
if (!CONFIG.figma.apiKey) console.log("⚠️  FIGMA_API_KEY 미설정 — 피그마 비활성화");

server.listen(PORT, () => {
  console.log(`✅ 서버 실행 중 → http://localhost:${PORT}`);
  console.log("");
});
