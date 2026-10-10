// Documents of a vehicle or a driver (api-contract §8).

export type DocumentOwnerType = 'vehicle' | 'driver'

export const DOCUMENT_TYPES = [
  'registration',
  'licence',
  'insurance',
  'maintenance_invoice',
  'inspection_evidence',
  'incident_photo',
  'dvir_attachment',
  'fuel_receipt',
  'other',
] as const

export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export interface OwnedDocument {
  id: string
  owner_type: DocumentOwnerType
  owner_id: string
  document_type: DocumentType
  original_filename: string | null
  content_type: 'image/jpeg' | 'image/png' | 'application/pdf'
  size_bytes: number
  sha256: string
  expires_on: string | null
  retain_until: string | null
  uploaded_by: string
  uploaded_at: string
}

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  registration: 'Registration',
  licence: 'Licence',
  insurance: 'Insurance',
  maintenance_invoice: 'Maintenance invoice',
  inspection_evidence: 'Inspection evidence',
  incident_photo: 'Incident photo',
  dvir_attachment: 'DVIR attachment',
  fuel_receipt: 'Fuel receipt',
  other: 'Other',
}

/** The owner a documents drawer is about: its type, public id and how to name it. */
export interface DocumentOwner {
  type: DocumentOwnerType
  id: string
  /** "AA 3-12345", "Tigist Haile". */
  label: string
}
