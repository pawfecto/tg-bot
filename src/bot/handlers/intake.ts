import { Telegraf } from 'telegraf';
import { requireManager } from '../../lib/roles';
import { startIntake, addItem, finalizeIntake, getActiveIntake, clearActiveIntake } from '../../lib/intake';
import { addPhoto } from '../../lib/shipments';

export function registerIntakeHandlers(bot: Telegraf) {
  bot.command('receive_start', requireManager, async (ctx) => {
    const args = (ctx.message as any).text.split(/\s+/).slice(1);
    const code = args.shift(); const ref = args.join(' ') || undefined;
    if (!code) return void ctx.reply('Использование: /receive_start C001 [номер/прим.]');
    const { client, shipmentId } = await startIntake(ctx.from!.id, code, ref);
    await ctx.reply(`🟢 Приёмка начата для ${client.client_code}. Шлите фото и строки "паллеты коробки вес".`);
  });

  bot.hears(/^(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)/, requireManager, async (ctx, next) => {
    if (!getActiveIntake(ctx.from!.id)) return next();
    const m = (ctx.message as any).text.trim().match(/^(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)/)!;
    const pallets = parseInt(m[1],10); const boxes = parseInt(m[2],10); const gross = parseFloat(m[3].replace(',', '.'));
    const sid = await addItem(ctx.from!.id, pallets, boxes, gross);
    await ctx.reply(`➕ Добавлено в приёмку: паллет ${pallets}, мест ${boxes}, брутто ${gross.toFixed(2)} кг (ID: ${sid.slice(0,8)}…)`);
  });

  // фото в активную приёмку (без подписи)
  bot.on('photo', requireManager, async (ctx, next) => {
    const sid = getActiveIntake(ctx.from!.id);
    if (!sid) return next();
    const best = (ctx.message as any).photo.at(-1);
    await addPhoto(sid, { file_id: best.file_id, file_unique_id: best.file_unique_id, width: best.width, height: best.height, file_size: best.file_size });
    await ctx.reply('🖼️ Фото сохранено в текущую приёмку.');
  });

  bot.command('receive_done', requireManager, async (ctx) => {
    const sid = getActiveIntake(ctx.from!.id);
    if (!sid) return void ctx.reply('Нет активной приёмки. /receive_start C001');
    const tot = await finalizeIntake(sid);
    clearActiveIntake(ctx.from!.id);
    await ctx.reply(`✅ Приёмка подтверждена. Паллет ${tot.pallets}, мест ${tot.boxes}, брутто ${tot.gross.toFixed(2)} кг. Клиент будет уведомлён.`);
    // уведомление вынесено в quickShipment альбом-дебаунс или можно вызвать напрямую здесь при необходимости
  });
}
