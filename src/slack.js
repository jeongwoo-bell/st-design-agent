const { App } = require("@slack/bolt");
const { CONFIG } = require("./config");
const { threadBranchMap } = require("./thread-map");
const { processRequest } = require("./handler");

const app = new App({
  token: CONFIG.slack.botToken,
  appToken: CONFIG.slack.appToken,
  socketMode: true,
});

// @멘션으로 요청 (채널에서 첫 요청, 또는 스레드에서 멘션)
app.event("app_mention", async ({ event, say }) => {
  if (CONFIG.allowedChannel && event.channel !== CONFIG.allowedChannel) return;

  const message = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const request = message.replace(/^\/수정\s*/, "").trim();

  if (!request) {
    await say({
      text: "수정할 내용을 알려주세요! 😊\n예: `@Design Bot Section3 타이틀 크게 해줘`",
      thread_ts: event.ts,
    });
    return;
  }

  const threadTs = event.thread_ts || event.ts;
  await processRequest(request, say, threadTs);
});

// 스레드 답글 (멘션 없이) - 봇이 관리하는 스레드에서 자연어로 후속 요청
app.event("message", async ({ event, say }) => {
  if (event.bot_id || event.subtype) return;
  if (CONFIG.allowedChannel && event.channel !== CONFIG.allowedChannel) return;
  if (event.text && event.text.includes("<@")) return;

  if (event.thread_ts && threadBranchMap.has(event.thread_ts)) {
    const request = (event.text || "").replace(/^\/수정\s*/, "").trim();
    if (request) {
      await processRequest(request, say, event.thread_ts);
    }
  }
});

module.exports = { app };
