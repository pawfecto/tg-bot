import { Telegraf } from 'telegraf';
import { supabase } from './supabase';
import {
  loadShipmentSummary,   // уже есть в lib/shipments.ts
  makeCaption,           // уже есть в lib/shipments.ts
  recipientsByClientId   // уже есть в lib/shipments.ts
} from './shipments';

/** Все менеджеры/админы (is_verified = true) */
export async function recipientsManagersAll(): Promise<number[]> {
  const { data, error } = await supabase
    .from('tg_users')
    .select('telegram_id')
    .in('role', ['manager', 'admin'])
    .eq('is_verified', true);
  if (error) throw error;
  return (data ?? []).map((u: any) => Number(u.telegram_id));
}

/** Менеджеры, привязанные к конкретному клиенту через manager_clients */
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
  /** Кого из менеджеров уведомлять: всех ('all'), только привязанных к клиенту ('by_client') или никого ('none') */
  managers?: 'all' | 'by_client' | 'none';
  /** Уведомлять ли самого клиента (всех его подтверждённых tg_users) */
  includeClient?: boolean;
  /** Сколько фото максимум отправлять в альбоме (Telegram лимит 10) */
  maxPhotos?: number;
};

/**
 * Уведомление о поставке:
 * - клиент (если includeClient=true)
 * - менеджеры (все/по клиенту/никто)
 */
export async function notifyShipment(bot: Telegraf, shipmentId: string, opts: NotifyOpts = {}) {
  const { managers = 'all', includeClient = true, maxPhotos = 10 } = opts;

  // Берём сводку и до 10 фото
  const { s, client, photos } = await loadShipmentSummary(shipmentId);
  const caption = makeCaption({
    clientCode: client.client_code,
    fullName: client.full_name,
    pallets: s.pallets,
    boxes: s.boxes,
    gross: Number(s.gross_kg)
  });

  // Получатели
  const toClients  = includeClient ? await recipientsByClientId(s.client_id) : [];
  const toManagers =
    managers === 'all'      ? await recipientsManagersAll()
  : managers === 'by_client' ? await recipientsManagersForClient(s.client_id)
  : [];

  // Дедупликация
  const recipients = Array.from(new Set<number>([...toClients, ...toManagers]));
  if (recipients.length === 0) return;

  // Готовим медиа (до maxPhotos)
  const list = photos.slice(0, Math.min(maxPhotos, 10));
  const sendMediaGroup = list.length > 1;
  const firstPhoto = list[0];

  for (const chatId of recipients) {
    if (list.length === 0) {
      await bot.telegram.sendMessage(chatId, caption);
    } else if (!sendMediaGroup) {
      await bot.telegram.sendPhoto(chatId, firstPhoto.telegram_file_id, { caption });
    } else {
      const media = list.map((p: any, i: number) => ({
        type: 'photo' as const,
        media: p.telegram_file_id,
        ...(i === 0 ? { caption } : {})
      }));
      await bot.telegram.sendMediaGroup(chatId, media);
    }
  }
}
