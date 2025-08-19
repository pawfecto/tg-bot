import 'dotenv/config';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export const ENV = {
  BOT_TOKEN: need('BOT_TOKEN'),
  SUPABASE_URL: need('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE: need('SUPABASE_SERVICE_ROLE'),
  STORAGE_BUCKET: process.env.STORAGE_BUCKET ?? 'shipments',
  SIGNED_URL_TTL: Number(process.env.SIGNED_URL_TTL ?? 86400),
  STRICT_MODE: String(process.env.STRICT_MODE ?? 'false') === 'true',
  NODE_ENV: process.env.NODE_ENV ?? 'development'
};
