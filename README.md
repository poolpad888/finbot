# FinBot — учёт финансов в Telegram + дешборд

Пишете боту траты и доходы свободным текстом («кофе 300», «+80000 зарплата», «продукты 2500 и такси 600») — он разбирает их через Claude API, сохраняет в Postgres и показывает статистику на дешборде.

## Переменные окружения

| Переменная | Обязательна | Что это |
|---|---|---|
| `DATABASE_URL` | да | Строка подключения Postgres (Internal URL на Render) |
| `TELEGRAM_BOT_TOKEN` | да | Токен от @BotFather |
| `ANTHROPIC_API_KEY` | да | Ключ с console.anthropic.com |
| `DASHBOARD_KEY` | да | Любая секретная строка — пароль дешборда |
| `ALLOWED_USER_IDS` | нет | Ваши Telegram id через запятую (бот пришлёт id по /start) |

## Деплой на Render

1. Запушьте этот репозиторий на GitHub.
2. Создайте Postgres (Frankfurt, free) и Web Service (runtime Node, build `npm install`, start `npm start`) из репозитория.
3. Задайте переменные окружения. Вебхук Telegram установится автоматически при старте (используется `RENDER_EXTERNAL_URL`).

## Команды бота

- `/start` — приветствие и ваш id
- `/report` — итоги месяца
- `/undo` — удалить последнюю запись
- `/dashboard` — ссылка на дешборд
