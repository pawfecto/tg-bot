// src/lib/shipments.ts
import { supabase } from './supabase';

// ─────────────────────────────────────────────────────
// Helpers & Types
// ─────────────────────────────────────────────────────
type ClientRow = { client_code: string; full_name: string | null };
function pickClient(c: ClientRow | ClientRow[]) {
  return Array.isArray(c) ? c[0] : c;
}

// ─────────────────────────────────────────────────────
// Clients
// ─────────────────────────────────────────────────────
export async function ensureClientByCode(clientCode: string, fullName?: string | null) {
  const code = String(clientCode).trim(); // не форсирую toUpperCase — у тебя коды бывают с буквами/дефисами в разном регистре
  const { data: existing, error: findErr } = await supabase
    .from('clients')
    .select('id, client_code, full_name')
    .eq('client_code', code)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing;

  // нет — создаём минимальную карточку
  const { data: created, error: insErr } = await supabase
    .from('clients')
    .insert({ client_code: code, full_name: fullName ?? null }) // phone_number должен быть NULLABLE
    .select('id, client_code, full_name')
    .single();
  if (insErr) throw insErr;
  return created;
}

export async function findClientByCode(code: string) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, client_code, full_name')
    .eq('client_code', code)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────────────
// Telegram users
// ─────────────────────────────────────────────────────
export async function findTgUser(telegramId: number) {
  const { data } = await supabase
    .from('tg_users')
    .select('id')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return data;
}

export async function recipientsByClientId(clientId: string): Promise<number[]> {
  const { data, error } = await supabase
    .from('tg_users')
    .select('telegram_id, role, is_verified')
    .eq('client_id', clientId);
  if (error) throw error;
  return (data ?? [])
    .filter((u: any) => u.is_verified && u.role !== 'blocked')
    .map((u: any) => Number(u.telegram_id));
}

// ─────────────────────────────────────────────────────
// Shipments
// ─────────────────────────────────────────────────────
export async function createShipment(args: {
  clientId: string;
  createdByTgUserId?: string | null;
  pallets: number;
  boxes: number;
  gross_kg: number;
  source_text: string;
  media_group_id?: string | null;
}) {
  const { data, error } = await supabase
    .from('shipments')
    .insert({
      client_id: args.clientId,
      created_by_tg_user_id: args.createdByTgUserId ?? null,
      pallets: args.pallets,
      boxes: args.boxes,
      gross_kg: args.gross_kg,
      source_text: args.source_text,
      media_group_id: args.media_group_id ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data!.id as string;
}

export async function addPhoto(
  shipmentId: string,
  p: {
    file_id: string;
    file_unique_id?: string;
    width?: number;
    height?: number;
    file_size?: number;
    storage_path?: string | null;
  }
) {
  const { error } = await supabase.from('shipment_photos').insert({
    shipment_id: shipmentId,
    telegram_file_id: p.file_id,
    telegram_file_unique_id: p.file_unique_id ?? null,
    width: p.width ?? null,
    height: p.height ?? null,
    file_size: p.file_size ?? null,
    storage_path: p.storage_path ?? null,
  });
  if (error) throw error;
}

// Возвращает сводку + фото (до 10) в хронологическом порядке
export async function loadShipmentSummary(shipmentId: string) {
  const { data: s, error } = await supabase
    .from('shipments')
    .select(`
      id, client_id, pallets, boxes, gross_kg, source_text, media_group_id,
      created_at, updated_at,
      clients:client_id ( client_code, full_name )
    `)
    .eq('id', shipmentId)
    .maybeSingle();
  if (error || !s) throw (error ?? new Error('shipment not found'));

  const { data: photos } = await supabase
    .from('shipment_photos')
    .select('telegram_file_id, created_at')
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: true })
    .limit(10);

  return {
    s,
    client: pickClient((s as any).clients as any),
    photos: photos ?? [],
  };
}

// ─────────────────────────────────────────────────────
// Caption builder (расширенный, но обратно совместимый)
// ─────────────────────────────────────────────────────
type CaptionBase = {
  clientCode: string;
  fullName?: string | null;
  pallets?: number | null | undefined;
  boxes: number;
  gross: number;
};
type CaptionExt = CaptionBase & {
  event?: 'created' | 'updated';
  changes?: Partial<{ code: string; pallets: number; boxes: number; gross: number }>;
  created_at?: string | null;
  updated_at?: string | null;
};

function kst(dt?: string | null) {
  if (!dt) return '';
  try {
    return new Date(dt).toLocaleString('ru-RU', { timeZone: 'Asia/Seoul' });
  } catch {
    return dt ?? '';
  }
}

/** По умолчанию ведёт себя как раньше (если не передавать event/changes). */
export function makeCaption(opts: CaptionExt | CaptionBase) {
  const base = opts as CaptionExt;
  const lines: string[] = [];

  if (base.event === 'updated') {
    lines.push('✏️ Обновление по грузу');
  } else {
    lines.push('📦 Груз поступил на склад');
  }

  const name = base.fullName ? ` (${base.fullName})` : '';
  lines.push(`Клиент: ${base.clientCode}${name}`);
  if (base.pallets != null) lines.push(`Паллет: ${base.pallets}`);
  lines.push(`Мест: ${base.boxes}`);
  lines.push(`Брутто: ${Number(base.gross).toFixed(2)} кг`);

  if (base.event === 'updated') {
    if (base.updated_at) lines.push(`Изменено: ${kst(base.updated_at)}`);
    if (base.changes) {
      const ch: string[] = [];
      if (base.changes.code) ch.push(`код → ${base.changes.code}`);
      if (typeof base.changes.pallets === 'number') ch.push(`паллет → ${base.changes.pallets}`);
      if (typeof base.changes.boxes === 'number') ch.push(`мест → ${base.changes.boxes}`);
      if (typeof base.changes.gross === 'number') ch.push(`брутто → ${base.changes.gross.toFixed(2)}`);
      if (ch.length) lines.push('Изменения: ' + ch.join(', '));
    }
  } else if (base.created_at) {
    lines.push(`Создано: ${kst(base.created_at)}`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// (Опционально) ЛЕГАСИ-функция прямой рассылки клиентам.
// Рекомендуется использовать notifyShipment() из lib/notifymg.ts
// ─────────────────────────────────────────────────────
import { Telegraf } from 'telegraf'; // оставляем импорт, если эта функция где-то ещё используется

export async function notifyClientsForShipment(bot: Telegraf, shipmentId: string) {
  const { s, client, photos } = await loadShipmentSummary(shipmentId);
  const cap = makeCaption({
    clientCode: client.client_code,
    fullName: client.full_name,
    pallets: (s as any).pallets ?? undefined,
    boxes: (s as any).boxes,
    gross: Number((s as any).gross_kg),
    created_at: (s as any).created_at ?? null,
  });
  const to = await recipientsByClientId(s.client_id);
  for (const chatId of to) {
    try {
      if (photos.length === 0) {
        await bot.telegram.sendMessage(chatId, cap);
      } else if (photos.length === 1) {
        await bot.telegram.sendPhoto(chatId, photos[0].telegram_file_id, { caption: cap });
      } else {
        await bot.telegram.sendMediaGroup(
          chatId,
          photos.map((p: any, i: number) => ({
            type: 'photo' as const,
            media: p.telegram_file_id,
            ...(i === 0 ? { caption: cap } : {}),
          }))
        );
      }
    } catch {
      // молча пропускаем ошибок доставки
    }
  }
}
