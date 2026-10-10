import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { DocumentOwnerType, DocumentType, OwnedDocument } from './types'

const keys = {
  all: ['documents'] as const,
  owners: (type: DocumentOwnerType, ids: readonly string[]) => ['documents', type, ids] as const,
}

/** Live documents of a page of owners, in one request (up to 100 ids). */
export function useOwnerDocuments(ownerType: DocumentOwnerType, ownerIds: readonly string[], enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.owners(ownerType, ownerIds),
    queryFn: () => api.request<OwnedDocument[]>(`/documents?owner_type=${ownerType}&owner_id=${ownerIds.join(',')}`),
    enabled: enabled && ownerIds.length > 0,
  })
}

export function useUploadDocument() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { ownerType: DocumentOwnerType; ownerId: string; file: File; documentType: DocumentType; expiresOn: string }) => {
      const form = new FormData()
      form.set('owner_type', input.ownerType)
      form.set('owner_id', input.ownerId)
      form.set('document_type', input.documentType)
      if (input.expiresOn) form.set('expires_on', input.expiresOn)
      form.set('file', input.file, input.file.name)
      return api.request<OwnedDocument>('/documents', { method: 'POST', formData: form })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  })
}

export function useDeleteDocument() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  })
}

/** A fresh signed link (valid one hour) to open a document's file. */
export function useDocumentLink() {
  const { api } = useAuth()
  return useMutation({
    mutationFn: (id: string) => api.request<OwnedDocument & { url: string }>(`/documents/${id}`),
  })
}
