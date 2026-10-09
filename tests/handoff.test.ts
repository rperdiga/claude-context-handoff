import { expect, mock, test } from 'claude-code/testing'

const usageAt = (percent: number) => ({
  startedAt: 0,
  context: { tokens: percent * 2000, window: 200_000, percent },
  rateLimits: [],
})

test('crossing the threshold mid-turn aborts, writes a handoff and copies a prompt', async ($, on) => {
  const clock = mock.clock(on)
  let percent = 40
  const writes: { path: string; text: string }[] = []
  const copies: string[] = []
  const aborted: string[] = []

  on('session.usage', () => ({ value: usageAt(percent) }))
  on('session.root', () => ({ value: 'D:/proj' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '# Handoff\nDo the thing.', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) as never)
  on('fs.write', (_$, e) => { writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('ui.copy', (_$, e) => { copies.push(e.text); return { value: { isCopied: true } } })
  on('turn.abort', (_$, e) => { aborted.push(e.turnId); return { value: undefined } })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))

  await ($ as any).turn.start({ text: 'go', turnId: 't1' } as never)

  await $.tool.call({ tool: 'Read', file_path: 'a.txt' } as never)
  await clock.advance(1000)
  expect(writes.length).toBe(0)

  percent = 72
  await $.tool.call({ tool: 'Read', file_path: 'b.txt' } as never)
  await clock.advance(1000)

  expect(aborted).toEqual(['t1'])
  expect(writes.length).toBe(1)
  expect(writes[0]!.path).toMatch(/^D:[\\/]proj[\\/]\.claude[\\/]handoffs[\\/]handoff-.*\.md$/)
  expect(writes[0]!.text).toContain('Do the thing.')
  expect(copies[0]).toContain('.claude/handoffs/handoff-')

  // Fires once per conversation.
  await $.tool.call({ tool: 'Read', file_path: 'c.txt' } as never)
  await clock.advance(1000)
  expect(writes.length).toBe(1)
})

test('/handoff-off stops the automatic trigger and /handoff-on restores it', async ($, on) => {
  const clock = mock.clock(on)
  let percent = 40
  const writes: string[] = []
  const statuses: (string | undefined)[] = []

  on('session.usage', () => ({ value: usageAt(percent) }))
  on('session.root', () => ({ value: 'D:/proj' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '# Handoff', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) as never)
  on('fs.write', (_$, e) => { writes.push(e.path); return { value: undefined } })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.status', (_$, e) => { statuses.push((e as any).text); return { value: undefined } })
  on('turn.abort', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))

  await ($ as any).turn.start({ text: 'go', turnId: 't1' } as never)
  const off = await ($ as any).command.run({ command: 'handoff-off', args: '' })
  expect(off.text).toContain('off')
  expect(statuses.at(-1)).toBe('auto-handoff off')

  percent = 90
  await $.tool.call({ tool: 'Read', file_path: 'a.txt' } as never)
  await clock.advance(1000)
  expect(writes.length).toBe(0)

  await ($ as any).command.run({ command: 'handoff-on', args: '' })
  expect(statuses.at(-1)).toBeUndefined()
  await $.tool.call({ tool: 'Read', file_path: 'b.txt' } as never)
  await clock.advance(1000)
  expect(writes.length).toBe(1)
})
