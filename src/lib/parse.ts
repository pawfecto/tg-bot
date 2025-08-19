export type ParsedLine = {
  clientCode: string;
  pallets: number;
  boxes: number;
  gross_kg: number;
  sourceText: string;
};

export function parseShipmentLine(raw?: string): ParsedLine | null {
  if (!raw) return null;
  const text = raw.trim().replace(/\s+/g, ' ');

  // код = первая "слово-последовательность": буквы/цифры/дефис/подчёркивание/точка (например: M255-D, 88880-8829A)
  const re = /^([A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9._-]*)\s+(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)(?:\s|$)/;
  const m = text.match(re);
  if (!m) return null;

  // нормализация кода: заменим начальную кириллическую "С" на латинскую только в паттерне "С + цифры"
  let code = m[1].trim();
  code = code.replace(/^[Сс](?=\d)/, 'C'); // кириллическая C
  code = code.toUpperCase();

  const pallets = parseInt(m[2], 10);
  const boxes   = parseInt(m[3], 10);
  const gross   = parseFloat(m[4].replace(',', '.'));

  if ([pallets, boxes].some(Number.isNaN) || Number.isNaN(gross)) return null;

  return { clientCode: code, pallets, boxes, gross_kg: gross, sourceText: raw.trim() };
}
