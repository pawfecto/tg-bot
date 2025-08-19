import { Telegraf } from 'telegraf';
import { normalizePhone } from '../../lib/phone';
import { supabase } from '../../lib/supabase';
import { ENV } from '../../config/env';

export function registerAuthHandlers(bot: Telegraf) {
  bot.start(async (ctx) => {
    await ctx.reply('👋 Привет! Для авторизации поделитесь номером телефона:', {
      reply_markup: { keyboard: [[{ text: '📱 Отправить телефон', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    });
  });

  bot.on('contact', async (ctx) => {
    const c: any = (ctx as any).message?.contact;
    const raw = c?.phone_number as string | undefined;
    const phone = normalizePhone(raw);
    await ctx.reply('🔎 Проверяю номер…', { reply_markup: { remove_keyboard: true } });
    if (!phone) return void ctx.reply('❌ Номер выглядит некорректным.');

    // найти/создать клиента
    const { data: existing } = await supabase.from('clients').select('*').eq('phone_number', phone).maybeSingle();
    if (!existing && ENV.STRICT_MODE) return void ctx.reply('❌ Ваш номер не найден. Напишите в поддержку.');
    let client = existing;
    if (!client) {
      const fullName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null;
      const { data: created, error } = await supabase.from('clients').insert({ phone_number: phone, full_name: fullName }).select('*').single();
      if (error) throw error;
      client = created;
    }
    const u = ctx.from!;
    const { error: upErr } = await supabase.from('tg_users').upsert({
      telegram_id: u.id, client_id: client.id, username: u.username ?? null, first_name: u.first_name ?? null, last_name: u.last_name ?? null,
      phone_number: phone, is_verified: true, last_seen: new Date().toISOString()
    }, { onConflict: 'telegram_id' });
    if (upErr) throw upErr;

    await ctx.reply(`✅ Добро пожаловать, ${client.full_name ?? 'клиент'}!\nВаш клиентский код: ${client.client_code}`);
  });
}
