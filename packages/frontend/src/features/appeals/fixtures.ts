import type { AppealDetail } from './api'

/** An appeal as the API answers it (tests). */
export function appealDetail(overrides: Partial<AppealDetail> = {}): AppealDetail {
  return {
    id: '7a1d1d1e-0000-4000-8000-000000000001',
    kind: 'appeal',
    status: 'submitted',
    outcome: null,
    target: { type: 'flag', id: '7a1d1d1e-0000-4000-8000-0000000000f1', month: null, trip_id: '7a1d1d1e-0000-4000-8000-0000000000a1', event_at: '2026-11-20T07:30:00.000Z' },
    reason: 'wrong_data',
    explanation: 'The GPS jumped near the bridge; I was going 60.',
    driver: { id: '7a1d1d1e-0000-4000-8000-0000000000d1', name: 'Abebe Kebede' },
    depot: { id: '7a1d1d1e-0000-4000-8000-0000000000e1', name: 'Addis North' },
    submitted_at: '2026-11-20T09:00:00.000Z',
    due_at: '2026-11-27T09:00:00.000Z',
    overdue: false,
    escalated_at: null,
    claimed_by: null,
    claimed_at: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    correction: null,
    score_before: null,
    score_after: null,
    acknowledged_at: null,
    closed_at: null,
    attachments: [{ id: '7a1d1d1e-0000-4000-8000-0000000000c1', content_type: 'image/jpeg', size_bytes: 2048, filename: 'speedo.jpg' }],
    version: 1,
    timeline: [{ id: 'e1', type: 'submitted', actor: { id: 'u1', name: 'Abebe Kebede' }, body: null, at: '2026-11-20T09:00:00.000Z' }],
    evidence: null,
    can: { claim: false, comment: true, decide: false, withdraw: true, acknowledge: false },
    ...overrides,
  }
}
