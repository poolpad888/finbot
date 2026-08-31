// FinBot — Telegram-бот учёта трат и доходов + дешборд
// Запуск: node server.js
// Обязательные переменные окружения:
//   DATABASE_URL       — строка подключения Postgres
//   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
//   ANTHROPIC_API_KEY  — ключ Anthropic API (для разбора сообщений)
//   DASHBOARD_KEY      — секрет для доступа к дешборду (придумайте любой)
// Необязательные:
//   ALLOWED_USER_IDS   — id пользователей Telegram через запятую (иначе бот отвечает всем)
//   RENDER_EXTERNAL_URL — Render задаёт сам; используется для установки вебхука

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const {
  DATABASE_URL,
  TELEGRAM_BOT_TOKEN,
  ANTHROPIC_API_KEY,
  DASHBOARD_KEY,
  ALLOWED_USER_IDS,
  RENDER_EXTERNAL_URL,
  PORT = 3000,
} = process.env;

if (!DATABASE_URL || !TELEGRAM_BOT_TOKEN || !ANTHROPIC_API_KEY || !DASHBOARD_KEY) {
  console.error("Не заданы обязательные переменные окружения (DATABASE_URL, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, DASHBOARD_KEY)");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

// Секрет пути вебхука — детерминированно из токена, чтобы не хранить отдельно
const WEBHOOK_SECRET = crypto.createHash("sha256").update(TELEGRAM_BOT_TOKEN).digest("hex").slice(0, 32);

const allowedUsers = (ALLOWED_USER_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean).map(Number);

const app = express();
app.use(express.json());

// ---------- База ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('expense','income')),
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      description TEXT,
      occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions (occurred_on);
  `);
}

// ---------- Telegram ----------
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function tg(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

const send = (chatId, text) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });

// ---------- Разбор сообщения через Claude ----------
const EXPENSE_CATS = ["продукты","кафе и рестораны","транспорт","жильё","связь и интернет","здоровье","одежда","развлечения","подарки","путешествия","образование","прочее"];
const INCOME_CATS = ["зарплата","фриланс","подарки","возврат","прочее"];

const PARSER_SYSTEM = `Ты — парсер финансовых записей. Пользователь пишет о своих тратах или доходах в свободной форме по-русски.
Верни ТОЛЬКО валидный JSON-массив без пояснений и без markdown. Каждый элемент:
{"type":"expense"|"income","amount":число,"category":строка,"description":краткое описание,"date":"YYYY-MM-DD"|null}
Правила:
- Расходы по умолчанию. Доход — если явно сказано (+, "получил", "зарплата", "заработал" и т.п.).
- Категории расходов строго из списка: ${EXPENSE_CATS.join(", ")}.
- Категории доходов строго из списка: ${INCOME_CATS.join(", ")}.
- Если в сообщении несколько операций — верни несколько элементов.
- "date" укажи только если названа явная дата ("вчера", "25 августа"), иначе null. Сегодня: {TODAY}.
- Суммы вроде "1.5к"/"1,5 тыс" = 1500. Валюта — рубли, знак валюты игнорируй.
- Если сообщение вообще не про деньги, верни [].`;

async function parseMessage(text) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: PARSER_SYSTEM.replace("{TODAY}", today),
      messages: [{ role: "user", content: text }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Anthropic API error");
  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const clean = raw.replace(/```json|```/g, "").trim();
  const items = JSON.parse(clean);
  if (!Array.isArray(items)) return [];
  return items.filter(
    (i) => i && (i.type === "expense" || i.type === "income") && Number(i.amount) > 0
  );
}

// ---------- Форматирование ----------
const fmt = (n) =>
  Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ₽";

async function monthTotals() {
  const { rows } = await pool.query(`
    SELECT type, COALESCE(SUM(amount),0) AS total
    FROM transactions
    WHERE date_trunc('month', occurred_on) = date_trunc('month', CURRENT_DATE)
    GROUP BY type
  `);
  const t = { expense: 0, income: 0 };
  rows.forEach((r) => (t[r.type] = Number(r.total)));
  return t;
}

function dashboardUrl() {
  const base = RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  return `${base}/dashboard?key=${DASHBOARD_KEY}`;
}

// ---------- Обработка сообщений ----------
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  if (allowedUsers.length && !allowedUsers.includes(userId)) {
    return send(chatId, "Этот бот личный. Доступ ограничен.");
  }

  if (text === "/start") {
    return send(
      chatId,
      `Привет! Я веду учёт твоих денег.\n\n` +
        `Просто пиши мне траты и доходы своими словами:\n` +
        `• <i>кофе 300</i>\n` +
        `• <i>продукты 2500 и такси 600</i>\n` +
        `• <i>+80000 зарплата</i>\n\n` +
        `Команды:\n/report — итоги месяца\n/undo — удалить последнюю запись\n/dashboard — ссылка на дешборд\n\n` +
        `Твой id: <code>${userId}</code>`
    );
  }

  if (text === "/dashboard") {
    return send(chatId, `Дешборд: ${dashboardUrl()}`);
  }

  if (text === "/undo") {
    const { rows } = await pool.query(
      `DELETE FROM transactions WHERE id = (SELECT id FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1) RETURNING *`,
      [userId]
    );
    if (!rows.length) return send(chatId, "Удалять нечего.");
    const r = rows[0];
    return send(chatId, `Удалено: ${r.type === "income" ? "+" : "−"}${fmt(r.amount)} · ${r.category}`);
  }

  if (text === "/report") {
    const t = await monthTotals();
    const { rows } = await pool.query(`
      SELECT category, SUM(amount) AS total FROM transactions
      WHERE type='expense' AND date_trunc('month', occurred_on)=date_trunc('month', CURRENT_DATE)
      GROUP BY category ORDER BY total DESC LIMIT 5
    `);
    const top = rows.map((r) => `• ${r.category}: ${fmt(r.total)}`).join("\n") || "—";
    return send(
      chatId,
      `<b>Этот месяц</b>\nДоходы: ${fmt(t.income)}\nРасходы: ${fmt(t.expense)}\nБаланс: ${fmt(t.income - t.expense)}\n\n<b>Топ расходов</b>\n${top}\n\nПодробнее: ${dashboardUrl()}`
    );
  }

  // Обычное сообщение — парсим
  let items;
  try {
    items = await parseMessage(text);
  } catch (e) {
    console.error("parse error:", e.message);
    return send(chatId, "Не получилось разобрать сообщение, попробуй ещё раз чуть проще, например: «кофе 300».");
  }
  if (!items.length) {
    return send(chatId, "Не нашёл здесь сумм. Напиши, например: «обед 700» или «+5000 фриланс».");
  }

  for (const i of items) {
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, category, description, occurred_on)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6::date, CURRENT_DATE))`,
      [userId, i.type, Number(i.amount), i.category || "прочее", i.description || null, i.date || null]
    );
  }

  const lines = items.map(
    (i) => `${i.type === "income" ? "🟢 +" : "🔴 −"}${fmt(i.amount)} · ${i.category}${i.description ? ` (${i.description})` : ""}`
  );
  const t = await monthTotals();
  await send(
    chatId,
    `Записал:\n${lines.join("\n")}\n\nЗа месяц: −${fmt(t.expense)} / +${fmt(t.income)}\nОшибка? /undo`
  );
}

// ---------- Маршруты ----------
app.post(`/tg/${WEBHOOK_SECRET}`, (req, res) => {
  res.sendStatus(200); // отвечаем сразу, обрабатываем асинхронно
  const msg = req.body && req.body.message;
  if (msg) handleMessage(msg).catch((e) => console.error("handle error:", e));
});

function checkKey(req, res, next) {
  if ((req.query.key || "") === DASHBOARD_KEY) return next();
  res.status(403).send("Нет доступа. Возьмите ссылку у бота: /dashboard");
}

app.get("/dashboard", checkKey, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.get("/api/summary", checkKey, async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || "")
      ? req.query.month + "-01"
      : new Date().toISOString().slice(0, 8) + "01";

    const [totals, byCat, byDay, recent, months, byMonth] = await Promise.all([
      pool.query(
        `SELECT type, COALESCE(SUM(amount),0) AS total FROM transactions
         WHERE date_trunc('month', occurred_on) = date_trunc('month', $1::date) GROUP BY type`,
        [month]
      ),
      pool.query(
        `SELECT category, SUM(amount) AS total FROM transactions
         WHERE type='expense' AND date_trunc('month', occurred_on) = date_trunc('month', $1::date)
         GROUP BY category ORDER BY total DESC`,
        [month]
      ),
      pool.query(
        `SELECT occurred_on::text AS day,
                SUM(amount) FILTER (WHERE type='expense') AS expense,
                SUM(amount) FILTER (WHERE type='income') AS income
         FROM transactions
         WHERE date_trunc('month', occurred_on) = date_trunc('month', $1::date)
         GROUP BY occurred_on ORDER BY occurred_on`,
        [month]
      ),
      pool.query(
        `SELECT id, type, amount, category, description, occurred_on::text AS day
         FROM transactions
         WHERE date_trunc('month', occurred_on) = date_trunc('month', $1::date)
         ORDER BY occurred_on DESC, created_at DESC LIMIT 40`,
        [month]
      ),
      pool.query(
        `SELECT DISTINCT to_char(date_trunc('month', occurred_on), 'YYYY-MM') AS m
         FROM transactions ORDER BY m DESC`
      ),
      pool.query(
        `SELECT to_char(date_trunc('month', occurred_on), 'YYYY-MM') AS m,
                SUM(amount) FILTER (WHERE type='expense') AS expense,
                SUM(amount) FILTER (WHERE type='income') AS income
         FROM transactions
         WHERE occurred_on >= date_trunc('month', CURRENT_DATE) - interval '5 months'
         GROUP BY 1 ORDER BY 1`
      ),
    ]);

    const t = { expense: 0, income: 0 };
    totals.rows.forEach((r) => (t[r.type] = Number(r.total)));

    res.json({
      month: month.slice(0, 7),
      totals: t,
      byCategory: byCat.rows.map((r) => ({ category: r.category, total: Number(r.total) })),
      byDay: byDay.rows.map((r) => ({ day: r.day, expense: Number(r.expense || 0), income: Number(r.income || 0) })),
      recent: recent.rows.map((r) => ({ ...r, amount: Number(r.amount) })),
      months: months.rows.map((r) => r.m),
      byMonth: byMonth.rows.map((r) => ({ month: r.m, expense: Number(r.expense || 0), income: Number(r.income || 0) })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/", (req, res) => res.send("FinBot работает. Дешборд: /dashboard?key=..."));
app.get("/healthz", (req, res) => res.send("ok"));

// ---------- Старт ----------
(async () => {
  await initDb();
  app.listen(PORT, () => console.log(`Listening on :${PORT}`));
  if (RENDER_EXTERNAL_URL) {
    const url = `${RENDER_EXTERNAL_URL}/tg/${WEBHOOK_SECRET}`;
    const r = await tg("setWebhook", { url, drop_pending_updates: false });
    console.log("setWebhook:", JSON.stringify(r));
  } else {
    console.log("RENDER_EXTERNAL_URL не задан — вебхук не установлен (локальный режим).");
  }
})();
