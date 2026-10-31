import { AlertCircle, CameraOff, CheckCircle2, LogOut, ScanLine, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Skeleton, Spinner } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { ApiError } from '@/lib/api/errors'
import { clockTime, STATUS_LABELS } from '@/pages/Attendance/api'
import { useConnectivity } from '@/pwa/useConnectivity'
import { useCheckIn, useMyAttendance, type CheckInResult } from './api'
import { FormHeader, Note, Panel } from './parts'
import { cameraProblem, createQrReader, isCheckInCode, openCamera, type CameraProblem } from './scanner'

/** How often a frame is read while the camera is open. */
const READ_EVERY_MS = 200

const CAMERA_TEXT: Record<CameraProblem, { title: string; text: string }> = {
  denied: { title: 'Camera blocked', text: 'Allow the camera for this app in your browser settings, then try again. Or ask your supervisor to record your arrival.' },
  unavailable: { title: 'The camera did not open', text: 'Another app may be using it. Close it and try again, or ask your supervisor to record your arrival.' },
  unsupported: { title: 'No camera here', text: 'This browser cannot open the camera. Ask your supervisor to record your arrival.' },
}

/** What the server's refusal means for the driver, in their words. */
function refusal(err: unknown): string {
  if (!(err instanceof ApiError)) return 'The scan did not reach the server. Check your signal and scan again.'
  const reason = err.details[0]?.reason
  if (reason === 'expired') return 'The code changed before it reached the server. Scan it again.'
  if (reason === 'other_depot') return "That is another depot's code. Scan the code at your own depot."
  if (reason === 'invalid') return 'That is not a depot check-in code.'
  if (reason === 'just_checked_in') return 'You are already checked in. Scan again when you leave.'
  if (reason === 'already_checked_out') return 'You have already checked out today.'
  if (err.code === 'CONFLICT_INVALID_STATE_TRANSITION') return 'You are no longer listed as a driver. Ask your supervisor.'
  return `The check-in was not recorded (${err.code}). Ask your supervisor.`
}

type Phase = { kind: 'idle' } | { kind: 'scanning' } | { kind: 'camera'; problem: CameraProblem } | { kind: 'done'; result: CheckInResult }

/**
 * S-25 Check in (FMS-141): the driver scans the code on the depot screen when they arrive, and again when they
 * leave. It needs signal: the code changes every 30 seconds, so a scan cannot wait in the offline queue. Without
 * signal or a camera, the supervisor records it by hand.
 */
export function DriverCheckIn() {
  const { api } = useAuth()
  const online = useConnectivity(api)
  const mine = useMyAttendance()
  const checkIn = useCheckIn()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const record = mine.data ?? null
  const checkedOut = Boolean(record?.check_out_at)
  const leaving = Boolean(record?.check_in_at) && !checkedOut

  async function send(code: string) {
    setPhase({ kind: 'idle' })
    try {
      setPhase({ kind: 'done', result: await checkIn.mutateAsync(code) })
    } catch {
      // Shown under the button.
    }
  }

  function scan() {
    checkIn.reset()
    setPhase({ kind: 'scanning' })
  }

  return (
    <div className="space-y-5">
      <FormHeader title="Check in" />

      {mine.isPending ? (
        <Skeleton className="h-24 w-full rounded-card" />
      ) : (
        <Today record={record} />
      )}

      {phase.kind === 'done' ? (
        <Done result={phase.result} onBack={() => setPhase({ kind: 'idle' })} />
      ) : !online ? (
        <Panel icon={<WifiOff />} title="No signal" tone="neutral">
          Checking in needs signal: the depot code changes every 30 seconds. Ask your supervisor to record your arrival.
        </Panel>
      ) : checkedOut ? (
        <Panel icon={<CheckCircle2 />} title="Done for today" tone="success">
          You checked out at {clockTime(record!.check_out_at!)}. See you tomorrow.
        </Panel>
      ) : phase.kind === 'scanning' ? (
        <Viewfinder onCode={(code) => void send(code)} onProblem={(problem) => setPhase({ kind: 'camera', problem })} onCancel={() => setPhase({ kind: 'idle' })} />
      ) : (
        <div className="space-y-3">
          {phase.kind === 'camera' && (
            <Panel icon={<CameraOff />} title={CAMERA_TEXT[phase.problem].title} tone="danger">
              {CAMERA_TEXT[phase.problem].text}
            </Panel>
          )}
          <button
            type="button"
            onClick={scan}
            disabled={checkIn.isPending}
            aria-busy={checkIn.isPending}
            className="focus-ring flex h-16 w-full items-center justify-center gap-2.5 rounded-2xl bg-brand text-lg font-bold uppercase tracking-wider text-white shadow-soft transition hover:bg-brand-strong active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {checkIn.isPending ? <Spinner className="h-5 w-5" /> : <ScanLine className="h-6 w-6" aria-hidden="true" />}
            {checkIn.isPending ? 'Recording…' : leaving ? 'Scan to check out' : 'Scan depot code'}
          </button>
          <p className="text-center text-sm text-ink-muted">Point the camera at the code on the screen at your depot.</p>
          <div role="alert" className="empty:hidden">
            {checkIn.error != null && (
              <Note tone="danger" icon={<AlertCircle />}>
                {refusal(checkIn.error)}
              </Note>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Today so far: not in yet, in at 07:52 (and how late), out at 17:04. */
function Today({ record }: { record: ReturnType<typeof useMyAttendance>['data'] }) {
  return (
    <section aria-label="Today" className="grid grid-cols-2 gap-3">
      <Stamp label="Checked in" at={record?.check_in_at ?? null} note={record?.check_in_at ? STATUS_LABELS[record.status] : null} />
      <Stamp label="Checked out" at={record?.check_out_at ?? null} note={null} />
    </section>
  )
}

function Stamp({ label, at, note }: { label: string; at: string | null; note: string | null }) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wider text-ink-subtle">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink">{at ? clockTime(at) : '--:--'}</p>
      {note && <p className="text-sm text-ink-muted">{note}</p>}
    </div>
  )
}

function Done({ result, onBack }: { result: CheckInResult; onBack: () => void }) {
  const a = result.attendance
  const out = result.action === 'checked_out'
  const late = !out && a.status === 'late'
  return (
    <div className="space-y-3">
      <Panel icon={out ? <LogOut /> : <CheckCircle2 />} title={out ? `Checked out at ${clockTime(a.check_out_at!)}` : `Checked in at ${clockTime(a.check_in_at!)}`} tone="success">
        {out ? 'Your day is recorded. Drive safe.' : late ? 'Recorded as late: after the depot’s start time.' : 'You are on time. Have a good day.'}
      </Panel>
      <button type="button" onClick={onBack} className="focus-ring flex h-12 w-full items-center justify-center rounded-2xl text-base font-medium text-ink-muted hover:bg-surface">
        Done
      </button>
    </div>
  )
}

/**
 * The camera, reading frames until one holds a depot code. Any other QR in view is ignored. The camera is
 * released when a code is read, on cancel, and when the screen is left.
 */
function Viewfinder({ onCode, onProblem, onCancel }: { onCode: (code: string) => void; onProblem: (problem: CameraProblem) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [starting, setStarting] = useState(true)
  const [otherCode, setOtherCode] = useState(false)
  // The latest callbacks, without restarting the camera when the parent re-renders.
  const handlers = useRef({ onCode, onProblem })
  handlers.current = { onCode, onProblem }

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let timer: number | undefined
    const stop = () => {
      stopped = true
      window.clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
    void (async () => {
      try {
        stream = await openCamera()
        if (stopped) return stop()
        const el = video.current!
        el.srcObject = stream
        await el.play()
        const reader = await createQrReader()
        setStarting(false)
        const tick = async () => {
          if (stopped) return
          const text = await reader.read(el).catch(() => null)
          if (stopped) return
          if (text && isCheckInCode(text)) {
            stop()
            handlers.current.onCode(text)
            return
          }
          setOtherCode(Boolean(text))
          timer = window.setTimeout(() => void tick(), READ_EVERY_MS)
        }
        void tick()
      } catch (err) {
        if (stopped) return
        stop()
        handlers.current.onProblem(cameraProblem(err))
      }
    })()
    return stop
  }, [])

  return (
    <div className="space-y-3">
      <div className="relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-card bg-black shadow-card">
        <video ref={video} muted playsInline aria-label="Camera" className="h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-[12%] rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" aria-hidden="true" />
        {starting && (
          <div className="absolute inset-0 flex items-center justify-center text-white">
            <Spinner className="h-8 w-8" />
          </div>
        )}
      </div>
      <p className="text-center text-base text-ink-muted" aria-live="polite">
        {otherCode ? 'That is not the depot code. Point at the code on the depot screen.' : 'Hold the code inside the frame.'}
      </p>
      <button type="button" onClick={onCancel} className="focus-ring flex h-12 w-full items-center justify-center rounded-2xl border border-line-strong bg-surface text-base font-semibold text-ink shadow-soft hover:bg-surface-muted">
        Cancel
      </button>
    </div>
  )
}
