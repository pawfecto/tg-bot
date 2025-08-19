import type { Context, MiddlewareFn } from 'telegraf';
import { logger } from '../../config/logger';


export const errorBoundary = (name: string): MiddlewareFn<Context> =>
  async (ctx, next) => {
    try {
      await next();
    } catch (e: any) {
      logger.error({ err: e, update: ctx.update }, `Handler ${name} failed: ${e?.message}`);
      try { await ctx.reply('⛔ Произошла ошибка. Попробуйте позже.'); } catch {}
    }
};
