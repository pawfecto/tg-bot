// src/index.ts
import 'dotenv/config';
import express from 'express';
import { Telegraf, session } from 'telegraf';
import { ENV } from './config/env';
import { logger } from './config/logger';
import { ensureBucket } from './lib/storage';

// Если у тебя есть тип MySession (например, экспортируется из registration.ts),
// можно импортировать только тип. Иначе оставь как есть — с any.
//
// import type { MySession } from './bot/handlers/registration';

const bot = new Telegraf(ENV.BOT_TOKEN);

// ❗ Подключаем session ОДИН РАЗ ЗДЕСЬ
// Если есть MySession, раскомментируй типизацию ниже.
// bot.use(session({ defaultSession: (): MySession => ({}) }) as any);
bot.use(session({ defaultSession: () => ({}) }) as any);

// handlers
import { registerAuthHandlers } from './bot/handlers/auth';
import { registerRegistration } from './bot/handlers/registration';
import { registerShipmentPhotos } from './bot/handlers/shipmentPhotos';
import { registerIntakeHandlers } from './bot/handlers/intake';
import { registerReportHandlers } from './bot/handlers/reports';
import { registerManagerMenu } from './bot/handlers/managerMenu';
import { registerFallback } from './bot/handlers/fallback';

async function main() {
  // Инициализация хранилища Supabase
  ensureBucket().catch((e) => logger.warn(e, 'ensureBucket'));

  // Регистрация хэндлеров
  registerRegistration(bot);      // мастер регистрации (номер → страна → доставка → код)
  registerAuthHandlers(bot);      // старт/контакт → авторизация (если есть)
  registerManagerMenu(bot);       // меню менеджера
  registerShipmentPhotos(bot);    // фото (создание/добавление/замена/удаление + уведомления)
  registerIntakeHandlers(bot);    // другие сценарии приёмки (если есть)
  registerReportHandlers(bot);    // отчёты /report (если есть)
  registerFallback(bot);          // ставим последним

  // HTTP-сервер для health/webhook
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.get('/', (_req, res) => res.send('OK'));
  app.get('/healthz', (_req, res) => res.send('ok'));

  // Режим: webhook или long polling
  const useWebhook = String(process.env.USE_WEBHOOK || 'false') === 'true';

  if (useWebhook) {
    const PUBLIC_URL = process.env.PUBLIC_URL;      // например: https://<app>.up.railway.app
    const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

    if (!PUBLIC_URL || !WEBHOOK_SECRET) {
      throw new Error('USE_WEBHOOK=true, но нет PUBLIC_URL или WEBHOOK_SECRET');
    }

    const path = `/tg/${WEBHOOK_SECRET}`; // защищённый путь
    app.use(express.json());
    app.post(path, bot.webhookCallback(path));
    await bot.telegram.setWebhook(`${PUBLIC_URL}${path}`, {
      secret_token: WEBHOOK_SECRET
    });

    app.listen(PORT, () => logger.info({ PORT, mode: 'webhook' }, 'HTTP server started'));
  } else {
    // POLLING
    await bot.telegram.deleteWebhook().catch(() => {});
    await bot.launch();
    logger.info('Bot launched in LONG POLLING mode');

    // всё равно слушаем порт для healthcheck Railway
    app.listen(PORT, () => logger.info({ PORT, mode: 'polling' }, 'HTTP server started'));
  }
}

main().catch((e) => {
  logger.error(e, 'Bot launch failed');
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
