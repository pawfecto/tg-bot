import { supabase } from './supabase';
import { findClientByCode, findTgUser } from './shipments';

const active = new Map<number, string>(); // telegram_id -> shipment_id

export function getActiveIntake(telegramId: number) { return active.get(telegramId); }
export function clearActiveIntake(telegramId: number) { active.delete(telegramId); }

export async function startIntake(telegramId: number, clientCode: string, reference?: string) {
  const client = await findClientByCode(clientCode);
  if (!client) throw new Error(`Клиент ${clientCode} не найден`);
  const me = await findTgUser(telegramId);
  const { data, error } = await supabase.from('shipments').insert({
    client_id: client.id,
    created_by_tg_user_id: me?.id ?? null,
    pallets: 0, boxes: 0, gross_kg: 0,
    status: 'draft',
    reference: reference ?? null,
    source_text: reference ?? 'intake session'
  }).select('id').single();
  if (error) throw error;
  active.set(telegramId, data!.id);
  return { shipmentId: data!.id, client };
}
export async function addItem(telegramId: number, pallets: number, boxes: number, gross: number) {
  const sid = active.get(telegramId);
  if (!sid) throw new Error('Нет активной приёмки');
  const me = await findTgUser(telegramId);
  const { error } = await supabase.from('shipment_items').insert({
    shipment_id: sid, pallets, boxes, gross_kg: gross, created_by_tg_user_id: me?.id ?? null
  });
  if (error) throw error;
  return sid;
}
export async function finalizeIntake(shipmentId: string) {
  const { data: rows, error } = await supabase.from('shipment_items').select('pallets, boxes, gross_kg').eq('shipment_id', shipmentId);
  if (error) throw error;
  const tot = (rows??[]).reduce((a:any,r:any)=>({ pallets:a.pallets+(r.pallets||0), boxes:a.boxes+(r.boxes||0), gross:a.gross+Number(r.gross_kg||0)}),{pallets:0,boxes:0,gross:0});
  const { error: up } = await supabase.from('shipments').update({ pallets: tot.pallets, boxes: tot.boxes, gross_kg: tot.gross, status: 'confirmed', received_at: new Date().toISOString() }).eq('id', shipmentId);
  if (up) throw up;
  return tot;
}
