import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import '../src/events.js'

describe('free-router session events', () => {
  it('accepts serializable routing telemetry without adding model-visible messages', () => {
    const session = Session.create(SessionId('free-router-test'))

    session.append('free-router/selected', {
      turn: 1,
      step: 1,
      attempt: 1,
      provider: 'openrouter',
      model: 'org/model:free',
      reason: 'policy',
      metrics: {
        status: 'unknown',
        averageFirstByteMs: null,
        successRate: 0,
        consecutiveFailures: 0,
        coolingUntil: 0,
      },
    })
    session.append('free-router/failover', {
      turn: 1,
      step: 1,
      attempt: 1,
      provider: 'openrouter',
      model: 'org/model:free',
      failureCode: 'RATE_LIMIT',
      isolatedScope: 'model',
      nextProvider: 'nvidia',
      nextModel: 'fallback',
      attempts: 1,
    })

    expect(session.events.map((event) => event.type)).toEqual(['free-router/selected', 'free-router/failover'])
    expect(session.deriveMessages()).toEqual([])
  })
})
