import { Camera, Trash2, Upload } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, cn, Spinner } from '@/components/ui'
import { PHOTO_ACCEPT, PhotoRejected, photoForm, preparePhoto, type PhotoShape } from '@/lib/photo'
import { errorDetails } from './ErrorBoundary'

export interface PhotoUploaderProps {
  /** Whose photo, for the buttons' names: "Sara Bekele", "AA-12345". */
  subject: string
  shape: PhotoShape
  /** The photo now, or null. */
  current: string | null
  /** The preview: the photo at `src`, or the placeholder when null. */
  renderPreview: (src: string | null) => ReactNode
  /** Sends the prepared photo (the `file` part) and answers with its new URL. */
  upload: (form: FormData) => Promise<{ photo_url: string }>
  remove: () => Promise<unknown>
  /** After a change: the new URL, or null when removed. */
  onChange?: (photoUrl: string | null) => void
  className?: string
}

/**
 * Upload, change or remove a photo of a person or a vehicle (docs/photos.md). Click or drop a picture: it is
 * cropped to fit and shrunk in the browser (a 512 px square, or 1280 x 960), shown at once, then sent.
 */
export function PhotoUploader({ subject, shape, current, renderPreview, upload, remove, onChange, className }: PhotoUploaderProps) {
  const input = useRef<HTMLInputElement>(null)
  const helpId = useId()
  const [shown, setShown] = useState<string | null>(current)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => setShown(current), [current])

  async function take(file: File | undefined) {
    if (!file || busy) return
    setError(null)
    let blob: Blob
    try {
      blob = await preparePhoto(file, shape)
    } catch (err) {
      setError(err instanceof PhotoRejected ? err.message : 'That picture could not be read.')
      return
    }
    const local = URL.createObjectURL(blob)
    const before = shown
    setShown(local)
    setBusy('upload')
    try {
      const { photo_url } = await upload(photoForm(blob))
      setShown(photo_url)
      onChange?.(photo_url)
    } catch (err) {
      setShown(before)
      setError(errorDetails(err).message)
    } finally {
      URL.revokeObjectURL(local)
      setBusy(null)
    }
  }

  async function drop() {
    setError(null)
    setBusy('remove')
    try {
      await remove()
      setShown(null)
      onChange?.(null)
    } catch (err) {
      setError(errorDetails(err).message)
    } finally {
      setBusy(null)
    }
  }

  const round = shape === 'portrait' ? 'rounded-full' : 'rounded-card'

  return (
    <div className={cn('flex flex-wrap items-center gap-4', className)}>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void take(e.dataTransfer.files[0])
        }}
        disabled={busy !== null}
        aria-label={shown ? `Change the photo of ${subject}` : `Add a photo of ${subject}`}
        aria-describedby={helpId}
        className={cn('focus-ring group relative shrink-0 transition', round, dragging && 'ring-4 ring-brand/30')}
      >
        {renderPreview(shown)}
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100',
            round,
            busy && 'opacity-100',
          )}
        >
          {busy ? <Spinner className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
        </span>
      </button>
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => input.current?.click()} disabled={busy !== null} leadingIcon={<Upload className="h-3.5 w-3.5" />}>
            {shown ? 'Change photo' : 'Upload photo'}
          </Button>
          {shown && (
            <Button size="sm" variant="ghost" onClick={() => void drop()} disabled={busy !== null} leadingIcon={<Trash2 className="h-3.5 w-3.5" />} aria-label={`Remove the photo of ${subject}`}>
              Remove
            </Button>
          )}
        </div>
        <p id={helpId} className="mt-1.5 text-xs text-ink-muted">
          JPEG, PNG or WebP. {shape === 'portrait' ? 'Cropped to a square' : 'Cropped to 4:3'} and made smaller before it is sent.
        </p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept={PHOTO_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="photo-file"
        onChange={(e) => {
          void take(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}
