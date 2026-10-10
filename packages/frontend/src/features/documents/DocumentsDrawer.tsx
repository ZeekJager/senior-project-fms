import { AlertCircle, ExternalLink, FileImage, FileText, Trash2, UploadCloud, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { EmptyState } from '@/components/shared'
import { Badge, Button, cn, Drawer, IconButton, SelectField, Skeleton, TextField, useToast, type BadgeTone } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useDeleteDocument, useDocumentLink, useUploadDocument } from './api'
import { ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, expiryState, formatBytes, formatDate, type ExpiryState } from './expiry'
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, type DocumentOwner, type DocumentType, type OwnedDocument } from './types'

interface DocumentsDrawerProps {
  /** The vehicle or driver whose documents are shown; null when closed. */
  owner: DocumentOwner | null
  documents: OwnedDocument[]
  isLoading: boolean
  onClose: () => void
  /** A file chosen with the row's + button, ready to upload. */
  stagedFile: File | null
  canUpload: boolean
  canDelete: boolean
  /** Preselected in the upload form: registration for vehicles, licence for drivers. */
  defaultType?: DocumentType
}

const UPLOAD_ERRORS: Record<string, string> = {
  UNSUPPORTED_MEDIA_TYPE: 'That file is not a JPEG, PNG or PDF. The type is read from the file itself, not its name.',
  PAYLOAD_TOO_LARGE: 'That file is larger than 10 MB.',
}

/** The papers of one vehicle or driver (registration, insurance, licence), with their expiry, and an upload form. */
export function DocumentsDrawer({ owner, documents, isLoading, onClose, stagedFile, canUpload, canDelete, defaultType }: DocumentsDrawerProps) {
  const own = owner ? documents.filter((d) => d.owner_id === owner.id) : []
  return (
    <Drawer
      open={owner !== null}
      onClose={onClose}
      title={`Documents · ${owner?.label ?? ''}`}
      description="Expired papers show red; those expiring within 30 days amber."
    >
      <div className="space-y-8">
        {canUpload && owner && (
          <UploadForm key={`${owner.id}-${stagedFile?.name ?? ''}`} owner={owner} initialFile={stagedFile} defaultType={defaultType ?? 'registration'} />
        )}
        <section aria-labelledby="documents-on-file">
          <h3 id="documents-on-file" className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            On file
          </h3>
          {isLoading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-[72px] w-full rounded-card" />
              ))}
            </div>
          ) : own.length === 0 ? (
            <div className="rounded-card border border-dashed border-line-strong">
              <EmptyState icon={<FileText />} heading="No documents yet" description="Upload the registration and insurance so their expiry is tracked." />
            </div>
          ) : (
            <ul className="space-y-2">
              {own.map((doc) => (
                <DocumentRow key={doc.id} doc={doc} canDelete={canDelete} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  )
}

const EXPIRY_BADGE: Record<ExpiryState, { tone: BadgeTone; label: (days: number | null) => string }> = {
  expired: { tone: 'danger', label: () => 'Expired' },
  expiring: { tone: 'warning', label: (days) => (days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`) },
  valid: { tone: 'success', label: () => 'Valid' },
  none: { tone: 'neutral', label: () => 'No expiry' },
}

/** Red when expired, amber within 30 days (FMS-18). */
export function ExpiryBadge({ expiresOn }: { expiresOn: string | null }) {
  const { state, days } = expiryState(expiresOn)
  const { tone, label } = EXPIRY_BADGE[state]
  return (
    <Badge tone={tone} dot>
      <span data-expiry={state}>{label(days)}</span>
    </Badge>
  )
}

function DocumentRow({ doc, canDelete }: { doc: OwnedDocument; canDelete: boolean }) {
  const link = useDocumentLink()
  const remove = useDeleteDocument()
  const { toast } = useToast()
  const [confirming, setConfirming] = useState(false)
  const Icon = doc.content_type === 'application/pdf' ? FileText : FileImage

  async function open() {
    // Opened before the request so the browser does not treat it as a pop-up.
    const tab = window.open('', '_blank')
    try {
      const { url } = await link.mutateAsync(doc.id)
      if (tab) {
        tab.opener = null
        tab.location.href = url
      } else window.location.assign(url)
    } catch {
      tab?.close()
      toast({ title: 'Could not open the document', description: 'Try again in a moment.', tone: 'danger' })
    }
  }

  return (
    <li className="group flex items-center gap-3 rounded-card border border-line bg-surface p-3 shadow-soft transition-all duration-150 hover:border-line-strong hover:shadow-card">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-ink-muted ring-1 ring-inset ring-line">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink">
          {DOCUMENT_TYPE_LABELS[doc.document_type]}
          <ExpiryBadge expiresOn={doc.expires_on} />
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-subtle">
          {doc.expires_on && <span className="text-ink-muted">Until {formatDate(doc.expires_on)} · </span>}
          {doc.original_filename ?? 'Unnamed file'} · {formatBytes(doc.size_bytes)}
        </p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-1 animate-fade-in">
          <Button
            size="sm"
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(doc.id, {
                onSuccess: () => toast({ title: 'Document removed' }),
                onError: () => toast({ title: 'Could not remove the document', tone: 'danger' }),
              })
            }
          >
            Remove
          </Button>
          <IconButton size="sm" label="Keep document" icon={<X />} onClick={() => setConfirming(false)} />
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <IconButton size="sm" label={`Open ${DOCUMENT_TYPE_LABELS[doc.document_type]}`} icon={<ExternalLink />} onClick={() => void open()} />
          {canDelete && (
            <IconButton
              size="sm"
              label={`Remove ${DOCUMENT_TYPE_LABELS[doc.document_type]}`}
              icon={<Trash2 />}
              onClick={() => setConfirming(true)}
              className="hover:bg-danger-soft hover:text-danger"
            />
          )}
        </div>
      )}
    </li>
  )
}

function checkFile(file: File): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return `${file.name} is larger than 10 MB.`
  // The browser's guess from the extension; the server checks the bytes.
  if (file.type && !(ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(file.type)) return `${file.name} is not a JPEG, PNG or PDF.`
  return null
}

function UploadForm({ owner, initialFile, defaultType }: { owner: DocumentOwner; initialFile: File | null; defaultType: DocumentType }) {
  const upload = useUploadDocument()
  const { toast } = useToast()
  const inputId = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(initialFile)
  const [documentType, setDocumentType] = useState<DocumentType>(defaultType)
  const [expiresOn, setExpiresOn] = useState('')
  const [error, setError] = useState<string | null>(initialFile ? checkFile(initialFile) : null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (initialFile) setError(checkFile(initialFile))
  }, [initialFile])

  function choose(next: File | undefined) {
    if (!next) return
    setFile(next)
    setError(checkFile(next))
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    choose(event.dataTransfer.files[0])
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!file) return setError('Choose a file to upload.')
    const problem = checkFile(file)
    if (problem) return setError(problem)
    try {
      await upload.mutateAsync({ ownerType: owner.type, ownerId: owner.id, file, documentType, expiresOn })
      toast({ title: 'Document uploaded', description: `${DOCUMENT_TYPE_LABELS[documentType]} added to ${owner.label}.` })
      setFile(null)
      setExpiresOn('')
      setError(null)
      if (fileInput.current) fileInput.current.value = ''
    } catch (err) {
      setError(err instanceof ApiError ? (UPLOAD_ERRORS[err.code] ?? `The upload failed (${err.code}).`) : 'The upload failed. Try again.')
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={`${inputId}-heading`}>
      <h3 id={`${inputId}-heading`} className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
        Upload
      </h3>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-card border border-dashed px-4 py-6 text-center transition-all duration-150',
          dragging ? 'border-brand bg-brand-soft' : 'border-line-strong bg-surface-muted hover:border-brand/50 hover:bg-brand-soft/40',
        )}
      >
        <UploadCloud className={cn('h-6 w-6 transition-transform', dragging ? 'scale-110 text-brand-ink' : 'text-ink-subtle')} aria-hidden="true" />
        {file ? (
          <span className="mt-2 text-sm font-medium text-ink">
            {file.name} <span className="font-normal text-ink-subtle">· {formatBytes(file.size)}</span>
          </span>
        ) : (
          <span className="mt-2 text-sm text-ink-muted">
            <span className="font-medium text-brand-ink">Choose a file</span> or drag it here
          </span>
        )}
        <span className="mt-1 text-xs text-ink-subtle">JPEG, PNG or PDF, up to 10 MB</span>
        <input
          ref={fileInput}
          id={inputId}
          type="file"
          accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
          className="sr-only"
          onChange={(e) => choose(e.target.files?.[0])}
        />
      </label>
      <div className="mt-4 grid gap-x-4 sm:grid-cols-2">
        <SelectField
          label="Document type"
          value={documentType}
          onChange={(e) => setDocumentType(e.target.value as DocumentType)}
          options={DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] }))}
        />
        <TextField label="Expires on" optional type="date" alwaysFloat value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
      </div>
      <div role="alert">
        {error && (
          <p className="mb-3 flex animate-fade-in items-start gap-2 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
      </div>
      <Button type="submit" fullWidth loading={upload.isPending} leadingIcon={<UploadCloud className="h-4 w-4" />}>
        Upload document
      </Button>
    </form>
  )
}
