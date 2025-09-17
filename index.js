// === TELEGRAM ONLY SERVER (Render Web Service compatible) ===
import dotenv from "dotenv";
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import FormData from "form-data";
import express from "express";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegStatic);

// === ENV ===
const OPENAI_KEY = process.env.OPENAI_KEY;
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const ELEVEN_URL = process.env.ELEVEN_PROXY_URL || "https://elevenlabs-proxy.onrender.com";
const PORT       = process.env.PORT || 3000;

if (!TG_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN отсутствует");
  process.exit(1);
}
if (!OPENAI_KEY) {
  console.error("❌ OPENAI_KEY отсутствует");
  process.exit(1);
}

// === минимальный веб-сервер, чтобы Render не ругался ===
const app = express();
app.get("/", (_, res) => res.send("Anna TG bot is running"));
app.listen(PORT, () => console.log("🌐 Keepalive on", PORT));

const SYSTEM_PROMPT_TG = `
Ты — "Анна", менеджер по продажам и консультант наших продуктов. Общение в Telegram.

Стиль: коротко (1–4 предложения), по-человечески, без эмодзи. Разрешены теги: [openLeadForm], [voice], [quiz], [showOptions].

Правила голоса:
- Первое приветствие всегда содержит [voice].
- [voice] ставь, когда лучше сказать голосом: приветствие, короткие подтверждения, сочувствие, живое объяснение.
- Для списков, цен и длинных инструкций используй текст без [voice].
- Если [voice] есть, бот озвучивает текст сам.
`;

// === память диалогов ===
if (!global.dialogs) global.dialogs = {};

// === STT (Whisper) ===
async function transcribeVoice(fileId, bot) {
  try {
    const link = await bot.getFileLink(fileId);
    const audioRes = await fetch(link);
    const audioBuf = Buffer.from(await audioRes.arrayBuffer());
    const tmpPath = path.join("/tmp", `${fileId}.oga`);
    fs.writeFileSync(tmpPath, audioBuf);

    const fd = new FormData();
    fd.append("file", fs.createReadStream(tmpPath));
    fd.append("model", "whisper-1");

    const sttRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: fd
    });

    const data = await sttRes.json();
    fs.unlinkSync(tmpPath);
    return data.text || "";
  } catch (e) {
    console.error("⚠️ STT error:", e.message);
    return "";
  }
}

// === GPT ===
async function askGPT(history) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT_TG }, ...history];
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages,
      temperature: 0.7,
      max_tokens: 200
    })
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "Ошибка GPT.";
}

// === TTS через твой ElevenLabs-прокси (/tg-voice -> mp3) ===
async function speakToOgg(chatId, text, bot) {
  const clean = text.replace(/\[voice\]/gi, "").trim();
  if (!clean) return;
  const tts = await fetch(`${ELEVEN_URL}/tg-voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: clean, emotion: "neutral" })
  });
  if (!tts.ok) throw new Error(`TTS ${tts.status}`);
  const mp3 = Buffer.from(await tts.arrayBuffer());

  const tmpIn  = path.join("/tmp", `${Date.now()}.mp3`);
  const tmpOut = path.join("/tmp", `${Date.now()}.ogg`);
  fs.writeFileSync(tmpIn, mp3);

  await new Promise((resolve, reject) => {
    ffmpeg(tmpIn)
      .audioCodec("libopus")
      .audioFrequency(48000)
      .audioBitrate("64k")
      .audioChannels(1)
      .format("ogg")
      .outputOptions(["-vn", "-application", "voip"])
      .save(tmpOut)
      .on("end", resolve)
      .on("error", reject);
  });

  await bot.sendVoice(chatId, fs.createReadStream(tmpOut), {}, { filename: "voice.ogg", contentType: "audio/ogg" });
  fs.unlinkSync(tmpIn);
  fs.unlinkSync(tmpOut);
}

// === Telegram Bot (polling) ===
const bot = new TelegramBot(TG_TOKEN, { polling: true });
console.log("✅ Telegram бот Анна запущен (polling)");

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  let userText = msg.text?.trim() || "";

  // голосовые
  if (msg.voice) {
    userText = await transcribeVoice(msg.voice.file_id, bot);
    if (!userText) {
      await bot.sendMessage(chatId, "Не получилось распознать голос. Напиши текстом.");
      return;
    }
  }
  if (!userText) return;

  // промокод просто как текст-ответ
  if (/ANNA50/i.test(userText)) {
    await bot.sendMessage(chatId, "Промокод активирован: −50% на подключение, абонентка без изменений. Передала в отдел продаж.");
    return;
  }

  if (!global.dialogs[chatId]) global.dialogs[chatId] = [];
  global.dialogs[chatId].push({ role: "user", content: userText });

  try {
    const reply = await askGPT(global.dialogs[chatId]);
    global.dialogs[chatId].push({ role: "assistant", content: reply });

    // если есть текст — отправляем
    const plain = reply.replace(/\[voice\]/gi, "").trim();
    if (plain) await bot.sendMessage(chatId, plain);

    // если запросили голос
    if (/\[voice\]/i.test(reply)) {
      try { await speakToOgg(chatId, reply, bot); }
      catch (e) { console.warn("⚠️ TTS error:", e.message); }
    }
  } catch (e) {
    console.error("❌ TG error:", e.message);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуй ещё раз.");
  }
});

// полезно видеть 409 (конфликт polling из двух инстансов)
bot.on("polling_error", (err) => {
  console.error("⚠️ polling_error:", err?.response?.body || err.message);
});
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));
