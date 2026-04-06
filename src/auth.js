// ============================================
// Google OAuth 토큰 검증 미들웨어
// ============================================
const { OAuth2Client } = require("google-auth-library");
const { findOrCreateUser } = require("./database");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_DOMAIN = "belltherapeutics.com";

const client = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/**
 * Express 미들웨어 — Authorization: Bearer <id_token> 검증
 * 검증 성공 시 req.user에 유저 정보 세팅
 */
async function authMiddleware(req, res, next) {
  // 인증 미설정 시 패스 (개발 모드)
  if (!GOOGLE_CLIENT_ID || !client) {
    req.user = { id: "dev", email: "dev@belltherapeutics.com", name: "Developer" };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "인증이 필요합니다" });
  }

  const token = authHeader.slice(7);

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    // 도메인 체크
    if (payload.hd !== ALLOWED_DOMAIN) {
      return res.status(403).json({
        error: `${ALLOWED_DOMAIN} 계정만 사용할 수 있습니다`,
      });
    }

    // DB에 유저 생성/업데이트
    const user = findOrCreateUser(payload.email, payload.name, payload.picture);
    req.user = user;
    next();
  } catch (err) {
    console.error("[AUTH] 토큰 검증 실패:", err.message);
    return res.status(401).json({ error: "유효하지 않은 토큰입니다" });
  }
}

module.exports = { authMiddleware };
