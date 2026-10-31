import { ArrowLeft, Building2, Expand, Minimize, RefreshCw, ScanLine, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, QrCode } from '@/components/shared'
import { Button, Card, FilterSelect, Skeleton } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { useAttendanceCode, type AttendanceCode } from './api'

/** The depot's late line: 08:00 and 15 minutes is 08:15. */
function lateAfter(code: Pick<AttendanceCode, 'work_starts_at' | 'late_after_minutes'>): string {
  const [h, m] = code.work_starts_at.split(':').map(Number)
  const minutes = h * 60 + m + code.late_after_minutes
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** Re-renders every second, for the countdown. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/**
 * S-24 Check-in code (FMS-141): the depot's QR for drivers to scan with the driver app, a new one every 30 seconds.
 * Meant for a screen at the depot gate, so it goes full screen. A code no longer valid is never shown: when the
 * next cannot be fetched, the code gives way to a reconnecting notice rather than one drivers would scan in vain.
 */
export function CheckInCodePage() {
  const { session } = useAuth()
  const [params, setParams] = useSearchParams()
  const depots = useDepots()
  // Their own depot; otherwise the one asked for, or the only one they see.
  const only = depots.data?.length === 1 ? depots.data[0].id : ''
  const depotId = params.get('depot') ?? (session?.user.depot_id || only)
  const code = useAttendanceCode(depotId, depotId !== '')
  const now = useNow()
  const stage = useRef<HTMLDivElement>(null)
  const [fullScreen, setFullScreen] = useState(false)

  useEffect(() => {
    const changed = () => setFullScreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])

  function toggleFullScreen() {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void stage.current?.requestFullscreen?.()
  }

  const data = code.data
  // On the server's clock: how long this code has been out, by this device's clock since the answer.
  const elapsed = data ? Date.parse(data.generated_at) + (now - data.fetchedAt) : 0
  const valid = data !== undefined && elapsed < Date.parse(data.expires_at)
  const nextIn = data ? Math.max(0, Math.ceil((Date.parse(data.refresh_at) - elapsed) / 1000)) : 0
  const choosing = !depotId && (depots.data?.length ?? 0) > 0

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link to="/attendance" className="focus-ring -ml-1 inline-flex items-center gap-1 rounded-control px-1 py-1 text-sm font-medium text-ink-muted hover:text-ink">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Attendance
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink sm:text-2xl">Check-in code</h1>
          <p className="mt-1.5 max-w-prose text-sm text-ink-muted">Drivers scan this with the driver app when they arrive and when they leave. It changes every 30 seconds, so a photo of it is no use later.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(depots.data?.length ?? 0) > 1 && (
            <FilterSelect
              label="Depot"
              icon={<Building2 />}
              value={depotId}
              emptyValue=""
              options={[{ value: '', label: 'Choose a depot' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]}
              onChange={(depot) => setParams(depot ? { depot } : {}, { replace: true })}
            />
          )}
          <Button variant="secondary" leadingIcon={<Expand className="h-4 w-4" />} onClick={toggleFullScreen} disabled={!valid}>
            Full screen
          </Button>
        </div>
      </header>

      {choosing ? (
        <Card>
          <EmptyState icon={<Building2 />} heading="Choose a depot" description="Each depot has its own code: a driver can check in only with their own depot's." />
        </Card>
      ) : (
        <div ref={stage} className="flex flex-col items-center justify-center gap-6 rounded-card border border-line bg-surface px-6 py-8 shadow-card [&:fullscreen]:rounded-none [&:fullscreen]:border-0 [&:fullscreen]:py-12">
          {code.isPending ? (
            <Skeleton className="aspect-square w-[min(28rem,80vw)] rounded-control" />
          ) : valid ? (
            <>
              <div className="text-center">
                <p className="text-2xl font-semibold tracking-tight text-ink [:fullscreen_&]:text-4xl">{data.depot_name}</p>
                <p className="mt-1 text-sm text-ink-muted [:fullscreen_&]:text-lg">
                  Day starts {data.work_starts_at} · late after {lateAfter(data)}
                </p>
              </div>
              <div className="rounded-control border border-line p-3 shadow-soft">
                <QrCode value={data.code} label={`Check-in code for ${data.depot_name}`} className="aspect-square w-[min(28rem,80vw,60vh)] [:fullscreen_&]:w-[min(42rem,80vw,70vh)]" />
              </div>
              <div className="flex flex-col items-center gap-1 text-center">
                <p className="flex items-center gap-2 text-base font-medium text-ink [:fullscreen_&]:text-2xl">
                  <ScanLine className="h-5 w-5 text-brand-ink" aria-hidden="true" />
                  Driver app → Check in → point the camera here
                </p>
                <p className="tabular text-sm text-ink-subtle [:fullscreen_&]:text-base" aria-live="off">
                  New code in {nextIn} s
                </p>
              </div>
              {fullScreen && (
                <Button variant="ghost" leadingIcon={<Minimize className="h-4 w-4" />} onClick={toggleFullScreen}>
                  Leave full screen
                </Button>
              )}
            </>
          ) : (
            <div role="alert" className="flex max-w-sm flex-col items-center py-10 text-center">
              {code.isError && !data ? (
                <>
                  <WifiOff className="mb-4 h-10 w-10 stroke-[1.5] text-danger" aria-hidden="true" />
                  <h2 className="text-lg font-semibold text-ink">The code could not be loaded</h2>
                  <p className="mt-1.5 text-base text-ink-muted">Drivers cannot check in until it shows. Check the connection; it tries again on its own.</p>
                </>
              ) : (
                <>
                  <RefreshCw className="mb-4 h-10 w-10 animate-spin stroke-[1.5] text-ink-subtle motion-reduce:animate-none" aria-hidden="true" />
                  <h2 className="text-lg font-semibold text-ink">Reconnecting</h2>
                  <p className="mt-1.5 text-base text-ink-muted">The last code has expired, so it is hidden. A new one shows as soon as the server answers.</p>
                </>
              )}
              <Button variant="secondary" className="mt-5" leadingIcon={<RefreshCw className="h-4 w-4" />} onClick={() => void code.refetch()}>
                Try now
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
