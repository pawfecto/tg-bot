// src/lib/date.ts

/**
 * Возвращает дату в формате YYYY-MM-DD по таймзоне Asia/Seoul.
 * Если аргумент не передан — берётся "сегодня".
 */
export function dayKST(d?: Date | string | number): string {
  const date = d !== undefined ? new Date(d) : new Date();
  return date.toLocaleString('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

/** Начало суток (00:00:00) в KST, как объект Date в UTC (опционально) */
export function startOfKSTDay(d?: Date | string | number): Date {
  const day = dayKST(d); // YYYY-MM-DD по KST
  // создаём дату из строки как UTC-полуночь этой календарной даты (KST)
  return new Date(`${day}T00:00:00+09:00`);
}

/** Конец суток (23:59:59.999) в KST, как объект Date в UTC (опционально) */
export function endOfKSTDay(d?: Date | string | number): Date {
  const day = dayKST(d);
  return new Date(`${day}T23:59:59.999+09:00`);
}
