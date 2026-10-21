// Alerts: send a test message, or find the Telegram chat id to put in .env.
//
//   npm run alert:test                 # one test message to every channel set up
//   npm run alert:test -- --find-chat  # lists the chats that wrote to the bot
//
// Telegram setup (ops/README.md): create a bot with @BotFather, put its token
// in TELEGRAM_BOT_TOKEN, send the bot any message from your phone, run
// --find-chat, put the id in TELEGRAM_CHAT_ID, restart dialforge-backend.
require('dotenv').config();
const { sendAlert, whoAmI } = require('../services/health');

async function findChat(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) throw new Error((data && data.description) || `HTTP ${res.status}`);
  const chats = new Map();
  for (const u of data.result) {
    const chat = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (chat)
      chats.set(chat.id, chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username);
  }
  return [...chats];
}

async function main() {
  const env = process.env;
  if (process.argv.includes('--find-chat')) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error('TELEGRAM_BOT_TOKEN is not set in .env - create a bot with @BotFather first.');
      process.exit(1);
    }
    const chats = await findChat(env.TELEGRAM_BOT_TOKEN);
    if (!chats.length) {
      console.log('No messages yet: open your bot in Telegram, press Start (or send "hi"), then run this again.');
      return;
    }
    for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}    (${name})`);
    console.log('Put the line for your chat into .env, then: sudo systemctl restart dialforge-backend');
    return;
  }
  if (!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) && !env.ALERT_WEBHOOK_URL) {
    console.error('No alert channel set: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or ALERT_WEBHOOK_URL, in .env.');
    process.exit(1);
  }
  const results = await sendAlert(`${whoAmI()}:\nTest alert - if you can read this, alerts reach you.`);
  for (const r of results) console.log(`${r.channel}: ${r.ok ? 'sent' : `FAILED - ${r.error}`}`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
