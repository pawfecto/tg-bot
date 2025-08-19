// src/bot/handlers/reports.ts
import { Telegraf } from 'telegraf';
import ExcelJS from 'exceljs';
import { getUserRole } from '../../lib/roles';
import { dayKST } from '../../lib/date';
import { supabase } from '../../lib/supabase';
import { createSignedUrl } from '../../lib/storage';

function isDate(s?: string) {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function linkFromRow(bot: Telegraf, r: { storage_path?: string | null; telegram_file_id?: string | null }) {
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

async function buildExcelForRange(bot: Telegraf, from: string, to: string, code?: string) {
  let q = supabase
    .from('photo_logs')
    .select('date, code, pallet_number, ct, gross, net, note, storage_path, telegram_file_id')
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: true })
    .order('code', { ascending: true })
    .order('pallet_number', { ascending: true });

  if (code) q = q.eq('code', code);

  const { data: rows, error } = await q;
  if (error) throw error;
  if (!rows?.length) return { buffer: Buffer.from([]), empty: true };

  // summary по (date|code)
  const summary = new Map<string, { pallets: number; totalCt: number; totalNet: number }>();
  for (const r of rows) {
    const key = `${r.date}|${r.code}`;
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
    const url = await linkFromRow(bot, r);
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

  for (const [key, s] of summary) {
    const [d, c] = key.split('|');
    ws2.addRow({ date: d, code: c, pallets: s.pallets, totalCt: s.totalCt, totalNet: +s.totalNet.toFixed(2) });
  }

  const buffer = await wb.xlsx.writeBuffer();
  return { buffer: Buffer.from(buffer), empty: false };
}

export function registerReportHandlers(bot: Telegraf) {
  bot.command('report', async (ctx) => {
    try {
      const role = await getUserRole(ctx.from!.id);
      if (role !== 'admin' && role !== 'manager') {
        await ctx.reply('⛔ Недостаточно прав.');
        return;
      }

      // Поддержка:
      // /report                     -> сегодня (KST), все коды
      // /report 2025-08-19          -> указанная дата, все коды
      // /report C001                -> сегодня (KST), только C001
      // /report 2025-08-19 C001     -> указанная дата, только C001
      const args = (ctx.message as any).text.split(/\s+/).slice(1);
      let day = dayKST();
      let code: string | undefined;

      if (args[0]) {
        if (isDate(args[0])) {
          day = args[0];
          code = args[1]?.toUpperCase();
        } else {
          code = args[0].toUpperCase();
          if (isDate(args[1])) day = args[1];
        }
      }

      const { buffer, empty } = await buildExcelForRange(bot, day, day, code);
      if (empty) {
        await ctx.reply(`Данных за ${day}${code ? ` (код ${code})` : ''} нет.`);
        return;
      }

      const filename = `report_${day}${code ? '_' + code : ''}.xlsx`;
      await ctx.replyWithDocument({ source: buffer, filename });
    } catch (e) {
      console.error('/report error', e);
      await ctx.reply('⛔ Не удалось сформировать отчёт.');
    }
  });
}
