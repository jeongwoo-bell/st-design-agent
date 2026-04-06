const { App } = require("@slack/bolt");
const { CONFIG } = require("./config");
const { MESSAGES } = require("./messages");
const { threadBranchMap } = require("./thread-map");
const { processRequest, processPrRequest, handleReaction, pendingTicketSelections, processDoneRequest } = require("./handler");

const app = new App({
  token: CONFIG.slack.botToken,
  appToken: CONFIG.slack.appToken,
  socketMode: true,
  clientOptions: {
    slackApiUrl: "https://slack.com/api/",
  },
  socketModeOptions: {
    pingPongLoggingEnabled: false,
  },
});

// @멘션으로 요청 (채널에서 첫 요청, 또는 스레드에서 멘션)
app.event("app_mention", async ({ event, say }) => {
  if (CONFIG.allowedChannel && event.channel !== CONFIG.allowedChannel) return;

  const message = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const request = message.replace(/^\/수정\s*/, "").trim();

  const threadTs = event.thread_ts || event.ts;

  // /pr 명령 감지
  if (request === "/pr") {
    await processPrRequest(say, threadTs);
    return;
  }

  // /done 명령 감지
  if (request === "/done") {
    await processDoneRequest(say, threadTs, event.channel);
    return;
  }

  if (!request) {
    await say({
      text: `${MESSAGES.GUIDE} 😊`,
      thread_ts: event.ts,
    });
    return;
  }

  await processRequest(request, say, threadTs, event.channel, event.ts, event.user);
});

// 스레드 답글 (멘션 없이) - 봇이 관리하는 스레드에서 자연어로 후속 요청
app.event("message", async ({ event, say }) => {
  if (event.bot_id || event.subtype) return;
  if (CONFIG.allowedChannel && event.channel !== CONFIG.allowedChannel) return;
  if (event.text && event.text.includes("<@")) return;

  if (event.thread_ts && threadBranchMap.has(event.thread_ts)) {
    const text = (event.text || "").trim();

    // /pr 명령 감지
    if (text === "/pr") {
      await processPrRequest(say, event.thread_ts);
      return;
    }

    // /done 명령 감지
    if (text === "/done") {
      await processDoneRequest(say, event.thread_ts, event.channel);
      return;
    }

    const request = text.replace(/^\/수정\s*/, "").trim();
    if (request) {
      await processRequest(request, say, event.thread_ts, event.channel, event.ts, event.user);
    }
  }
});

// 봇 자신의 userId 캐시
let botUserId = null;
async function getBotUserId() {
  if (botUserId) return botUserId;
  try {
    const result = await app.client.auth.test();
    botUserId = result.user_id;
  } catch {}
  return botUserId;
}

// 리액션 이벤트 — 티켓 선택용
app.event("reaction_added", async ({ event, say }) => {
  console.log(`[REACTION] 이벤트 수신: ${event.reaction} by ${event.user} on ${event.item.ts}`);

  // 봇 자신의 리액션은 무시
  const myId = await getBotUserId();
  if (myId && event.user === myId) {
    console.log("[REACTION] 봇 자신의 리액션, 무시");
    return;
  }

  // 대기 중인 티켓 선택 메시지인지 확인
  const hasPending = pendingTicketSelections.has(event.item.ts);
  console.log(`[REACTION] 대기 중 메시지 확인: ${hasPending} (pending keys: ${[...pendingTicketSelections.keys()].join(", ")})`);
  if (!hasPending) return;

  await handleReaction(event, say);
});

module.exports = { app };
