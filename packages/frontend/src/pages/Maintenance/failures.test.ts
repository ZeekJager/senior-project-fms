import { describe, expect, it } from 'vitest'
import { checkFailures, emptyFailure, type FailureDraft } from './failures'

const draft = (patch: Partial<FailureDraft>): FailureDraft => ({ ...emptyFailure(), ...patch })

describe('checkFailures (FMS-125)', () => {
  it('completing needs at least one failure; an untouched row is not one', () => {
    expect(checkFailures([emptyFailure()], true).errors).toEqual({ failures: expect.stringContaining('at least one failure') })
    expect(checkFailures([], true).errors).toHaveProperty('failures')
  })

  it('open work needs none, and an untouched row is not sent', () => {
    expect(checkFailures([emptyFailure()], false)).toEqual({ failures: [], errors: {} })
  })

  it('a row started must be finished: each missing answer is named', () => {
    const { failures, errors } = checkFailures([draft({ component: 'brakes' })], false)
    expect(failures).toEqual([])
    expect(Object.keys(errors).sort()).toEqual(['failure.0.failure_mode', 'failure.0.unplanned'])
  })

  it('planned is an answer, not a default: false counts, null does not', () => {
    const planned = checkFailures([draft({ component: 'tyres', failure_mode: 'puncture', unplanned: false })], true)
    expect(planned).toEqual({ failures: [{ component: 'tyres', failure_mode: 'puncture', unplanned: false, detected_by: 'technician' }], errors: {} })
    expect(checkFailures([draft({ component: 'tyres', failure_mode: 'puncture' })], true).errors).toHaveProperty('failure.0.unplanned')
  })

  it('finished rows are sent in order; a bad second row is named by its position', () => {
    const rows = [draft({ component: 'cooling', failure_mode: 'leak', unplanned: true, detected_by: 'breakdown' }), draft({ failure_mode: 'wear' }), emptyFailure()]
    const { failures, errors } = checkFailures(rows, true)
    expect(failures).toEqual([{ component: 'cooling', failure_mode: 'leak', unplanned: true, detected_by: 'breakdown' }])
    expect(Object.keys(errors).sort()).toEqual(['failure.1.component', 'failure.1.unplanned'])
  })
})
