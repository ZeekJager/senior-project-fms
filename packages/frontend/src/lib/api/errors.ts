/** One entry of `error.details` in the contract's error envelope (api-contract §3.4). */
export interface ApiErrorDetail {
  field?: string
  reason?: string
}

/** Thrown for every non-2xx response, shaped like the contract's error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ApiErrorDetail[] = [],
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown; details?: unknown }
  meta?: { request_id?: unknown }
}

/** Maps a failed response to an ApiError, even when the body is not the envelope (proxy error pages, network cut). */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorEnvelope | undefined
  try {
    body = (await res.json()) as ErrorEnvelope
  } catch {
    body = undefined
  }
  const error = body?.error
  return new ApiError(
    res.status,
    typeof error?.code === 'string' ? error.code : 'INTERNAL_SERVER_ERROR',
    typeof error?.message === 'string' ? error.message : res.statusText || 'Request failed',
    Array.isArray(error?.details) ? (error.details as ApiErrorDetail[]) : [],
    typeof body?.meta?.request_id === 'string' ? body.meta.request_id : undefined,
  )
}
