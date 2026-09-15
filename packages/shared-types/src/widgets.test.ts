import { describe, expect, it } from 'vitest'
import { validateWidgetConfig, WidgetLayoutSchema, WidgetTypeSchema } from './widgets'

describe('WidgetTypeSchema', () => {
  it('accepts the four starter catalog types', () => {
    for (const type of ['issues_over_time', 'top_issues', 'new_issues', 'events_by_environment']) {
      expect(WidgetTypeSchema.parse(type)).toBe(type)
    }
  })

  it('rejects a widget type outside the catalog', () => {
    expect(() => WidgetTypeSchema.parse('flows_by_stage')).toThrow()
  })
})

describe('validateWidgetConfig', () => {
  it('applies per-type defaults when config is empty', () => {
    expect(validateWidgetConfig('issues_over_time', {})).toEqual({ days: 14 })
    expect(validateWidgetConfig('top_issues', {})).toEqual({ limit: 10, windowDays: 14 })
  })

  it('rejects an out-of-range value for its type', () => {
    expect(() => validateWidgetConfig('top_issues', { limit: 999 })).toThrow()
  })

  it('strips unknown keys for its type', () => {
    expect(validateWidgetConfig('new_issues', { limit: 10 })).toEqual({ windowDays: 14 })
  })
})

describe('WidgetLayoutSchema', () => {
  it('accepts a valid grid position within 12 columns', () => {
    expect(WidgetLayoutSchema.parse({ x: 0, y: 0, w: 6, h: 4 })).toEqual({ x: 0, y: 0, w: 6, h: 4 })
  })

  it('rejects a width wider than the 12-column grid', () => {
    expect(() => WidgetLayoutSchema.parse({ x: 0, y: 0, w: 13, h: 4 })).toThrow()
  })
})
