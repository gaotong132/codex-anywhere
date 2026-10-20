export type MessageDelivery = {
  id: string;
  environmentId: string;
  selectionVersion: number;
  threadId: string | null;
  status: 'sending' | 'confirmed' | 'unconfirmed';
};

export function adoptDeliveryThread(
  receipt: MessageDelivery | null, environmentId: string, selectionVersion: number, threadId: string,
): MessageDelivery | null {
  // A new thread's event may arrive before the request response. Keep showing
  // pending delivery in that thread, but only the response can confirm it.
  return receipt?.environmentId === environmentId && receipt.selectionVersion === selectionVersion
    && receipt.status === 'sending' && receipt.threadId === null
    ? { ...receipt, threadId } : receipt;
}

export function confirmedDelivery(receipt: MessageDelivery, receivedThreadId: unknown): MessageDelivery {
  // A transport ACK or an empty/mismatched response cannot confirm Codex receipt.
  if (typeof receivedThreadId !== 'string' || !receivedThreadId.trim()
    || (receipt.threadId !== null && receipt.threadId !== receivedThreadId)) {
    throw new Error('session_delivery_mismatch');
  }
  return { ...receipt, threadId: receivedThreadId, status: 'confirmed' };
}

export function visibleDelivery(
  receipt: MessageDelivery | null, environmentId: string, threadId: string | null, selectionVersion: number,
): MessageDelivery | null {
  return receipt?.environmentId === environmentId && receipt.threadId === threadId
    && receipt.selectionVersion === selectionVersion ? receipt : null;
}
