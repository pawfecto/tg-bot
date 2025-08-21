// src/lib/notifymg.ts
import { Telegraf } from 'telegraf';
import { supabase } from './supabase';
import { loadShipmentSummary, makeCaption, recipientsByClientId } from './shipments';

export async function recipientsManagersAll(): Promise<number[]> {
  const { data, error } = await supabase
    .from('tg_users')
    .select('telegram_id')
    .in('role', ['manager', 'admin'])
    .eq('is_verified', true);
  if (error) throw error;
  return (data ?? []).map((u: any) => Number(u.telegram_id));
}

export async function recipientsManagersForClient(clientId: string): Promise<number[]> {
  const { data: mcs, error: e1 } = await supabase
    .from('manager_clients')
    .select('manager_tg_user_id')
    .eq('client_id', clientId);
  if (e1) throw e1;

  const ids = (mcs ?? []).map((r: any) => r.manager_tg_user_id);
  if (ids.length === 0) return [];

  const { data: mgrs, error: e2 } = await supabase
    .from('tg_users')
    .select('telegram_id, role, is_verified')
    .in('id', ids);
  if (e2) throw e2;

  return (mgrs ?? [])
    .filter((u: any) => (u.role === 'manager' || u.role === 'admin') && u.is_verified)
    .map((u: any) => Number(u.telegram_id));
}

type NotifyOpts = {
  managers?: 'all' | 'by_client' | 'none';
  includeClient?: boolean;
  /** created → по умолчанию с фото; updated → по умолчанию без фото */
  event?: 'created' | 'updated';
  /** Явно включить/выключить отправку фото (перекрывает поведение по умолчанию) */
  withPhotos?: boolean;
  /** Исключить этих получателей (например, автора правки) */
  excludeChatIds?: number[];
  /** Сколько фото максимум (ограничение Telegram — 10) */
  maxPhotos?: number;
  /** Полезно, если хочешь вписать изменения в caption (makeCaption поддерживает) */
  changes?: Partial<{ code: string; pallets: number; boxes: number; gross: number }>;
};

export async function notifyShipment(bot: Telegraf, shipmentId: string, opts: NotifyOpts = {}) {
  const {
    managers = 'all',
    includeClient = true,
    event = 'created',
    maxPhotos = 10,
    excludeChatIds = [],
    withPhotos,
    changes,
  } = opts;

  const { s, client, photos } = await loadShipmentSummary(shipmentId);

  // поведение по умолчанию для фото
  const sendPhotos = typeof withPhotos === 'boolean'
    ? withPhotos
    : (event === 'created');

  const caption = makeCaption({
    clientCode: client.client_code,
    fullName: client.full_name,
    pallets: (s as any).pallets ?? undefined,
    boxes: (s as any).boxes,
    gross: Number((s as any).gross_kg),
    event,
    changes,
    created_at: (s as any).created_at ?? null,
    updated_at: (s as any).updated_at ?? null,
  });

  const toClients  = includeClient ? await recipientsByClientId(s.client_id) : [];
  const toManagers =
    managers === 'all'       ? await recipientsManagersAll()
  : managers === 'by_client' ? await recipientsManagersForClient(s.client_id)
  : [];

  // дедуп + исключения (не уведомляем автора правки)
  const excluded = new Set<number>(excludeChatIds);
  const recipients = Array.from(new Set<number>([...toClients, ...toManagers]))
    .filter((id) => !excluded.has(id));

  if (recipients.length === 0) return;

  const list = photos.slice(0, Math.min(maxPhotos, 10));
  const canSendAlbum = sendPhotos && list.length > 1;
  const singlePhoto  = sendPhotos && list.length === 1 ? list[0] : null;

  for (const chatId of recipients) {
    try {
      if (!sendPhotos || list.length === 0) {
        await bot.telegram.sendMessage(chatId, caption);
      } else if (singlePhoto) {
        await bot.telegram.sendPhoto(chatId, singlePhoto.telegram_file_id, { caption });
      } else {
        const media = list.map((p: any, i: number) => ({
          type: 'photo' as const,
          media: p.telegram_file_id,
          ...(i === 0 ? { caption } : {}),
        }));
        await bot.telegram.sendMediaGroup(chatId, media);
      }
    } catch {
      // пропустим сбои доставки, чтобы не падал весь цикл
    }
  }
}
