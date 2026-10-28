import { FileText, UploadCloud } from 'lucide-react'
import { useState } from 'react'
import { EmptyState } from '@/components/shared'
import { Button, Skeleton } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useOwnerDocuments } from '@/features/documents/api'
import { DocumentRow, DocumentsDrawer } from '@/features/documents/DocumentsDrawer'
import type { Vehicle } from '@/pages/Vehicles/types'

/**
 * The vehicle's papers (FMS-136, FMS-17): insurance and registration with their expiry, red when expired and
 * amber within 30 days, each one click from the file. Uploading goes through the documents drawer (document:write).
 */
export function DocumentsSection({ vehicle }: { vehicle: Vehicle }) {
  const { hasPermission } = useAuth()
  const canUpload = hasPermission('document:write') && vehicle.status !== 'retired'
  const docs = useOwnerDocuments('vehicle', [vehicle.id], true)
  const [uploading, setUploading] = useState(false)
  const documents = docs.data ?? []

  return (
    <section aria-labelledby="documents-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="documents-heading" className="text-base font-semibold text-ink">
            Documents
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">Expired papers show red; those expiring within 30 days amber.</p>
        </div>
        {canUpload && (
          <Button variant="secondary" leadingIcon={<UploadCloud className="h-4 w-4" />} onClick={() => setUploading(true)}>
            Upload a document
          </Button>
        )}
      </div>

      {docs.isPending ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[72px] w-full rounded-card" />
          ))}
        </div>
      ) : docs.isError ? (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          The documents could not be loaded. Reload the page to try again.
        </p>
      ) : documents.length === 0 ? (
        <div className="rounded-card border border-dashed border-line-strong">
          <EmptyState icon={<FileText />} heading="No documents yet" description="Upload the registration and insurance so their expiry is tracked." />
        </div>
      ) : (
        <ul className="max-w-3xl space-y-2">
          {documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} canDelete={hasPermission('document:delete')} />
          ))}
        </ul>
      )}

      <DocumentsDrawer
        owner={uploading ? { type: 'vehicle', id: vehicle.id, label: vehicle.registration_number } : null}
        documents={documents}
        isLoading={docs.isPending}
        onClose={() => setUploading(false)}
        stagedFile={null}
        canUpload={canUpload}
        canDelete={hasPermission('document:delete')}
      />
    </section>
  )
}
