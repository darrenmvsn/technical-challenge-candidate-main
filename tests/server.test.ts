import { describe, it, expect } from 'vitest'
import { fireAndReport, startAdaptiveLoop } from '../src/server'

const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })

describe('server polling helpers', () => {
  it('startAdaptiveLoop catches a rejected drain and schedules the next poll', async () => {
    const delays: number[] = []
    const callbacks: (() => void)[] = []
    const errors: unknown[] = []
    let calls = 0

    startAdaptiveLoop(
      async () => {
        calls++
        if (calls === 1) throw new Error('transient drain failure')
        return 0
      },
      {
        initialMs: 1000,
        minMs: 1000,
        maxMs: 30_000,
        setTimeout: (cb, ms) => {
          callbacks.push(cb)
          delays.push(ms)
          return 0
        },
        onError: err => { errors.push(err) },
      },
    )

    await flush()
    expect(calls).toBe(1)
    expect(errors).toHaveLength(1)
    expect(delays).toEqual([2000])

    callbacks[0]!()
    await flush()
    expect(calls).toBe(2)
    expect(delays).toEqual([2000, 4000])
  })

  it('fireAndReport observes rejected wake promises instead of leaving them unhandled', async () => {
    const err = new Error('wake failed')
    const observed: unknown[] = []

    fireAndReport(async () => { throw err }, caught => { observed.push(caught) })

    await flush()
    expect(observed).toEqual([err])
  })
})
