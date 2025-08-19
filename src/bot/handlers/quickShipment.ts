import { Telegraf } from 'telegraf';
import { requireManager } from '../../lib/roles';
import { parseShipmentLine } from '../../lib/parse';
import { ensureClientByCode, findTgUser, createShipment, addPhoto } from '../../lib/shipments';
import { rememberAlbum, getShipmentIdByMgid, scheduleDebounce } from '../../lib/albums';
import { uploadPhotoToStorage, makeStoragePath } from '../../lib/storage';
import { logPhotoLikeExcel } from '../../lib/photoLogs';
import { supabase } from '../../lib/supabase';
import { notifyShipment } from '../../lib/notifymg';

// Разрешаем любые коды клиента (буквы/цифры/._-), затем паллеты/коробки/вес
const HEAR_RE =
  /^([A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9._-]*)\s+\d+\s+\d+\s+\d+(?:[.,]\d+)?(?:\s|$)/;

export function registerQuickShipment(bot: Telegraf) {
  // ─────────────────────────────────────────────────────────
  // ТЕКСТ: "C001 1 24 345.35" (или "M255-D 1 24 345.35", и т.п.)
  // ─────────────────────────────────────────────────────────
  bot.hears(HEAR_RE, requireManager, async (ctx) => {
    try {
      const parsed = parseShipmentLine((ctx.message as any).text);
      if (!parsed) return;

      // клиент (автосоздание, если нет)
      const client = await ensureClientByCode(parsed.clientCode);

      const me = await findTgUser(ctx.from!.id);
      const shipmentId = await createShipment({
        clientId: client.id,
        createdByTgUserId: me?.id ?? null,
        pallets: parsed.pallets,
        boxes: parsed.boxes,
        gross_kg: parsed.gross_kg,
        source_text: parsed.sourceText
      });

      await ctx.reply(`✅ Заявка создана для ${parsed.clientCode}. Уведомляю...`);
      await notifyShipment(bot, shipmentId, { managers: 'all', includeClient: true });
    } catch (e) {
      console.error('text shipment error', e);
      await ctx.reply('⛔ Не удалось создать заявку из текста.');
    }
  });

  // ─────────────────────────────────────────────────────────
  // ФОТО: подпись "C001 1 24 345.35" (или любой код)
  // Поддержка альбома через media_group_id
  // ─────────────────────────────────────────────────────────
  bot.on('photo', requireManager, async (ctx) => {
    try {
      const msg: any = ctx.message;
      const mgid: string | undefined = msg.media_group_id;
      let shipmentId: string | null = null;

      // Первое фото (обычно с подписью) → создаём shipment
      if (msg.caption) {
        const parsed = parseShipmentLine(msg.caption);
        if (parsed) {
          const client = await ensureClientByCode(parsed.clientCode);

          const me = await findTgUser(ctx.from!.id);
          shipmentId = await createShipment({
            clientId: client.id,
            createdByTgUserId: me?.id ?? null,
            pallets: parsed.pallets,
            boxes: parsed.boxes,
            gross_kg: parsed.gross_kg,
            source_text: msg.caption,
            media_group_id: mgid ?? null
          });

          if (mgid) rememberAlbum(mgid, shipmentId);

          // Максимальное качество фото (последний элемент массива)
          const photos = msg.photo as Array<any>;
          const best = photos[photos.length - 1];

          // 1) Загрузка в Storage
          let storagePath: string | null = null;
          try {
            storagePath = makeStoragePath(parsed.clientCode, shipmentId, best.file_unique_id);
            await uploadPhotoToStorage(bot, best.file_id, storagePath);
          } catch (e) {
            console.error('storage upload failed', e);
            storagePath = null;
          }

          // 2) Лог «как в Excel» (photo_logs)
          await logPhotoLikeExcel({
            parsed,
            shipmentId,
            managerTelegramId: ctx.from!.id,
            storagePath,
            telegramFileId: best.file_id
          });

          // 3) Запись фото в shipment_photos
          await addPhoto(shipmentId, {
            file_id: best.file_id,
            file_unique_id: best.file_unique_id,
            width: best.width,
            height: best.height,
            file_size: best.file_size,
            storage_path: storagePath
          });

          await ctx.reply(`✅ Заявка создана: ${parsed.clientCode}. Фото сохранено.`);

          // Одиночное фото → уведомляем сразу; альбом — после последнего кадра (ниже debounce)
          if (!mgid) {
            await notifyShipment(bot, shipmentId, { managers: 'all', includeClient: true });
          }
        }
      }

      // Последующие фото альбома (без подписи): ищем по media_group_id
      if (!shipmentId && mgid) {
        shipmentId = getShipmentIdByMgid(mgid);
      }

      if (shipmentId) {
        const photos = (ctx.message as any).photo as Array<any>;
        const best = photos[photos.length - 1];

        // Для пути в Storage нужен client_code → возьмём из shipment -> client
        let storagePath: string | null = null;
        try {
          const { data: s } = await supabase
            .from('shipments')
            .select('clients:client_id(client_code)')
            .eq('id', shipmentId)
            .single();

          const clientJoin = (s as any)?.clients;
          const clientCode = Array.isArray(clientJoin)
            ? clientJoin[0]?.client_code
            : clientJoin?.client_code;

          if (clientCode) {
            storagePath = makeStoragePath(clientCode, shipmentId, best.file_unique_id);
            await uploadPhotoToStorage(bot, best.file_id, storagePath);
          }
        } catch (e) {
          console.error('storage upload (album) failed', e);
        }

        await addPhoto(shipmentId, {
          file_id: best.file_id,
          file_unique_id: best.file_unique_id,
          width: best.width,
          height: best.height,
          file_size: best.file_size,
          storage_path: storagePath
        });

        // Debounce: дождёмся всех кадров альбома и разошлём одним медиа-групп
        if (mgid) {
          scheduleDebounce(mgid, (sid) => {
            notifyShipment(bot, sid, { managers: 'all', includeClient: true }).catch(() => {});
          });
        }
      }
    } catch (e) {
      console.error('photo shipment error', e);
      await ctx.reply('⚠️ Фото не удалось сохранить.');
    }
  });
}
