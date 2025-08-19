import { supabase } from './supabase';
import { ENV } from '../config/env';
import { Telegraf } from 'telegraf';

function safeCode(code: string) {
  return code.replace(/[\/\\]/g, '_'); // заменим слэш в коде
}

export async function ensureBucket() {
  try { await supabase.storage.createBucket(ENV.STORAGE_BUCKET, { public: false }); } catch {}
}
export function makeStoragePath(clientCode: string, shipmentId: string, unique: string) {
  const day = new Date().toISOString().slice(0, 10);
  return `clients/${safeCode(clientCode)}/${day}/${shipmentId}/${unique}.jpg`;
}
export async function uploadPhotoToStorage(bot: Telegraf, fileId: string, storagePath: string) {
  const link = await bot.telegram.getFileLink(fileId);
  const res = await fetch(link.href);
  if (!res.ok) throw new Error('Telegram file fetch failed');
  const buf = Buffer.from(await res.arrayBuffer());
  const { error } = await supabase.storage.from(ENV.STORAGE_BUCKET).upload(storagePath, buf, {
    contentType: 'image/jpeg',
    upsert: true
  });
  if (error) throw error;
  return storagePath;
}
export async function createSignedUrl(storagePath: string) {
  const { data } = await supabase.storage.from(ENV.STORAGE_BUCKET).createSignedUrl(storagePath, ENV.SIGNED_URL_TTL);
  return data?.signedUrl;
}
