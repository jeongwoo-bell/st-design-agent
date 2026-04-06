// ============================================
// Claude API SDK 래퍼 (v5 — CLI spawn 제거)
// ============================================
const Anthropic = require("@anthropic-ai/sdk");
const { CONFIG } = require("./config");

const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });

/**
 * Haiku 호출 — 빠르고 저렴한 작업 (파일 분류, 브랜치명 생성 등)
 */
async function callHaiku(systemPrompt, userMessage) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content[0].text;
}

/**
 * Haiku 스트리밍 호출 — talk/ask 응답용
 * @param {function} onChunk - (textDelta: string) => void
 * @returns {string} 전체 응답 텍스트
 */
async function callHaikuStream(systemPrompt, userMessage, onChunk) {
  const stream = client.messages.stream({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  let fullText = "";
  stream.on("text", (text) => {
    fullText += text;
    if (onChunk) onChunk(text);
  });

  await stream.finalMessage();
  return fullText;
}

/**
 * Sonnet 호출 — 코드 수정용 (tool use 포함, 멀티턴 지원)
 * messages 배열을 직접 받아서 대화 이어가기 가능
 */
async function callSonnet(systemPrompt, messages, tools) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    system: systemPrompt,
    messages,
    tools,
  });
  return response;
}

module.exports = { client, callHaiku, callHaikuStream, callSonnet };
