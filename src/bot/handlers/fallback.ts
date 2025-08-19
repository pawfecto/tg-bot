import { Telegraf } from 'telegraf';
import { supabase } from '../../lib/supabase';

export function registerFallback(bot: Telegraf) {
  bot.on('text', async (ctx) => {
    const { data: tu } = await supabase.from('tg_users').select('is_verified').eq('telegram_id', ctx.from?.id ?? -1).maybeSingle();
    if (!tu?.is_verified) {
      await ctx.reply('Чтобы продолжить, поделитесь номером телефона:', {
        reply_markup: { keyboard: [[{ text: '📱 Отправить телефон', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
      });
      return;
    }
    await ctx.reply('👍 Принято.');
  });
}
