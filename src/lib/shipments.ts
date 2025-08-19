import { supabase } from './supabase';
import { Telegraf } from 'telegraf';

type ClientRow = { client_code: string; full_name: string|null };
function pickClient(c: ClientRow|ClientRow[]) { return Array.isArray(c) ? c[0] : c; }

export async function ensureClientByCode(clientCode: string, fullName?: string | null) {
  const { data: existing, error: findErr } = await supabase
    .from('clients')
    .select('id, client_code, full_name')
    .eq('client_code', clientCode)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing;

  // нет — создаём минимальную карточку
  const { data: created, error: insErr } = await supabase
    .from('clients')
    .insert({ client_code: clientCode, full_name: fullName ?? null })
    .select('id, client_code, full_name')
    .single();
  if (insErr) throw insErr;
  return created;
}

export async function findClientByCode(code: string) {
  const { data, error } = await supabase.from('clients').select('id, client_code, full_name').eq('client_code', code).maybeSingle();
  if (error) throw error;
  return data;
}
export async function findTgUser(telegramId: number) {
  const { data } = await supabase.from('tg_users').select('id').eq('telegram_id', telegramId).maybeSingle();
  return data;
}
export async function createShipment(args: {
  clientId: string; createdByTgUserId?: string|null;
  pallets: number; boxes: number; gross_kg: number; source_text: string; media_group_id?: string|null;
}) {
  const { data, error } = await supabase.from('shipments').insert({
    client_id: args.clientId,
    created_by_tg_user_id: args.createdByTgUserId ?? null,
    pallets: args.pallets,
    boxes: args.boxes,
    gross_kg: args.gross_kg,
    source_text: args.source_text,
    media_group_id: args.media_group_id ?? null
  }).select('id').single();
  if (error) throw error;
  return data!.id as string;
}
export async function addPhoto(shipmentId: string, p: { file_id: string; file_unique_id?: string; width?: number; height?: number; file_size?: number; storage_path?: string|null }) {
  const { error } = await supabase.from('shipment_photos').insert({
    shipment_id: shipmentId,
    telegram_file_id: p.file_id,
    telegram_file_unique_id: p.file_unique_id ?? null,
    width: p.width ?? null,
    height: p.height ?? null,
    file_size: p.file_size ?? null,
    storage_path: p.storage_path ?? null
  });
  if (error) throw error;
}
export async function recipientsByClientId(clientId: string): Promise<number[]> {
  const { data, error } = await supabase.from('tg_users').select('telegram_id, role, is_verified').eq('client_id', clientId);
  if (error) throw error;
  return (data ?? []).filter((u: any) => u.is_verified && u.role !== 'blocked').map((u: any) => Number(u.telegram_id));
}

export async function loadShipmentSummary(shipmentId: string) {
  const { data: s, error } = await supabase
    .from('shipments')
    .select('id, client_id, pallets, boxes, gross_kg, source_text, media_group_id, clients:client_id(client_code, full_name)')
    .eq('id', shipmentId).single();
  if (error) throw error;
  const { data: photos } = await supabase.from('shipment_photos').select('telegram_file_id').eq('shipment_id', shipmentId).order('id', { ascending: true }).limit(10);
  return { s, client: pickClient(s.clients as any), photos: photos ?? [] };
}
export function makeCaption(opts: { clientCode: string; fullName?: string|null; pallets: number; boxes: number; gross: number }) {
  const name = opts.fullName ? ` (${opts.fullName})` : '';
  return `📦 Груз поступил на склад\nКлиент: ${opts.clientCode}${name}\nПаллет: ${opts.pallets}\nМест: ${opts.boxes}\nБрутто: ${opts.gross.toFixed(2)} кг`;
}
export async function notifyClientsForShipment(bot: Telegraf, shipmentId: string) {
  const { s, client, photos } = await loadShipmentSummary(shipmentId);
  const cap = makeCaption({ clientCode: client.client_code, fullName: client.full_name, pallets: s.pallets, boxes: s.boxes, gross: Number(s.gross_kg) });
  const to = await recipientsByClientId(s.client_id);
  for (const chatId of to) {
    if (photos.length === 0) await bot.telegram.sendMessage(chatId, cap);
    else if (photos.length === 1) await bot.telegram.sendPhoto(chatId, photos[0].telegram_file_id, { caption: cap });
    else await bot.telegram.sendMediaGroup(chatId, photos.map((p:any, i:number)=>({ type:'photo' as const, media:p.telegram_file_id, ...(i===0?{caption:cap}:{}) })));
  }
}
