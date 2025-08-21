import 'telegraf';

declare module 'telegraf' {
  // что будет доступно как ctx.session.editId
  interface SessionData {
    editId?: string;
  }
}
