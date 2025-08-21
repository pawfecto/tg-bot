// src/bot/handlers/shipmentPhotos.ts
import { Telegraf, Markup } from 'telegraf';
import { supabase } from '../../lib/supabase';
import { requireManager } from '../../lib/roles';
import { ensureClientByCode, createShipment, addPhoto } from '../../lib/shipments';
import { uploadPhotoToStorage } from '../../lib/storage';

const STORAGE_BUCKET = process.env.SUPABASE_BUCKET || 'cargo';
const SEND_PHOTOS_ON_CREATED = true;   // при создании рассылаем альбом
const SEND_PHOTOS_ON_UPDATED = true;   // при замене/добавлении фото рассылаем альбом
const EXCLUDE_AUTHOR_FROM_NOTIFY = true;

// ── Память состояний ─────────────────────────────────────────────
const albumMap = new Map<string, string>();               // media_group_id -> shipmentId
const debounceTimers = new Map<string, NodeJS.Timeout>(); // debounce ключ -> таймер
const pendingReup = new Map<number, string>();            // chatId -> shipmentId (замена фото)
const pendingAdd  = new Map<number, string>();            // chatId -> shipmentId (добавить фото)
const clearedReup = new Set<string>();                    // чтобы чистить фото один раз (ключ: mgid или chatId:shipmentId)

// ── Утилиты ──────────────────────────────────────────────────────
function parseCaption(raw?: string) {
  if (!raw) return null;
  const text = raw.trim().replace(/\s+/g, ' ');
  const m = text.match(
    /^([A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9._-]*)\s+(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)(?:\s|$)/
  );
  if (!m) return null;
  const clientCode = m[1].toUpperCase();
  const pallets = parseInt(m[2], 10);
  const boxes   = parseInt(m[3], 10);
  const gross   = parseFloat(m[4].replace(',', '.'));
  if ([pallets, boxes].some(Number.isNaN) || Number.isNaN(gross)) return null;
  return { clientCode, pallets, boxes, gross, sourceText: raw.trim() };
}

function kb(shipmentId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Исправить текст', `edit_text:${shipmentId}`)],
    [
      Markup.button.callback('🖼 Заменить фото', `reup_photos:${shipmentId}`),
      Markup.button.callback('➕ Добавить фото', `add_photos:${shipmentId}`)
    ],
    [Markup.button.callback('🗑 Удалить все фото', `del_photos:${shipmentId}`)]
  ]);
}

function slug(s: string) {
  return s.replace(/[^A-Za-z0-9._-]/g, '_'); // безопасный ASCII-ключ для Storage
}
function buildStoragePath(clientCode: string, shipmentId: string, uniq: string) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `clients/${slug(clientCode)}/${yyyy}-${mm}-${dd}/${shipmentId}/${uniq}.jpg`;
}

function makeCaptionText(opts: {
  event: 'created'|'updated',
  code: string, fullName?: string|null,
  pallets?: number|null, boxes: number, gross: number
}) {
  const name = opts.fullName ? ` (${opts.fullName})` : '';
  const title = opts.event === 'created' ? '📦 Груз поступил на склад' : '✏️ Данные по грузу обновлены';
  const pal = (opts.pallets ?? '-') + '';
  return `${title}
Клиент: ${opts.code}${name}
Паллет: ${pal}
Мест: ${opts.boxes}
Брутто: ${opts.gross.toFixed(2)} кг`;
}

async function listRecipients(clientId: string): Promise<number[]> {
  const ids = new Set<number>();
  // Клиенты
  const { data: cli } = await supabase
    .from('tg_users')
    .select('telegram_id, role, is_verified')
    .eq('client_id', clientId);
  (cli ?? []).forEach((u: any) => {
    if (u.is_verified && u.role !== 'blocked') ids.add(Number(u.telegram_id));
  });
  // Менеджеры/админы
  const { data: mgr } = await supabase
    .from('tg_users')
    .select('telegram_id')
    .in('role', ['manager', 'admin'])
    .eq('is_verified', true);
  (mgr ?? []).forEach((u: any) => ids.add(Number(u.telegram_id)));
  return Array.from(ids);
}

async function loadShipmentForNotify(shipmentId: string) {
  const { data: s } = await supabase
    .from('shipments')
    .select('id, client_id, pallets, boxes, gross_kg, clients:client_id(client_code, full_name)')
    .eq('id', shipmentId)
    .single();
  const client = Array.isArray((s as any)?.clients) ? (s as any).clients[0] : (s as any)?.clients;
  const { data: photos } = await supabase
    .from('shipment_photos')
    .select('telegram_file_id')
    .eq('shipment_id', shipmentId)
    .order('id', { ascending: true })
    .limit(10);
  return { s, client, photos: photos ?? [] };
}

async function notifyAll(bot: Telegraf, shipmentId: string, opts: {
  actorId?: number,
  event: 'created'|'updated',
  withPhotos: boolean
}) {
  const { s, client, photos } = await loadShipmentForNotify(shipmentId);
  const caption = makeCaptionText({
    event: opts.event,
    code: client.client_code,
    fullName: client.full_name,
    pallets: (s as any).pallets ?? null,
    boxes: (s as any).boxes,
    gross: Number((s as any).gross_kg),
  });

  let recipients = await listRecipients((s as any).client_id);
  if (EXCLUDE_AUTHOR_FROM_NOTIFY && opts.actorId) {
    recipients = recipients.filter((id) => id !== opts.actorId);
  }
  if (recipients.length === 0) return;

  const sendPhotos = opts.withPhotos && photos.length > 0;

  for (const chatId of recipients) {
    try {
      if (!sendPhotos) {
        await bot.telegram.sendMessage(chatId, caption);
      } else if (photos.length === 1) {
        await bot.telegram.sendPhoto(chatId, photos[0].telegram_file_id, { caption });
      } else {
        const media = photos.map((p: any, i: number) => ({
          type: 'photo' as const,
          media: p.telegram_file_id,
          ...(i === 0 ? { caption } : {}),
        }));
        await bot.telegram.sendMediaGroup(chatId, media);
      }
    } catch {
      // пропускаем сбои доставки
    }
  }
}

function debounceOnce(key: string, fn: () => void, ms = 1500) {
  const t = debounceTimers.get(key);
  if (t) clearTimeout(t);
  const nt = setTimeout(() => {
    debounceTimers.delete(key);
    fn();
  }, ms);
  debounceTimers.set(key, nt);
}

// ACK менеджеру после операций с фото: всегда с кнопкой
async function ackToActor(bot: Telegraf, chatId: number, shipmentId: string, kind: 'reup' | 'add') {
  const txt = kind === 'reup'
    ? '✅ Фото заменены.'
    : '✅ Фото добавлены.';
  await bot.telegram.sendMessage(chatId, txt, kb(shipmentId));
}

// ── Регистрация ──────────────────────────────────────────────────
export function registerShipmentPhotos(bot: Telegraf) {
  // Создание/добавление/замена по фото(+альбом)
  bot.on('photo', requireManager, async (ctx) => {
    try {
      const msg: any = ctx.message;
      const mgid: string | undefined = msg.media_group_id;
      const actorId = ctx.chat!.id;

      // Режимы добавления/замены фото, включаются кнопками ниже
      const addFor = pendingAdd.get(actorId);
      const reupFor = pendingReup.get(actorId);

      // ── A) Режим ADD / REUP ─────────────────────────────────────
      if (addFor || reupFor) {
        const shipmentId = (addFor || reupFor)!;

        // REUP: очистка старых фото (однократно на альбом/сессию)
        if (reupFor) {
          const clearKey = mgid || `${actorId}:${shipmentId}`;
          if (!clearedReup.has(clearKey)) {
            clearedReup.add(clearKey);
            try {
              const { data: all } = await supabase
                .from('shipment_photos')
                .select('id, storage_path')
                .eq('shipment_id', shipmentId);

              if (all && all.length) {
                const paths = all.map((r: any) => r.storage_path).filter(Boolean);
                if (paths.length) {
                  await supabase.storage.from(STORAGE_BUCKET).remove(paths);
                }
                await supabase.from('shipment_photos').delete().eq('shipment_id', shipmentId);
              }
            } catch (e) {
              console.error('reup clear photos error', e);
            }
          }
        }

        // Привяжем альбом к заявке
        if (mgid) albumMap.set(mgid, shipmentId);

        // Сохраняем кадр
        const photos = msg.photo as Array<any>;
        const best = photos[photos.length - 1];

        // client_code для пути
        let clientCode: string | undefined;
        try {
          const { data: s } = await supabase
            .from('shipments')
            .select('clients:client_id(client_code)')
            .eq('id', shipmentId)
            .single();
          const join = (s as any)?.clients;
          clientCode = Array.isArray(join) ? join[0]?.client_code : join?.client_code;
        } catch {}

        let storagePath: string | null = null;
        try {
          if (clientCode) {
            storagePath = buildStoragePath(clientCode, shipmentId, best.file_unique_id);
            await uploadPhotoToStorage(bot, best.file_id, storagePath);
          }
        } catch (e) {
          console.error('storage upload (add/reup) failed', e);
        }

        await addPhoto(shipmentId, {
          file_id: best.file_id,
          file_unique_id: best.file_unique_id,
          width: best.width,
          height: best.height,
          file_size: best.file_size,
          storage_path: storagePath,
        });

        // Уведомления + ACK менеджеру
        if (mgid) {
          debounceOnce(`reup:${mgid}`, () => {
            notifyAll(bot, shipmentId, {
              actorId,
              event: 'updated',
              withPhotos: SEND_PHOTOS_ON_UPDATED,
            }).catch(() => {});
            ackToActor(bot, actorId, shipmentId, reupFor ? 'reup' : 'add').catch(() => {});
            pendingReup.delete(actorId);
            pendingAdd.delete(actorId);
          });
        } else {
          await notifyAll(bot, shipmentId, {
            actorId,
            event: 'updated',
            withPhotos: SEND_PHOTOS_ON_UPDATED,
          });
          await ackToActor(bot, actorId, shipmentId, reupFor ? 'reup' : 'add');
          pendingReup.delete(actorId);
          pendingAdd.delete(actorId);
        }
        return; // важно — не продолжаем создание
      }

      // ── B) Создание по подписи на первом кадре ──────────────────
      const caption = (msg as any).caption as string | undefined;
      const parsed = parseCaption(caption);

      if (parsed) {
        // Первое фото (с подписью) → создаём shipment
        const client = await ensureClientByCode(parsed.clientCode);
        const shipmentId = await createShipment({
          clientId: client.id,
          createdByTgUserId: null,
          pallets: parsed.pallets,
          boxes: parsed.boxes,
          gross_kg: parsed.gross,
          source_text: parsed.sourceText,
          media_group_id: mgid ?? null,
        });

        if (mgid) albumMap.set(mgid, shipmentId);

        const ph = msg.photo as Array<any>;
        const best = ph[ph.length - 1];

        // Загрузка в Storage
        let storagePath: string | null = null;
        try {
          storagePath = buildStoragePath(parsed.clientCode, shipmentId, best.file_unique_id);
          await uploadPhotoToStorage(bot, best.file_id, storagePath);
        } catch (e) {
          console.error('storage upload failed', e);
          storagePath = null;
        }

        await addPhoto(shipmentId, {
          file_id: best.file_id,
          file_unique_id: best.file_unique_id,
          width: best.width,
          height: best.height,
          file_size: best.file_size,
          storage_path: storagePath,
        });

        // Ответ менеджеру с кнопками
        await ctx.reply(`✅ Заявка создана: ${parsed.clientCode}. Фото сохранено.`, kb(shipmentId));

        // Уведомления: альбом после debounce, одиночное — сразу
        if (mgid) {
          debounceOnce(`create:${mgid}`, () => {
            notifyAll(bot, shipmentId, {
              actorId,
              event: 'created',
              withPhotos: SEND_PHOTOS_ON_CREATED,
            }).catch(() => {});
          });
        } else {
          await notifyAll(bot, shipmentId, {
            actorId,
            event: 'created',
            withPhotos: SEND_PHOTOS_ON_CREATED,
          });
        }
        return;
      }

      // ── C) Последующие кадры альбома (без подписи) ──────────────
      if (mgid && albumMap.has(mgid)) {
        const shipmentId = albumMap.get(mgid)!;

        const photos = msg.photo as Array<any>;
        const best = photos[photos.length - 1];

        // узнаём client_code для пути
        let clientCode: string | undefined;
        try {
          const { data: s } = await supabase
            .from('shipments')
            .select('clients:client_id(client_code)')
            .eq('id', shipmentId)
            .single();
          const join = (s as any)?.clients;
          clientCode = Array.isArray(join) ? join[0]?.client_code : join?.client_code;
        } catch {}

        let storagePath: string | null = null;
        try {
          if (clientCode) {
            storagePath = buildStoragePath(clientCode, shipmentId, best.file_unique_id);
            await uploadPhotoToStorage(bot, best.file_id, storagePath);
          }
        } catch (e) {
          console.error('storage upload (album tail) failed', e);
        }

        await addPhoto(shipmentId, {
          file_id: best.file_id,
          file_unique_id: best.file_unique_id,
          width: best.width,
          height: best.height,
          file_size: best.file_size,
          storage_path: storagePath,
        });

        // рассылка альбома — после debounce (один раз)
        debounceOnce(`create:${mgid}`, () => {
          notifyAll(bot, shipmentId, {
            actorId,
            event: 'created',
            withPhotos: SEND_PHOTOS_ON_CREATED,
          }).catch(() => {});
        });
        return;
      }

      // иначе: фото без подписи и без связанного альбома — ничего не делаем
    } catch (e) {
      console.error('photo shipment error', e);
      await ctx.reply('⚠️ Фото не удалось сохранить.');
    }
  });

  // ── КНОПКИ ──────────────────────────────────────────────────────
  // Редактирование текста (ForceReply)
  bot.action(/^edit_text:(.+)$/i, requireManager, async (ctx) => {
    await ctx.answerCbQuery();
    const shipmentId = ctx.match?.[1];
    if (!shipmentId) return;

    const { data: s } = await supabase
      .from('shipments')
      .select('id, pallets, boxes, gross_kg, clients:client_id(client_code)')
      .eq('id', shipmentId)
      .single();
    const cj = (s as any).clients;
    const code = Array.isArray(cj) ? cj[0]?.client_code : cj?.client_code;

    await ctx.reply(
      '✏️ Введите исправление:\n' +
      '`CODE BOXES GROSS` или `CODE PALLETS BOXES GROSS`\n\n' +
      `Текущие: ${code ?? '-'} ${(s as any).pallets ?? '-'} ${(s as any).boxes} ${Number((s as any).gross_kg)}\n` +
      `EDIT:${shipmentId}`,
      { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
  });

  // Ответ на ForceReply (редактирование текста)
  bot.on('text', requireManager, async (ctx, next) => {
    const reply = (ctx.message as any)?.reply_to_message?.text as string | undefined;
    if (!reply || !/EDIT:([^\s]+)/i.test(reply)) return next();

    const shipmentId = reply.match(/EDIT:([^\s]+)/i)![1];
    const raw = String((ctx.message as any).text).trim();
    const parts = raw.split(/\s+/);
    if (parts.length < 3 || parts.length > 4) {
      await ctx.reply('Формат: `CODE BOXES GROSS` или `CODE PALLETS BOXES GROSS`', { parse_mode: 'Markdown' });
      return;
    }

    let i = 0;
    const code = parts[i++]!.toUpperCase();
    let pallets: number | null = null;
    let boxes: number;
    let gross: number;

    if (parts.length === 4) {
      pallets = parseInt(parts[i++]!, 10);
      if (Number.isNaN(pallets)) return void ctx.reply('Некорректное число паллет.');
    }
    boxes = parseInt(parts[i++]!, 10);
    gross = parseFloat(parts[i++]!.replace(',', '.'));
    if (Number.isNaN(boxes) || Number.isNaN(gross)) {
      return void ctx.reply('Некорректные числа коробок/веса.');
    }

    try {
      const client = await ensureClientByCode(code);
      const upd: any = { client_id: client.id, boxes, gross_kg: gross };
      if (pallets !== null) upd.pallets = pallets;

      const { error: uerr } = await supabase.from('shipments').update(upd).eq('id', shipmentId);
      if (uerr) throw uerr;

      const text =
        `✅ Исправлено: ${code} · паллет ${pallets ?? '—'} · мест ${boxes} · брутто ${gross.toFixed(2)} кг`;

      await ctx.reply(text, kb(shipmentId)); // всегда новое сообщение с кнопкой

      // Рассылка без фото
      await notifyAll(bot, shipmentId, {
        actorId: ctx.chat!.id,
        event: 'updated',
        withPhotos: false,
      });
    } catch (e: any) {
      console.error('edit apply error', e);
      await ctx.reply('⛔ Не удалось применить изменения: ' + (e?.message ?? 'ошибка'));
    }
  });

  // Перезалить фото (замена)
  bot.action(/^reup_photos:(.+)$/i, requireManager, async (ctx) => {
    await ctx.answerCbQuery('Режим: замена фото. Пришлите новое фото/альбом.');
    const shipmentId = ctx.match?.[1]!;
    pendingReup.set(ctx.chat!.id, shipmentId);
    await ctx.reply(`REUP:${shipmentId}\nПришлите новое фото/альбом в ответ на это сообщение.`, {
      reply_markup: { force_reply: true },
    });
  });

  // Добавить фото
  bot.action(/^add_photos:(.+)$/i, requireManager, async (ctx) => {
    await ctx.answerCbQuery('Режим: добавление фото. Пришлите фото/альбом.');
    const shipmentId = ctx.match?.[1]!;
    pendingAdd.set(ctx.chat!.id, shipmentId);
    await ctx.reply(`ADD:${shipmentId}\nПришлите дополнительные фото в ответ на это сообщение.`, {
      reply_markup: { force_reply: true },
    });
  });

  // Удалить ВСЕ фото — шаг 1 (подтверждение)
  bot.action(/^del_photos:(.+)$/i, requireManager, async (ctx) => {
    await ctx.answerCbQuery();
    const shipmentId = ctx.match?.[1]!;
    await ctx.reply(
      `⚠️ Удалить ВСЕ фото у заявки ${shipmentId}? Действие необратимо.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, удалить', `del_photos_confirm:${shipmentId}`)],
        [Markup.button.callback('✖️ Отмена', `del_photos_cancel:${shipmentId}`)],
      ])
    );
  });

  bot.action(/^del_photos_cancel:(.+)$/i, requireManager, async (ctx) => {
    await ctx.answerCbQuery('Отменено');
  });

  // Удалить ВСЕ фото — шаг 2 (выполнение)
  bot.action(/^del_photos_confirm:(.+)$/i, requireManager, async (ctx) => {
    await ctx.answerCbQuery('Удаляю фото…');
    const shipmentId = ctx.match?.[1]!;
    try {
      const { data: all } = await supabase
        .from('shipment_photos')
        .select('id, storage_path')
        .eq('shipment_id', shipmentId);

      if (all && all.length) {
        const paths = all.map((r: any) => r.storage_path).filter(Boolean);
        if (paths.length) {
          await supabase.storage.from(STORAGE_BUCKET).remove(paths);
        }
        await supabase.from('shipment_photos').delete().eq('shipment_id', shipmentId);
      }

      // Сообщение менеджеру с кнопками
      await ctx.reply('🗑 Все фото удалены.', kb(shipmentId));

      // Уведомления без фото
      await notifyAll(bot, shipmentId, {
        actorId: ctx.chat!.id,
        event: 'updated',
        withPhotos: false,
      });
    } catch (e) {
      console.error('delete photos error', e);
      await ctx.reply('⛔ Не удалось удалить фото.');
    }
  });
}
