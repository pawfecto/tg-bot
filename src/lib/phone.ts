export function normalizePhone(input?: string | null): string | null {
  if (!input) return null;
  let s = input.trim();
  if (s.startsWith('00')) s = '+' + s.slice(2);
  s = s.replace(/[^\d+]/g, '');
  if (!s.startsWith('+')) s = '+' + s;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return s;
}
