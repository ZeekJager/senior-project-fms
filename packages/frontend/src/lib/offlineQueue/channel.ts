/**
 * Tells every open driver page, and the service worker, that the queue
 * changed (so the pending badge re-reads it) or that a page should send it
 * (the worker could not: it has no way to renew an expired session).
 */

export type QueueMessage = { type: 'changed' } | { type: 'flush' }

const CHANNEL = 'fms-offline-queue'
const local = new Set<(message: QueueMessage) => void>()
let channel: BroadcastChannel | null | undefined

/** Other contexts hear it through the channel; this one directly (a channel never hears itself). */
function shared(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null
    if (channel) channel.onmessage = (event: MessageEvent<QueueMessage>) => local.forEach((handler) => handler(event.data))
  }
  return channel
}

export function announce(message: QueueMessage): void {
  local.forEach((handler) => handler(message))
  shared()?.postMessage(message)
}

/** Returns a function that stops listening. */
export function listen(handler: (message: QueueMessage) => void): () => void {
  shared()
  local.add(handler)
  return () => void local.delete(handler)
}
