import type { Context, MiddlewareFn } from 'telegraf';
import { supabase } from './supabase';


export type Role = 'admin'|'manager'|'user'|'blocked';

export async function getUserRole(telegramId: number): Promise<Role> {
  const { data } = await supabase.from('tg_users').select('role').eq('telegram_id', telegramId).maybeSingle();
  return (data?.role ?? 'user') as Role;
}
export async function isVerified(telegramId: number) {
  const { data } = await supabase.from('tg_users').select('is_verified').eq('telegram_id', telegramId).maybeSingle();
  return !!data?.is_verified;
}
export const requireManager: MiddlewareFn<Context> = async (ctx, next) => {
  const id = ctx.from?.id;
  if (!id) return;
  const ok = await isVerified(id);
  if (!ok) {
    await ctx.reply('Поделитесь номером телефона для авторизации.');
    return;
  }
  const role = await getUserRole(id);
  if (role === 'admin' || role === 'manager') return next();
  await ctx.reply('⛔ Недостаточно прав.');
};
