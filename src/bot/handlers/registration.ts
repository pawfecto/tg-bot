// src/bot/handlers/registration.ts
import { Telegraf, Context, Markup } from 'telegraf';
import { supabase } from '../../lib/supabase';

type Country = 'ru' | 'kz' | 'uz' | 'kg';
type Delivery = 'warehouse' | 'home';

type RegState = {
  phone: string;
  country?: Country;
  delivery?: Delivery;
  address?: string;
  step?: 'address';
};

export type MySession = { reg?: RegState };
export type MyContext = Context & { session: MySession };

function asMy(ctx: Context): MyContext {
  return ctx as MyContext;
}

function normalizePhone(input?: string | null): string | null {
  if (!input) return null;
  let s = input.trim();
  if (s.startsWith('00')) s = '+' + s.slice(2);
  s = s.replace(/[^\d+]/g, '');
  if (!s.startsWith('+')) s = '+' + s;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return s;
}

function isOwnContact(ctx: Context): boolean {
  const c: any = (ctx as any).message?.contact;
  const fromId = (ctx.from as any)?.id;
  if (c?.user_id && fromId) return c.user_id === fromId;
  return true;
}

const countryButtons = Markup.inlineKeyboard([
  [Markup.button.callback('🇷🇺 Россия', 'reg:country:ru'), Markup.button.callback('🇰🇿 Казахстан', 'reg:country:kz')],
  [Markup.button.callback('🇺🇿 Узбекистан', 'reg:country:uz'), Markup.button.callback('🇰🇬 Киргизстан', 'reg:country:kg')],
]);

const deliveryButtons = Markup.inlineKeyboard([
  [Markup.button.callback('🏬 До склада', 'reg:delivery:warehouse'), Markup.button.callback('🏠 До дома', 'reg:delivery:home')],
  [Markup.button.callback('↩️ Отменить', 'reg:cancel')],
]);

const PREFIX: Record<Country, string> = { ru: 'SR', kz: 'SA', uz: 'ST', kg: 'SB' };

async function generateNextClientCode(prefix: string): Promise<string> {
  const { data, error } = await supabase
    .from('clients')
    .select('client_code')
    .ilike('client_code', `${prefix}%`)
    .order('client_code', { ascending: false })
    .limit(1);
  if (error) throw error;

  let next = 1;
  if (data?.length) {
    const last = data[0].client_code || '';
    const m = String(last).match(/(\d+)$/);
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(next).padStart(3, '0')}`;
}

async function createClientSafely(args: {
  phone: string;
  fullName: string | null;
  country: Country;
  delivery: Delivery;
  address?: string | null;
}) {
  const prefix = PREFIX[args.country];
  for (let i = 0; i < 5; i++) {
    const code = await generateNextClientCode(prefix);
    const payload: any = {
      client_code: code,
      phone_number: args.phone,
      full_name: args.fullName,
      country: args.country,                 // убедитесь, что эти колонки есть в clients
      delivery_type: args.delivery,          // country TEXT, delivery_type TEXT, delivery_address TEXT NULL
      delivery_address: args.address ?? null
    };

    const { data, error } = await supabase
      .from('clients')
      .insert(payload)
      .select('id, client_code, full_name, country, delivery_type, delivery_address')
      .single();

    if ((error as any)?.code === '23505') continue; // повтор при конфликте
    if (error) throw error;
    return data!;
  }
  throw new Error('Не удалось сгенерировать уникальный клиентский код');
}

async function linkTgUserToClient(ctx: Context, client: any, phone: string) {
  const u = (ctx.from ?? {}) as any;
  const { error } = await supabase.from('tg_users').upsert(
    {
      telegram_id: u.id,
      client_id: client.id,
      username: u.username ?? null,
      first_name: u.first_name ?? null,
      last_name: u.last_name ?? null,
      phone_number: phone,
      is_verified: true,
      last_seen: new Date().toISOString(),
    },
    { onConflict: 'telegram_id' }
  );
  if (error) throw error;
}

async function findClientByPhone(phone: string) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, client_code, full_name, country, delivery_type, delivery_address')
    .eq('phone_number', phone)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function fullNameFromCtx(ctx: Context): string | null {
  const fn = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim();
  return fn || null;
}

export function registerRegistration(bot: Telegraf) {
  // ВАЖНО: здесь НЕТ bot.use(session(...)) — он должен быть ОДИН раз в index.ts

  // /start
  bot.start(async (ctx) => {
    await ctx.reply(
      '👋 Привет! Для регистрации/входа поделитесь номером телефона:',
      Markup.keyboard([[{ text: '📱 Отправить телефон', request_contact: true }]])
        .oneTime()
        .resize()
    );
  });

  // контакт
  bot.on('contact', async (ctx) => {
    try {
      if (!isOwnContact(ctx)) {
        await ctx.reply('⚠️ Пожалуйста, отправьте свой номер, а не чужой.');
        return;
      }

      await ctx.reply('🔎 Проверяю номер…', { reply_markup: { remove_keyboard: true } });

      const raw = (ctx as any).message?.contact?.phone_number as string | undefined;
      const phone = normalizePhone(raw);
      if (!phone) {
        await ctx.reply('❌ Номер выглядит некорректным. Попробуйте снова через /start.');
        return;
      }

      const existing = await findClientByPhone(phone);
      if (existing) {
        await linkTgUserToClient(ctx, existing, phone);
        await ctx.reply(
          `✅ Добро пожаловать, ${existing.full_name ?? 'клиент'}!\nВаш клиентский код: ${existing.client_code}`
        );
        asMy(ctx).session.reg = undefined;
        return;
      }

      asMy(ctx).session.reg = { phone };
      await ctx.reply('🌍 Выберите страну:', countryButtons);
    } catch (e) {
      console.error('registration contact error', e);
      await ctx.reply('⛔ Ошибка при проверке номера. Попробуйте позже.');
    }
  });

  // страна
  bot.action(/^reg:country:(ru|kz|uz|kg)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const country = ctx.match![1] as Country;

    const c = asMy(ctx);
    if (!c.session.reg?.phone) {
      await ctx.reply('Сессия регистрации не найдена. Нажмите /start.');
      return;
    }
    c.session.reg.country = country;

    await ctx.editMessageText('🚚 Доставка: до склада или до дома?', { reply_markup: undefined });
    await ctx.reply('Выберите тип доставки:', deliveryButtons);
  });

  // отмена
  bot.action('reg:cancel', async (ctx) => {
    await ctx.answerCbQuery('Отменено');
    asMy(ctx).session.reg = undefined;
    await ctx.reply('Регистрация отменена. Нажмите /start, чтобы начать заново.');
  });

  // доставка
  bot.action(/^reg:delivery:(warehouse|home)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const delivery = ctx.match![1] as Delivery;

    const c = asMy(ctx);
    if (!c.session.reg?.phone || !c.session.reg?.country) {
      await ctx.reply('Сессия регистрации не найдена. Нажмите /start.');
      return;
    }

    c.session.reg.delivery = delivery;

    if (delivery === 'home') {
      c.session.reg.step = 'address';
      await ctx.reply('🏠 Введите адрес доставки (одной строкой):', { reply_markup: { force_reply: true } });
    } else {
      await finalizeRegistration(c);
    }
  });

  // адрес
  bot.on('text', async (ctx, next) => {
    const c = asMy(ctx);
    const reg = c.session.reg;
    if (!reg || reg.step !== 'address') return next();

    const txt = (ctx.message as any).text?.trim();
    if (!txt) {
      await ctx.reply('Пожалуйста, отправьте текстовый адрес.');
      return;
    }

    c.session.reg.address = txt;
    reg.step = undefined;
    await finalizeRegistration(c);
  });
}

async function finalizeRegistration(ctx: MyContext) {
  try {
    const reg = ctx.session.reg!;
    if (!reg?.phone || !reg?.country || !reg?.delivery) {
      await ctx.reply('⚠️ Не хватает данных регистрации. Нажмите /start.');
      ctx.session.reg = undefined;
      return;
    }

    const fullName = fullNameFromCtx(ctx);
    const client = await createClientSafely({
      phone: reg.phone,
      fullName,
      country: reg.country,
      delivery: reg.delivery,
      address: reg.delivery === 'home' ? (reg.address ?? null) : null,
    });

    await linkTgUserToClient(ctx, client, reg.phone);

    const countryLabel =
      reg.country === 'ru' ? 'Россия' :
      reg.country === 'kz' ? 'Казахстан' :
      reg.country === 'uz' ? 'Узбекистан' : 'Киргизстан';

    const deliveryLabel =
      reg.delivery === 'home'
        ? `До дома${client.delivery_address ? `: ${client.delivery_address}` : ''}`
        : 'До склада';

    await ctx.reply(
      `✅ Регистрация завершена!\n` +
      `Код клиента: ${client.client_code}\n` +
      `Страна: ${countryLabel}\n` +
      `Доставка: ${deliveryLabel}`
    );

    ctx.session.reg = undefined;
  } catch (e: any) {
    console.error('finalize registration error', e);
    await ctx.reply('⛔ Не удалось завершить регистрацию. Попробуйте позже.');
  }
}
