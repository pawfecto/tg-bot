import { Telegraf, Markup } from 'telegraf';
import ExcelJS from 'exceljs';
import { requireManager } from '../../lib/roles';
import { startIntake, getActiveIntake, finalizeIntake } from '../../lib/intake';
import { notifyShipment } from '../../lib/notifymg';
import { dayKST } from '../../lib/date';
import { supabase } from '../../lib/supabase';
import { createSignedUrl } from '../../lib/storage';

// Тексты промптов для ForceReply (чтобы было легко отфильтровать ответ)
const PROMPT_CODE = 'Введите код клиента (пример: C001 или M255-D):';
const PROMPT_DATE = 'Введите дату в формате YYYY-MM-DD (и, при желании, код: C001):';

// Помощник: валидатор даты
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Построение Excel на день (копия логики /report_day, один день = from==to)
async function buildExcelForDay(bot: Telegraf, day: string, code?: string) {
  let q = supabase
    .from('photo_logs')
    .select('date, code, pallet_number, ct, gross, net, note, storage_path, telegram_file_id')
    .eq('date', day)
    .order('code', { ascending: true })
    .order('pallet_number', { ascending: true })
    .order('id', { ascending: true });
  if (code) q = q.eq('code', code.toUpperCase());

  const { data: rows, error } = await q;
  if (error) throw error;
  if (!rows || rows.length === 0) {
    return { buffer: Buffer.from([]), empty: true };
  }

  async function linkFromRow(r: any) {
    if (r.storage_path) {
      const url = await createSignedUrl(r.storage_path);
      if (url) return url;
    }
    if (r.telegram_file_id) {
      const link = await bot.telegram.getFileLink(r.telegram_file_id);
      return link.href;
    }
    return undefined;
  }

  // Summary по коду
  const summary = new Map<string, { pallets: number; totalCt: number; totalNet: number }>();
  for (const r of rows) {
    const key = r.code;
    const s = summary.get(key) ?? { pallets: 0, totalCt: 0, totalNet: 0 };
    s.pallets += (r.pallet_number != null ? 1 : 0);
    s.totalCt += Number(r.ct) || 0;
    s.totalNet += Number(r.net) || 0;
    summary.set(key, s);
  }

  const wb = new ExcelJS.Workbook();
  const ws1 = wb.addWorksheet('Palettes');
  ws1.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Code', key: 'code', width: 10 },
    { header: 'Pallet #', key: 'pallet', width: 10 },
    { header: 'Boxes', key: 'ct', width: 10 },
    { header: 'Gross', key: 'gross', width: 12 },
    { header: 'Net', key: 'net', width: 12 },
    { header: 'Note', key: 'note', width: 18 },
    { header: 'Link', key: 'link', width: 60 }
  ];
  ws1.getRow(1).font = { bold: true };

  for (const r of rows) {
    const url = await linkFromRow(r);
    ws1.addRow({
      date: r.date,
      code: r.code,
      pallet: r.pallet_number ?? '-',
      ct: r.ct,
      gross: r.gross,
      net: r.net,
      note: r.note ?? '',
      link: url ? { text: 'Open', hyperlink: url } : ''
    });
  }

  const ws2 = wb.addWorksheet('Summary');
  ws2.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Code', key: 'code', width: 10 },
    { header: 'Pallets', key: 'pallets', width: 10 },
    { header: 'Total CT', key: 'totalCt', width: 12 },
    { header: 'Total Net', key: 'totalNet', width: 14 }
  ];
  ws2.getRow(1).font = { bold: true };

  for (const [codeKey, s] of summary) {
    ws2.addRow({
      date: day,
      code: codeKey,
      pallets: s.pallets,
      totalCt: s.totalCt,
      totalNet: +s.totalNet.toFixed(2)
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return { buffer: Buffer.from(buf), empty: false };
}

// Построение инлайн-меню
function managerMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📸 Фото-заявка', 'help_photo')],
    [
      Markup.button.callback('🟢 Начать приёмку', 'recv_start'),
      Markup.button.callback('⛔ Завершить приёмку', 'recv_done')
    ],
    [
      Markup.button.callback('📑 Отчёт за сегодня', 'report_today'),
      Markup.button.callback('📅 Отчёт по дате', 'report_pick_date')
    ],
    [Markup.button.callback('👥 Мои клиенты', 'my_clients')],
    [Markup.button.callback('ℹ️ Справка', 'help_all')]
  ]);
}

export function registerManagerMenu(bot: Telegraf) {
  // Команда для вызова меню
  bot.command('menu', requireManager, async (ctx) => {
    await ctx.reply('Меню менеджера:', managerMenu());
  });

  // Подсказка по фото-заявке
  bot.action('help_photo', requireManager, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      '📸 Отправьте фото с подписью в формате:\n\n' +
      '`C001 1 24 345.35`\n\n' +
      'Где: код клиента · паллеты · коробки · брутто кг.\n' +
      'Коды можно любые (например, `M255-D`, `88880-8829A`).',
      { parse_mode: 'Markdown' }
    );
  });

  // Начать приёмку — спрашиваем код клиента
  bot.action('recv_start', requireManager, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(PROMPT_CODE, { reply_markup: { force_reply: true } });
  });

  // Завершить приёмку (суммируем позиции, уведомляем)
  bot.action('recv_done', requireManager, async (ctx) => {
    await ctx.answerCbQuery();
    const sid = getActiveIntake(ctx.from!.id);
    if (!sid) {
      await ctx.reply('Нет активной приёмки. Нажмите «🟢 Начать приёмку».');
      return;
    }
    const totals = await finalizeIntake(sid);
    await ctx.reply(
      `✅ Приёмка подтверждена.\nПаллет: ${totals.pallets}\nМест: ${totals.boxes}\nБрутто: ${totals.gross.toFixed(2)} кг`
    );
    // уведомим клиента и менеджеров
    await notifyShipment(bot, sid, { managers: 'all', includeClient: true });
  });

  // Отчёт за сегодня
  bot.action('report_today', requireManager, async (ctx) => {
    await ctx.answerCbQuery();
    const day = dayKST();
    const { buffer, empty } = await buildExcelForDay(bot, day);
    if (empty) {
      await ctx.reply(`Данных за ${day} нет.`);
      return;
    }
    const filename = `report_${day}.xlsx`;
    await ctx.replyWithDocument({ source: buffer, filename });
  });

  // Отчёт по дате — спрашиваем дату (и опционально код)
  bot.action('report_pick_date', requireManager, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(PROMPT_DATE, { reply_markup: { force_reply: true } });
  });

  // Мои клиенты (через manager_clients)
  bot.action('my_clients', requireManager, async (ctx) => {
    await ctx.answerCbQuery();
    const { data, error } = await supabase
      .from('manager_clients')
      .select('clients:client_id(client_code)')
      .eq('manager_tg_user_id',
        // получаем внутренний id менеджера
        (await supabase
          .from('tg_users')
          .select('id')
          .eq('telegram_id', ctx.from!.id)
          .maybeSingle()
        ).data?.id ?? '__none__'
      );
    if (error) {
      await ctx.reply('Не удалось получить список клиентов.');
      return;
    }
    const codes: string[] = (data ?? []).map((r: any) =>
      Array.isArray(r.clients) ? r.clients[0]?.client_code : r.clients?.client_code
    ).filter(Boolean);
    if (!codes.length) {
      await ctx.reply('У вас пока нет привязанных клиентов.');
    } else {
      await ctx.reply('Ваши клиенты: ' + codes.sort().join(', '));
    }
  });

  // Обработчик ответов на ForceReply:
  bot.on('text', requireManager, async (ctx, next) => {
    const replyTo = (ctx.message as any)?.reply_to_message?.text as string | undefined;
    if (!replyTo) return next();

    // Ответ на ввод кода клиента — старт приёмки
    if (replyTo === PROMPT_CODE) {
      const code = (ctx.message as any).text.trim().toUpperCase();
      try {
        const { client, shipmentId } = await startIntake(ctx.from!.id, code);
        await ctx.reply(`🟢 Приёмка начата для ${client.client_code}. ID: ${shipmentId.slice(0, 8)}…`);
      } catch (e: any) {
        await ctx.reply('Не удалось начать приёмку: ' + (e?.message ?? 'ошибка'));
      }
      return;
    }

    // Ответ на ввод даты (и опционально кода) — отчёт
    if (replyTo === PROMPT_DATE) {
      const parts = (ctx.message as any).text.trim().split(/\s+/);
      let day = parts[0];
      let code = parts[1];

      if (!isDate(day)) {
        await ctx.reply('Дата некорректна. Пример: 2025-08-19 или "2025-08-19 C001".');
        return;
      }

      const { buffer, empty } = await buildExcelForDay(bot, day, code);
      if (empty) {
        await ctx.reply(`Данных за ${day}${code ? ` (код ${code})` : ''} нет.`);
        return;
      }
      const filename = `report_${day}${code ? '_' + code.toUpperCase() : ''}.xlsx`;
      await ctx.replyWithDocument({ source: buffer, filename });
      return;
    }
bot.command('ping', requireManager, async (ctx) => {
  await ctx.reply('pong', {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔔 test callback', 'cb_test')]
    ])
  });
});

bot.action('cb_test', requireManager, async (ctx) => {
  await ctx.answerCbQuery('ok');   // важно отвечать на callback_query
  await ctx.reply('callback ok ✅');
});

    return next();
  });
}
