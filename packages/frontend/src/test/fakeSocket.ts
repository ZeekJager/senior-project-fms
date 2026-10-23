import { act } from '@testing-library/react'

/** Just enough of a socket.io-client Socket: the provider's calls are recorded, the server's events played. */
export class FakeSocket {
  connects = 0
  disconnects = 0
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  private any: ((event: string, payload: unknown) => void)[] = []
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }
  onAny(handler: (event: string, payload: unknown) => void) {
    this.any.push(handler)
    return this
  }
  removeAllListeners() {
    this.handlers.clear()
    this.any = []
    return this
  }
  connect() {
    this.connects += 1
    return this
  }
  disconnect() {
    this.disconnects += 1
    return this
  }
  /** What the server or the transport does. */
  fire(event: string, ...args: unknown[]) {
    act(() => this.handlers.get(event)?.forEach((h) => h(...args)))
  }
  serverEvent(event: string, payload: unknown) {
    act(() => this.any.forEach((h) => h(event, payload)))
  }
}
