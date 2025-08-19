import pino from 'pino';
import { ENV } from './env';

export const logger = pino({
  level: ENV.NODE_ENV === 'development' ? 'debug' : 'info',
  transport: ENV.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined
});
