// src/bot/handlers/profile.ts
import { Telegraf, Markup } from 'telegraf';
import { supabase } from '../../lib/supabase';

// ===== helpers ===================================================

type TgUserRow = {
  telegram_id: number;
  client_id: string | null;
  is_verified: boolean;
};
type ClientRow = {
  id: string;
  client_code: string | null;
  full_name: string | null;
  phone_number: string | null;
  country: 'ru' | 'kz' | 'uz' | 'kg' | null;
  delivery_type: 'warehouse' | 'home' | null;
  delivery_address: string | null;
  email: string | null;
  language: 'ru' | 'en' | null;
};
type PrefsRow = {
  client_id: string;
  notif_arrival: boolean;
  notif_update_text: boolean;
  notif_update_photo: boolean;
  notif_storage: boolean;
  notif_daily_digest: boolean;
};

const COUNTRY_LABEL: Record<string, string> = {
  ru: '🇷🇺 Россия',
  kz: '🇰🇿 Казахстан',
  uz: '🇺🇿 Узбекистан',
  kg: '🇰🇬 Киргизстан',
};
const DELIVERY_LABEL: Record<string, string> = {
  warehouse: '🏬 До склада',
  home: '🏠 До дома',
};

const PREF_KEYS: Array<keyof PrefsRow> = [
  'notif_arrival',
  'notif_update_text',
  'notif_update_photo',
  'notif_storage',
  'notif_daily_digest',
];

function flag(on: boolean) {
  return on ? '✅' : '❌';
}

async function getMyTgUser(telegramId: number): Promise<TgUserRow | null> {
  const { data } = await supabase
    .from('tg_users')
    .select('telegram_id, client_id, is_verified')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return (data as any) ?? null;
}

async function getClient(clientId: string): Promise<ClientRow | null> {
  const { data } = await supabase
    .from('clients')
    .select('id, client_code, full_name, phone_number, country, delivery_type, delivery_address, email, language')
    .eq('id', clientId)
    .maybeSingle();
  return (data as any) ?? null;
}

async function ensurePrefs(clientId: string): Promise<PrefsRow> {
  const { data } = await supabase
    .from('client_prefs')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle();

  if (data) return data as any;

  const defaults = {
    client_id: clientId,
    notif_arrival: true,
    notif_update_text: true,
    notif_update_photo: true,
    notif_storage: false,
    notif_daily_digest: false,
  };
  const { data: ins, error } = await supabase
    .from('client_prefs')
    .insert(defaults)
    .select('*')
    .single();
  if (error) throw error;
  return ins as any;
}

async function countTodayShipments(clientId: string): Promise<number> {
  // упрощенно: от начала текущего дня по UTC
  const { data } = await supabase
    .from('shipments')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('created_at', new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString());
  return (data as any)?.length ?? 0; // head:true вернет только count в header; supabase-js не отдает тут, поэтому fallback 0
}

function profileKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить данные', 'prof:edit')],
    [Markup.button.callback('🔔 Уведомления', 'prof:notif')],
    [
      Markup.button.callback('📦 Мои грузы', 'prof:shipments:1'),
      Markup.button.callback('🧾 Отчёт за день', 'prof:report:today')
    ],
    [Markup.button.callback('🧷 Пропуск (QR)', 'prof:qr')],
  ]);
}

function editKb() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('👤 Имя', 'prof:edit:name'),
      Markup.button.callback('📧 Email', 'prof:edit:email'),
    ],
    [
      Markup.button.callback('🌍 Страна', 'prof:edit:country'),
      Markup.button.callback('🚚 Доставка', 'prof:edit:delivery'),
    ],
    [Markup.button.callback('🏠 Адрес (для дома)', 'prof:edit:address')],
    [Markup.button.callback('⬅️ Назад', 'prof:open')],
  ]);
}

function notifKb(p: PrefsRow) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${flag(p.notif_arrival)} Груз поступил`, 'prof:notif:toggle:notif_arrival')],
    [Markup.button.callback(`${flag(p.notif_update_text)} Изм. (текст)`, 'prof:notif:toggle:notif_update_text')],
    [Markup.button.callback(`${flag(p.notif_update_photo)} Изм. (фото)`, 'prof:notif:toggle:notif_update_photo')],
    [Markup.button.callback(`${flag(p.notif_storage)} Хранение/просрочка`, 'prof:notif:toggle:notif_storage')],
    [Markup.button.callback(`${flag(p.notif_daily_digest)} Сводка дня 20:00`, 'prof:notif:toggle:notif_daily_digest')],
    [Markup.button.callback('⬅️ Назад', 'prof:open')],
  ]);
}

// ===== helpers for shipments inline menu =========================

function fmtDate(d: string) {
  return new Date(d).toISOString().slice(0, 10);
}
function fmtKg(n: number | null | undefined) {
  return (Number(n) || 0).toFixed(2);
}

// Клавиатура списка поставок: по кнопке на поставку + пагинация
function shipmentsListKb(
  rows: Array<{ id: string; boxes: number | null; gross_kg: number | null; created_at: string }>,
  page: number
) {
  const shipmentButtons = rows.map((r) => [
    Markup.button.callback(
      `${fmtDate(r.created_at)} • ${r.boxes ?? 0} мест • ${fmtKg(r.gross_kg)} кг`,
      `prof:shipment:${r.id}:${page}`
    ),
  ]);

  const nav = [
    [
      Markup.button.callback('◀️', `prof:shipments:${Math.max(1, page - 1)}`),
      Markup.button.callback('▶️', `prof:shipments:${page + 1}`),
    ],
    [Markup.button.callback('⬅️ В профиль', 'prof:open')],
  ];

  return Markup.inlineKeyboard([...shipmentButtons, ...nav]);
}

async function renderProfileText(telegramId: number): Promise<string> {
  const me = await getMyTgUser(telegramId);
  if (!me || !me.client_id || !me.is_verified) {
    return 'Чтобы открыть профиль, сначала авторизуйтесь и привяжите номер телефона. Нажмите /start и отправьте контакт.';
  }
  const c = await getClient(me.client_id);
  if (!c) return 'Профиль не найден. Обратитесь в поддержку.';

  const country = c.country ? COUNTRY_LABEL[c.country] || c.country : '—';
  const delivery =
    c.delivery_type
      ? (DELIVERY_LABEL[c.delivery_type] + (c.delivery_type === 'home' && c.delivery_address ? `: ${c.delivery_address}` : ''))
      : '—';

  // попытка получить число за сегодня
  let todayCnt = 0;
  try { todayCnt = await countTodayShipments(c.id); } catch {}

  return [
    `👤 *${c.full_name || '-'}*`,
    `Код клиента: *${c.client_code || '-'}*`,
    `Страна: ${country}`,
    `Доставка: ${delivery}`,
    `Контакты: ${c.phone_number || '-'}${c.email ? `, ${c.email}` : ''}`,
    `Активные грузы сегодня: *${todayCnt}*`,
  ].join('\n');
}

// ===== main handlers ============================================

export function registerProfileHandlers(bot: Telegraf) {
  // Команда
  bot.command('profile', async (ctx) => {
    const text = await renderProfileText(ctx.from!.id);
    await ctx.replyWithMarkdown(text, profileKb());
  });

  // Открыть профиль (кнопка "Назад")
  bot.action('prof:open', async (ctx) => {
    await ctx.answerCbQuery();
    const text = await renderProfileText(ctx.from!.id);
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: profileKb().reply_markup });
    } catch {
      await ctx.replyWithMarkdown(text, profileKb());
    }
  });

  // Меню редактирования
  bot.action('prof:edit', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Что хотите изменить?', { reply_markup: editKb().reply_markup });
  });

  // ---- поле: имя
  bot.action('prof:edit:name', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('✏️ Отправьте *имя и фамилию* одной строкой\nEDIT_NAME', { parse_mode: 'Markdown', reply_markup: { force_reply: true } });
  });
  bot.on('text', async (ctx, next) => {
    const r = (ctx.message as any)?.reply_to_message?.text as string | undefined;
    if (r !== '✏️ Отправьте *имя и фамилию* одной строкой\nEDIT_NAME') return next();

    const fullName = String((ctx.message as any).text).trim();
    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');

    const { error } = await supabase.from('clients').update({ full_name: fullName }).eq('id', me.client_id);
    if (error) return void ctx.reply('⛔ Не удалось сохранить.');

    await ctx.reply('✅ Обновлено: имя.');
  });

  // ---- поле: email
  bot.action('prof:edit:email', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('✏️ Отправьте e-mail одной строкой\nEDIT_EMAIL', { reply_markup: { force_reply: true } });
  });
  bot.on('text', async (ctx, next) => {
    const r = (ctx.message as any)?.reply_to_message?.text as string | undefined;
    if (r !== '✏️ Отправьте e-mail одной строкой\nEDIT_EMAIL') return next();

    const email = String((ctx.message as any).text).trim();
    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');

    const { error } = await supabase.from('clients').update({ email }).eq('id', me.client_id);
    if (error) return void ctx.reply('⛔ Не удалось сохранить.');

    await ctx.reply('✅ Обновлено: e-mail.');
  });

  // ---- поле: страна
  bot.action('prof:edit:country', async (ctx) => {
    await ctx.answerCbQuery();
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('🇷🇺 Россия', 'prof:country:ru'),
        Markup.button.callback('🇰🇿 Казахстан', 'prof:country:kz'),
      ],
      [
        Markup.button.callback('🇺🇿 Узбекистан', 'prof:country:uz'),
        Markup.button.callback('🇰🇬 Киргизстан', 'prof:country:kg'),
      ],
      [Markup.button.callback('⬅️ Назад', 'prof:edit')],
    ]);
    await ctx.editMessageText('Выберите страну:', { reply_markup: kb.reply_markup });
  });
  bot.action(/^prof:country:(ru|kz|uz|kg)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const country = ctx.match![1] as ClientRow['country'];
    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');

    const { error } = await supabase.from('clients').update({ country }).eq('id', me.client_id);
    if (error) return void ctx.reply('⛔ Не удалось сохранить.');

    await ctx.reply(`✅ Обновлено: страна — ${COUNTRY_LABEL[country] || country}.`);
  });

  // ---- поле: доставка
  bot.action('prof:edit:delivery', async (ctx) => {
    await ctx.answerCbQuery();
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('🏬 До склада', 'prof:delivery:warehouse'),
        Markup.button.callback('🏠 До дома', 'prof:delivery:home'),
      ],
      [Markup.button.callback('⬅️ Назад', 'prof:edit')],
    ]);
    await ctx.editMessageText('Выберите тип доставки:', { reply_markup: kb.reply_markup });
  });
  bot.action(/^prof:delivery:(warehouse|home)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const delivery = ctx.match![1] as ClientRow['delivery_type'];
    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');

    const { error } = await supabase.from('clients').update({ delivery_type: delivery }).eq('id', me.client_id);
    if (error) return void ctx.reply('⛔ Не удалось сохранить.');

    if (delivery === 'home') {
      await ctx.reply('✏️ Введите адрес одной строкой\nEDIT_ADDRESS', { reply_markup: { force_reply: true } });
    } else {
      await ctx.reply('✅ Обновлено: тип доставки — до склада.');
    }
  });

  // ---- поле: адрес (для "до дома")
  bot.action('prof:edit:address', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('✏️ Введите адрес одной строкой\nEDIT_ADDRESS', { reply_markup: { force_reply: true } });
  });
  bot.on('text', async (ctx, next) => {
    const r = (ctx.message as any)?.reply_to_message?.text as string | undefined;
    if (r !== '✏️ Введите адрес одной строкой\nEDIT_ADDRESS') return next();

    const address = String((ctx.message as any).text).trim();
    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');
    const { error } = await supabase.from('clients').update({ delivery_address: address, delivery_type: 'home' }).eq('id', me.client_id);
    if (error) return void ctx.reply('⛔ Не удалось сохранить.');
    await ctx.reply('✅ Обновлено: адрес для доставки.');
  });

  // ---- уведомления
  bot.action('prof:notif', async (ctx) => {
    await ctx.answerCbQuery();
    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');
    const prefs = await ensurePrefs(me.client_id);
    await ctx.editMessageText('Уведомления:', { reply_markup: notifKb(prefs).reply_markup });
  });
  bot.action(/^prof:notif:toggle:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const key = ctx.match![1] as keyof PrefsRow;
    if (!PREF_KEYS.includes(key)) return;

    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');
    const prefs = await ensurePrefs(me.client_id);

    const nextVal = !prefs[key] as any;
    const { error } = await supabase.from('client_prefs').update({ [key]: nextVal }).eq('client_id', me.client_id);
    if (error) return void ctx.reply('⛔ Не удалось сохранить.');

    const updated = { ...prefs, [key]: nextVal } as PrefsRow;
    await ctx.editMessageText('Уведомления:', { reply_markup: notifKb(updated).reply_markup });
  });

  // ---- мои грузы: инлайн-меню со списком и пагинацией
  bot.action(/^prof:shipments:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const page = Math.max(1, parseInt(ctx.match![1], 10) || 1);
    const limit = 5;
    const offset = (page - 1) * limit;

    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');

    const { data: rows } = await supabase
      .from('shipments')
      .select('id, pallets, boxes, gross_kg, created_at')
      .eq('client_id', me.client_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const title = `*Мои грузы (стр. ${page})*\nВыберите поставку:`;

    if (!rows || rows.length === 0) {
      const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ В профиль', 'prof:open')]]);
      try {
        await ctx.editMessageText('Поставок пока нет.', { reply_markup: kb.reply_markup });
      } catch {
        await ctx.reply('Поставок пока нет.', kb);
      }
      return;
    }

    const kb = shipmentsListKb(rows as any, page);
    try {
      await ctx.editMessageText(title, { parse_mode: 'Markdown', reply_markup: kb.reply_markup });
    } catch {
      await ctx.replyWithMarkdown(title, kb);
    }
  });

  // ---- карточка поставки (детали + кнопки Фото/Назад)
  bot.action(/^prof:shipment:([a-zA-Z0-9-]+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const shipmentId = ctx.match![1];
    const fromPage = Math.max(1, parseInt(ctx.match![2], 10) || 1);

    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');

    const { data: row } = await supabase
      .from('shipments')
      .select('id, pallets, boxes, gross_kg, created_at')
      .eq('client_id', me.client_id)
      .eq('id', shipmentId)
      .maybeSingle();

    if (!row) {
      return void ctx.reply('Поставка не найдена.');
    }

    const text =
      `*Поставка*\n` +
      `ID: \`${row.id}\`\n` +
      `Дата: ${fmtDate(row.created_at)}\n` +
      `Мест: ${row.boxes ?? 0}\n` +
      `Паллет: ${row.pallets ?? '-'}\n` +
      `Брутто: ${fmtKg(row.gross_kg)} кг`;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('🖼 Фото', `prof:shipment:photos:${row.id}:${fromPage}`)],
      [Markup.button.callback('⬅️ К списку', `prof:shipments:${fromPage}`)],
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb.reply_markup });
    } catch {
      await ctx.replyWithMarkdown(text, kb);
    }
  });

  // ---- фото поставки (без force_reply, через кнопку)
  bot.action(/^prof:shipment:photos:([a-zA-Z0-9-]+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const shipmentId = ctx.match![1];
    const fromPage = Math.max(1, parseInt(ctx.match![2], 10) || 1);

    const { data: photos } = await supabase
      .from('shipment_photos')
      .select('telegram_file_id')
      .eq('shipment_id', shipmentId)
      .order('id', { ascending: true })
      .limit(10);

    if (!photos || photos.length === 0) {
      await ctx.reply('Фото не найдены.');
      const kbBack = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад к поставке', `prof:shipment:${shipmentId}:${fromPage}`)]]);
      await ctx.reply('Вернуться к карточке:', kbBack);
      return;
    }

    if (photos.length === 1) {
      await ctx.replyWithPhoto(photos[0].telegram_file_id);
    } else {
      const media = photos.map((p: any) => ({ type: 'photo' as const, media: p.telegram_file_id }));
      await ctx.replyWithMediaGroup(media);
    }

    const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад к поставке', `prof:shipment:${shipmentId}:${fromPage}`)]]);
    await ctx.reply('Готово.', kb);
  });

  // ---- Альтернативный сценарий: Фото по ID через ввод (оставлен для совместимости)
  bot.action('prof:shipment:askphotos', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Отправьте ID поставки одной строкой\nPHOTOS_BY_ID', { reply_markup: { force_reply: true } });
  });
  bot.on('text', async (ctx, next) => {
    const r = (ctx.message as any)?.reply_to_message?.text as string | undefined;
    if (r !== 'Отправьте ID поставки одной строкой\nPHOTOS_BY_ID') return next();

    const id = String((ctx.message as any).text).trim();
    const { data: photos } = await supabase
      .from('shipment_photos')
      .select('telegram_file_id')
      .eq('shipment_id', id)
      .order('id', { ascending: true })
      .limit(10);

    if (!photos || photos.length === 0) {
      return void ctx.reply('Фото не найдены.');
    }
    if (photos.length === 1) {
      await ctx.replyWithPhoto(photos[0].telegram_file_id);
    } else {
      const media = photos.map((p: any) => ({ type: 'photo' as const, media: p.telegram_file_id }));
      await ctx.replyWithMediaGroup(media);
    }
  });

  // ---- отчёт за сегодня (только текстовая сводка в этом модуле)
  bot.action('prof:report:today', async (ctx) => {
    await ctx.answerCbQuery();
    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');

    const { data: rows } = await supabase
      .from('shipments')
      .select('boxes, gross_kg')
      .eq('client_id', me.client_id)
      .gte('created_at', new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString());

    if (!rows || rows.length === 0) {
      return void ctx.reply('За сегодня поставок не найдено.');
    }
    const boxesSum = rows.reduce((s: number, r: any) => s + (r.boxes || 0), 0);
    const grossSum = rows.reduce((s: number, r: any) => s + (Number(r.gross_kg) || 0), 0);

    await ctx.reply(`🧾 Отчёт за сегодня\nМест: ${boxesSum}\nБрутто: ${grossSum.toFixed(2)} кг`);
  });

  // ---- QR (опционально, без новых зависимостей покажем код)
  bot.action('prof:qr', async (ctx) => {
    await ctx.answerCbQuery();
    const me = await getMyTgUser(ctx.from!.id);
    if (!me?.client_id) return void ctx.reply('⛔ Профиль не найден.');
    const c = await getClient(me.client_id);
    if (!c?.client_code) return void ctx.reply('Код клиента не задан.');

    // Пытаемся динамически подключить qrcode (если установите `npm i qrcode`)
    try {
      // @ts-ignore
      const QR = await import('qrcode');
      const png = await (QR as any).toBuffer(c.client_code, { margin: 1, scale: 6 });
      await ctx.replyWithPhoto({ source: png }, { caption: `Пропуск: ${c.client_code}` });
    } catch {
      await ctx.reply(`Ваш код: \`${c.client_code}\`\n(для QR установите пакет \`qrcode\`)`, { parse_mode: 'Markdown' });
    }
  });
}
