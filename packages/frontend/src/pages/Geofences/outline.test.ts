import { describe, expect, it } from 'vitest'
import { areaOf, outlineProblem, toPolygon, type Corner } from './outline'

// FMS-90: the outline drawn in the editor, checked as the server checks it.

const square: Corner[] = [
  [9.0098, 38.7603],
  [9.0098, 38.7623],
  [9.0118, 38.7623],
  [9.0118, 38.7603],
]

describe('the outline being drawn', () => {
  it('goes to the API as GeoJSON: longitude first, closed', () => {
    expect(toPolygon(square)).toEqual({ type: 'Polygon', coordinates: [[[38.7603, 9.0098], [38.7623, 9.0098], [38.7623, 9.0118], [38.7603, 9.0118], [38.7603, 9.0098]]] })
  })

  it('a 220 m square is about 4.8 ha and fine', () => {
    expect(areaOf(square)).toBeGreaterThan(45_000)
    expect(areaOf(square)).toBeLessThan(50_000)
    expect(outlineProblem(square)).toBeNull()
  })

  it('too few corners, crossing edges and a speck each say what to do', () => {
    expect(outlineProblem([])).toBe('Click the map to place at least 3 corners.')
    expect(outlineProblem(square.slice(0, 2))).toBe('Click the map to place at least 3 corners (1 more).')
    expect(outlineProblem([square[0], square[2], square[1], square[3]])).toMatch(/edges cross/)
    expect(outlineProblem([[9.01, 38.76], [9.01, 38.76001], [9.01001, 38.76001]])).toMatch(/Too small/)
  })
})
