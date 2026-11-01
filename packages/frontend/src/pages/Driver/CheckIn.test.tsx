import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceRecord } from '@/pages/Attendance/api'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { createQrReader } from './scanner'

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'attendance:read', 'attendance:write', 'attendance:check-in'])
const CODE = 'FMSA1.1b4e28ba-2fa1-4d2b-883f-0016d3cca427.59344050.c2lnbmF0dXJlLW9mLWNvZGU'

function record(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: 'a-1',
    status: 'present',
    notes: null,
    check_in_at: null,
    check_in_method: null,
    check_out_at: null,
    check_out_method: null,
    logged_by: 'u-1',
    logged_by_name: 'Sam Tester',
    created_at: '2026-10-31T04:52:00Z',
    updated_at: '2026-10-31T04:52:00Z',
    ...overrides,
  }
}

/** The driver's own line today, and the scan endpoint answering `answer`; records what was sent. */
function serve(today: AttendanceRecord | null, answer: () => Response) {
  const sent: unknown[] = []
  server.use(
    http.get('/api/v1/attendance', () => envelope([{ driver_id: 'dr-1', full_name: 'Sam Tester', email: 'sam@fms.local', depot_id: 'd-1', license_status: 'valid', date: '2026-10-31', attendance: today }])),
    http.post('/api/v1/attendance/check-in', async ({ request }) => {
      sent.push(await request.json())
      return answer()
    }),
  )
  return sent
}

/** A camera whose frames hold, in turn, `frames` (null: no code in view); or one the browser refuses. */
function mockCamera(frames: (string | null)[], refuse?: string) {
  const stop = vi.fn()
  const getUserMedia = vi.fn(() =>
    refuse ? Promise.reject(Object.assign(new Error(refuse), { name: refuse })) : Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
  )
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  let i = 0
  vi.stubGlobal(
    'BarcodeDetector',
    class {
      static getSupportedFormats = async () => ['qr_code']
      async detect() {
        const frame = frames[Math.min(i++, frames.length - 1)]
        return frame ? [{ rawValue: frame }] : []
      }
    },
  )
  return { stop, getUserMedia }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
})

async function scan() {
  signedInAs(driver)
  renderApp('/driver/check-in')
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Scan depot code|Scan to check out/ }))
}

describe('S-25 Check in (FMS-141)', () => {
  it('scans the depot code with the back camera and checks in; another QR in view is not sent', async () => {
    const sent = serve(null, () => envelope({ action: 'checked_in', attendance: record({ check_in_at: '2026-10-31T04:52:00Z', check_in_method: 'qr' }) }))
    const camera = mockCamera([null, 'https://example.com/menu', CODE])
    await scan()

    expect(await screen.findByRole('heading', { name: 'Checked in at 07:52' })).toBeInTheDocument()
    expect(screen.getByText('You are on time. Have a good day.')).toBeInTheDocument()
    expect(sent).toEqual([{ code: CODE }])
    expect(camera.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    // The camera is released once the code is read.
    expect(camera.stop).toHaveBeenCalled()
  })

  it('once checked in, the next scan checks out; a refusal says why in the driver’s words', async () => {
    let refuse = true
    serve(record({ check_in_at: '2026-10-31T04:52:00Z', check_in_method: 'qr' }), () =>
      refuse
        ? errorEnvelope(400, 'VALIDATION_FAILED', 'expired', [{ field: 'code', reason: 'expired' }])
        : envelope({ action: 'checked_out', attendance: record({ check_in_at: '2026-10-31T04:52:00Z', check_out_at: '2026-10-31T14:04:00Z', check_in_method: 'qr', check_out_method: 'qr' }) }),
    )
    mockCamera([CODE])
    await scan()
    expect(await screen.findByText('The code changed before it reached the server. Scan it again.')).toBeInTheDocument()

    refuse = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan to check out' }))
    expect(await screen.findByRole('heading', { name: 'Checked out at 17:04' })).toBeInTheDocument()
  })

  it('a blocked camera says how to allow it, or to ask the supervisor', async () => {
    serve(null, () => HttpResponse.json({}))
    mockCamera([], 'NotAllowedError')
    await scan()
    expect(await screen.findByRole('heading', { name: 'Camera blocked' })).toBeInTheDocument()
    expect(screen.getByText(/ask your supervisor to record your arrival/)).toBeInTheDocument()
  })

  it('with no signal it refuses at once: codes expire, so a scan cannot wait', async () => {
    serve(null, () => HttpResponse.json({}))
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    signedInAs(driver)
    renderApp('/driver/check-in')
    expect(await screen.findByRole('heading', { name: 'No signal' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Scan depot code' })).not.toBeInTheDocument()
  })

  it('My day shows whether the driver has checked in, and leads to the scan', async () => {
    serve(record({ status: 'late', check_in_at: '2026-10-31T05:31:00Z', check_in_method: 'qr' }), () => HttpResponse.json({}))
    server.use(http.get('/api/v1/trips', () => envelope([])))
    signedInAs(driver)
    renderApp('/driver')
    const link = await screen.findByRole('link', { name: /Check out/ })
    await waitFor(() => expect(link).toHaveTextContent('Checked in at 08:31 · late'))
    expect(link).toHaveAttribute('href', '/driver/check-in')
  })
})

describe('the QR reader', () => {
  it("uses the browser's BarcodeDetector where it reads QR codes, jsQR otherwise", async () => {
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats = async () => ['qr_code']
      async detect() {
        return []
      }
    })
    expect((await createQrReader()).kind).toBe('native')
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats = async () => ['ean_13']
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect((await createQrReader()).kind).toBe('js')
    vi.stubGlobal('BarcodeDetector', undefined)
    expect((await createQrReader()).kind).toBe('js')
  })
})
