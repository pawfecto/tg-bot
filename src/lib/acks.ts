// src/lib/acks.ts
export type Ack = { chatId: number; messageId: number };

// shipmentId -> (chatId -> Ack)
const acks = new Map<string, Map<number, Ack>>();

export function rememberAck(shipmentId: string, chatId: number, messageId: number) {
  let byChat = acks.get(shipmentId);
  if (!byChat) {
    byChat = new Map();
    acks.set(shipmentId, byChat);
  }
  byChat.set(chatId, { chatId, messageId });
}

export function getAck(shipmentId: string, chatId?: number): Ack | undefined {
  const byChat = acks.get(shipmentId);
  if (!byChat) return undefined;
  if (typeof chatId === 'number') return byChat.get(chatId);
  // fallback: последний добавленный
  let last: Ack | undefined;
  for (const v of byChat.values()) last = v;
  return last;
}

export function forgetAck(shipmentId: string, chatId?: number) {
  const byChat = acks.get(shipmentId);
  if (!byChat) return;
  if (typeof chatId === 'number') {
    byChat.delete(chatId);
    if (byChat.size === 0) acks.delete(shipmentId);
  } else {
    acks.delete(shipmentId);
  }
}
