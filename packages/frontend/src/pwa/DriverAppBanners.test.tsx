import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentUser, renderApp, signedInAs } from '@/test/auth'
import { linkDriverManifest, registerDriverServiceWorker, shareSessionWithWorker } from './useDriverPwa'

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read'])
const dispatcher = currentUser(['dispatcher'], ['trip:assign', 'trip:read', 'depot:read'])

/** Chrome's install offer, as the page receives it. */
function installOffer(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
  event.prompt = vi.fn(async () => {})
  event.userChoice = Promise.resolve({ outcome })
  return event
}

const manifestLink = () => document.head.querySelector('link[rel="manifest"]')

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('driver app shell (FMS-34)', () => {
  it('the driver portal links the manifest; staff screens never do', async () => {
    signedInAs(driver)
    const view = renderApp('/driver')
    await screen.findByRole('heading', { name: 'Driver Home' })
    expect(manifestLink()).toHaveAttribute('href', '/manifest.json')
    expect(document.head.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#4F46E5')
    view.unmount()
    expect(manifestLink()).toBeNull()

    signedInAs(dispatcher)
    renderApp('/dispatch')
    await screen.findByRole('heading', { name: 'Dispatch', level: 1 })
    expect(manifestLink()).toBeNull()
  })

  it('shows "You are offline" while the phone has no signal, and hides it when it is back', async () => {
    signedInAs(driver)
    renderApp('/driver')
    await screen.findByRole('heading', { name: 'Driver Home' })
    expect(screen.queryByText('You are offline.')).not.toBeInTheDocument()
    act(() => void window.dispatchEvent(new Event('offline')))
    expect(await screen.findByText('You are offline.')).toBeInTheDocument()
    act(() => void window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(screen.queryByText('You are offline.')).not.toBeInTheDocument())
  })

  it("offers to install when Chrome does, and Install opens Chrome's prompt once", async () => {
    signedInAs(driver)
    renderApp('/driver')
    await screen.findByRole('heading', { name: 'Driver Home' })
    const offer = installOffer()
    act(() => void window.dispatchEvent(offer))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Install' }))
    expect(offer.prompt).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByText('Install FMS Driver')).not.toBeInTheDocument())
  })

  it('"Not now" hides the offer, and it stays hidden next time', async () => {
    signedInAs(driver)
    const first = renderApp('/driver')
    await screen.findByRole('heading', { name: 'Driver Home' })
    act(() => void window.dispatchEvent(installOffer()))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('Install FMS Driver')).not.toBeInTheDocument()
    first.unmount()

    signedInAs(driver)
    renderApp('/driver')
    await screen.findByRole('heading', { name: 'Driver Home' })
    act(() => void window.dispatchEvent(installOffer()))
    expect(screen.queryByText('Install FMS Driver')).not.toBeInTheDocument()
  })
})

describe('service worker wiring', () => {
  it('registers /sw.js for the whole origin in production builds, never in development', async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration)
    const nav = { serviceWorker: { register } } as unknown as Navigator
    expect(await registerDriverServiceWorker(false, nav)).toBeNull()
    expect(register).not.toHaveBeenCalled()
    await registerDriverServiceWorker(true, nav)
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
    // A browser without service workers simply goes without.
    expect(await registerDriverServiceWorker(true, {} as Navigator)).toBeNull()
  })

  it('hands the worker the session it holds once ready, and again when a new worker takes over', async () => {
    const postMessage = vi.fn()
    const listeners: Record<string, () => void> = {}
    const nav = {
      serviceWorker: {
        ready: Promise.resolve({ active: { postMessage } }),
        controller: null,
        addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
        removeEventListener: vi.fn(),
      },
    } as unknown as Navigator
    const session = driver
    const stop = shareSessionWithWorker(session, nav)
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'fms-driver-session', session }))
    listeners.controllerchange()
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2))
    stop()
  })

  it('takes its head tags out again', () => {
    const remove = linkDriverManifest()
    expect(document.head.querySelectorAll('[data-driver-app]')).toHaveLength(3)
    remove()
    expect(document.head.querySelectorAll('[data-driver-app]')).toHaveLength(0)
  })
})
