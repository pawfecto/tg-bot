import { supabase } from './supabase';
import { ParsedLine } from './parse';
import { dayKST } from './date';

export async function logPhotoLikeExcel(args: {
  parsed: ParsedLine;
  shipmentId: string;
  managerTelegramId: number;
  storagePath?: string | null;
  telegramFileId?: string | null;
}) {
  const net = Number((args.parsed.gross_kg - 6).toFixed(2)); // паллета (-6)
  const { data: me } = await supabase.from('tg_users').select('id').eq('telegram_id', args.managerTelegramId).maybeSingle();
  const { error } = await supabase.from('photo_logs').insert({
    date: dayKST(),                      // день по KST
    code: args.parsed.clientCode,
    pallet_number: args.parsed.pallets,  // считаем, что подпись относится к паллете №N
    ct: args.parsed.boxes,
    gross: args.parsed.gross_kg,
    net,
    note: 'палета (-6 кг)',
    shipment_id: args.shipmentId,
    telegram_file_id: args.telegramFileId ?? null,
    storage_path: args.storagePath ?? null,
    manager_tg_user_id: me?.id ?? null
  });
  if (error) throw error;
}
