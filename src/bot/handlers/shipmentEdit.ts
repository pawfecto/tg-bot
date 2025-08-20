import { Telegraf, Markup } from 'telegraf';
import { requireManager } from '../../lib/roles';
import { parseShipmentLine } from '../../lib/parse';
import { ensureClientByCode } from '../../lib/shipments';
import { supabase } from '../../lib/supabase';

// Текст подсказки для ForceReply
const EDIT_PROMPT_PREFIX =
  '✏️ Отправьте исправленную строку в формате:\n' +
  '`CODE PALLETS BOXES GROSS`\n' +
  'Например: `M255-D 2 30 400.5`\n\n' +
  'Чтобы отменить, напишите `отмена`.';
const EDIT_PROMPT_RE = /^EDIT_SHIPMENT: ([0-9a-f-]{36})$/i;

// Храним соответствие: messageId подсказки → shipmentId (10 минут)
const editMap = new Map<number, { shipmentId: string; timeout: NodeJS.Timeout }>();

function rememberEdit(messageId: number, shipmentId: string) {
  const t = setTimeout(() => editMap.delete(messageId), 10 * 60 * 1000);
  editMap.set(messageId, { shipmentId, timeout: t });
}

function forgetEdit(messageId: number) {
  const e = editMap.get(messageId);
  if (e) clearTimeout(e.timeout);
  editMap.delete(messageId);
}

export function registerShipmentEdit(bot: Telegraf) {
  // Нажатие на кнопку "✏️ Исправить"
  bot.action(/^sh:edit:([0-9a-f-]{36})$/i, requireManager, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const shipmentId = ctx.match![1];

      // убедимся, что заявка существует
      const { data: s, error } = await supabase
        .from('shipments')
        .select('id, pallets, boxes, gross_kg, clients:client_id(client_code)')
        .eq('id', shipmentId)
        .maybeSingle();
      if (error || !s) {
        await ctx.reply('⛔ Заявка не найдена или удалена.');
        return;
      }

      const clientJoin = (s as any).clients;
      const clientCode = Array.isArray(clientJoin) ? clientJoin[0]?.client_code : clientJoin?.client_code;

      // Шлём подсказку с ForceReply и «служебной» строкой с ID
      const prompt = await ctx.reply(
        `${EDIT_PROMPT_PREFIX}\n\nТекущие: ${clientCode ?? '—'} ${s.pallets} ${s.boxes} ${Number(s.gross_kg)}\n` +
        `EDIT_SHIPMENT: ${shipmentId}`,
        { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
      );

      rememberEdit(prompt.message_id, shipmentId);
    } catch (e) {
      console.error('edit start error', e);
      await ctx.reply('⚠️ Не удалось начать редактирование.');
    }
  });

  // Ответ на ForceReply (редактирование)
  bot.on('text', requireManager, async (ctx, next) => {
    const replyMsg: any = (ctx.message as any)?.reply_to_message;
    if (!replyMsg?.text) return next();

    const m = String(replyMsg.text).match(EDIT_PROMPT_RE);
    if (!m) return next();

    const mapEntry = editMap.get(replyMsg.message_id);
    if (!mapEntry) return next();

    const shipmentId = mapEntry.shipmentId;
    const text = (ctx.message as any).text.trim();

    // Отмена
    if (text.toLowerCase() === 'отмена') {
      forgetEdit(replyMsg.message_id);
      await ctx.reply('❎ Редактирование отменено.');
      return;
    }

    // Парсим новую строку
    const parsed = parseShipmentLine(text);
    if (!parsed) {
      await ctx.reply('❌ Формат не распознан. Пример: `C001 1 24 345.35`', { parse_mode: 'Markdown' });
      return;
    }

    try {
      // Клиент (автосоздание по коду, если не существует)
      const client = await ensureClientByCode(parsed.clientCode);

      // Обновляем shipment (без создания дубликата)
      const { error: updErr } = await supabase
        .from('shipments')
        .update({
          client_id: client.id,
          pallets: parsed.pallets,
          boxes: parsed.boxes,
          gross_kg: parsed.gross_kg,
          source_text: parsed.sourceText
        })
        .eq('id', shipmentId);
      if (updErr) throw updErr;

      // (опционально) обновим код в photo_logs, если такие есть — без изменения чисел
      await supabase
        .from('photo_logs')
        .update({ code: parsed.clientCode })
        .eq('shipment_id', shipmentId);

      forgetEdit(replyMsg.message_id);
      await ctx.reply(
        `✅ Обновлено: ${parsed.clientCode} · паллет ${parsed.pallets} · мест ${parsed.boxes} · брутто ${parsed.gross_kg}`
      );
    } catch (e: any) {
      console.error('edit apply error', e);
      await ctx.reply('⛔ Не удалось применить изменения: ' + (e?.message ?? 'ошибка'));
    }
  });
}
