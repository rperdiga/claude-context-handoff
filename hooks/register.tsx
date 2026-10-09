import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Handoff } from '../types'

const pending = atom({ plugin: 'context-handoff', key: 'pending' } as const, null)
const isBusy = atom({ plugin: 'context-handoff', key: 'isBusy' } as const, false)
const isOff = atom({ plugin: 'context-handoff', key: 'isOff' } as const, false)

const HANDOFF_PROMPT = `The context window is nearly full and this session is being handed off to a fresh one.
Write a handoff document in Markdown for the next session, which will see nothing of this conversation but this file.
Include, under headings:
- Goal: what the user asked for, in their own terms, and any constraints or preferences they stated.
- Status: what is done, what is in progress (exactly where you stopped), what is left.
- Key files and locations: absolute paths, functions, commands, URLs that matter.
- Decisions and findings: what was decided and why, dead ends already ruled out.
- Next steps: a numbered list the next session should do first.
- Open questions for the user, if any.
Reply with the document alone, no preamble.`

const CLIPBOARD_TOOLS = [['clip'], ['pbcopy'], ['wl-copy'], ['xclip', '-selection', 'clipboard']]

type Settings = { threshold: number; mode: string; folder: string }

function joinPath(root: string, rel: string) {
  const full = /^([a-zA-Z]:[\\/]|\/)/.test(rel) ? rel : `${root.replace(/[\\/]+$/, '')}/${rel}`
  return /^[a-zA-Z]:\\/.test(full) || root.includes('\\') ? full.replace(/\//g, '\\') : full
}

function stamp(ms: number) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

async function percentOf($: EngineInterface) {
  return (await $.session.usage()).context.percent ?? 0
}

// The surface's clipboard first; the desktop app has none yet, so fall back to the OS tool.
async function copyText($: EngineInterface, text: string) {
  const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) return true
  for (const argv of CLIPBOARD_TOOLS) {
    const ran = await $.process.run(argv, { stdin: text }).catch(() => undefined)
    if (ran?.exitCode === 0) return true
  }
  return false
}

// The status line shows 'auto-handoff off' while the automatic trigger is disabled.
async function showStatus($: EngineInterface) {
  $.ui.status((await read($, isOff)) ? 'auto-handoff off' : undefined)
}

async function writeHandoff($: EngineInterface, percent: number, folder: string): Promise<Handoff | undefined> {
  $.ui.status(`context ${percent}%: writing handoff…`)
  let reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
  if (!reply.isAnswered) {
    // Nothing cached to fork from: summarize the transcript text instead.
    const messages = await $.session.messages()
    const transcript = messages
      .map(m => `${m.role.toUpperCase()}: ${m.text}`)
      .join('\n\n')
      .slice(-150_000)
    reply = await $.model.complete({
      model: await $.session.model(),
      system: HANDOFF_PROMPT,
      prompt: `<transcript>\n${transcript}\n</transcript>`,
    })
  }
  if (!reply.isAnswered) {
    await showStatus($)
    $.ui.toast(`context-handoff: could not write the handoff (${reply.reason})`)
    return undefined
  }

  const root = await $.session.root()
  const path = joinPath(root, `${folder}/handoff-${stamp(await $.clock.now())}.md`)
  const header = `<!-- context-handoff: session ${await $.session.id()} at ${percent}% context -->\n\n`
  await $.fs.write(path, header + reply.text.trim() + '\n')

  const prompt = `Continue the work from the previous session. Read the handoff file first: ${path}\nThen confirm in two lines where things stand and carry on with the next steps it lists.`
  const isCopied = await copyText($, prompt)
  await showStatus($)
  $.ui.toast(`Handoff written at ${percent}% context: ${path}${isCopied ? ' (continue prompt copied)' : ''}`)
  return { path, prompt, percent }
}

async function freshSession($: EngineInterface, handoff: Handoff) {
  await update($, pending, () => null)
  await $.command.run({ command: 'clear' })
  await $.prompt.submit({ text: handoff.prompt, asUser: true })
}

async function trigger($: EngineInterface, percent: number, settings: Settings) {
  if ((await read($, isBusy)) || (await read($, pending)) !== null) return
  await update($, isBusy, () => true)
  try {
    const handoff = await writeHandoff($, percent, settings.folder)
    if (handoff === undefined) return
    if (settings.mode === 'auto') {
      await freshSession($, handoff).catch(() =>
        $.ui.toast('context-handoff: could not start a fresh session; /clear and paste the copied prompt'),
      )
    } else if (settings.mode === 'ask') {
      await update($, pending, () => handoff)
    }
  } finally {
    await update($, isBusy, () => false)
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    threshold: Number(options.threshold ?? 70),
    mode: String(options.mode ?? 'ask'),
    folder: String(options.folder ?? '.claude/handoffs'),
  }

  let turnId: string | undefined
  let hasFired = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Write a handoff file now and copy a continue prompt.',
    })
    await $.command.register({
      name: 'handoff-continue',
      description: 'Clear and continue from the pending handoff in a fresh session.',
    })
    await $.command.register({
      name: 'handoff-off',
      description: 'Turn off the automatic handoff for this session (for unattended runs).',
    })
    await $.command.register({
      name: 'handoff-on',
      description: 'Turn the automatic handoff back on for this session.',
    })
    await showStatus($)
    return next(e)
  })

  // A /clear starts a new conversation: arm again for it.
  on('session.end', async ($, e, next) => {
    hasFired = false
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    return next(e)
  })

  // Mid-turn: once a tool call lands over the threshold, stop the turn, then hand off
  // outside this hook (a hook the turn waits on may not /clear or submit).
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (hasFired || e.agentId !== undefined || (await read($, isOff))) return result
    const percent = await percentOf($)
    if (percent >= settings.threshold) {
      hasFired = true
      if (turnId !== undefined) await $.turn.abort({ turnId }).catch(() => undefined)
      $.clock.after(250, () => void trigger($, percent, settings))
    }
    return result
  }).catch(($, e, next) => next(e)) // an observer: never blocks a tool call

  // Between turns: a turn that ended over the threshold without a tool call.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (hasFired || e.agentId !== undefined || (await read($, isOff))) return result
    const percent = await percentOf($)
    if (percent >= settings.threshold) {
      hasFired = true
      $.clock.after(250, () => void trigger($, percent, settings))
    }
    return result
  })

  on('command.run', { command: 'handoff' }, async $ => {
    const percent = await percentOf($)
    hasFired = true
    $.clock.after(250, () => void trigger($, percent, { ...settings, mode: settings.mode === 'auto' ? 'ask' : settings.mode }))
    return { text: `Writing a handoff at ${percent}% context…` }
  })

  on('command.run', { command: 'handoff-continue' }, async $ => {
    const handoff = await read($, pending)
    if (handoff === null) return { text: 'No pending handoff. Run /handoff first.' }
    $.clock.after(250, () => void freshSession($, handoff))
    return { text: `Starting fresh from ${handoff.path}` }
  })

  on('command.run', { command: 'handoff-off' }, async $ => {
    await update($, isOff, () => true)
    await showStatus($)
    return { text: 'Automatic handoff is off for this session. /handoff still works by hand; /handoff-on turns it back on.' }
  })

  on('command.run', { command: 'handoff-on' }, async $ => {
    await update($, isOff, () => false)
    await showStatus($)
    return { text: `Automatic handoff is on: it triggers at ${settings.threshold}% context.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const busy = await read($, isBusy)
    const handoff = await read($, pending)
    if (e.props.hasSurvey || (!busy && handoff === null)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    if (handoff === null) {
      return (
        <Box>
          <Text color="warning">Context over {settings.threshold}%: writing handoff…</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text color="warning">
          Context at {handoff.percent}%. Handoff saved: {handoff.path}
        </Text>
        <Box>
          <Button
            key="fresh"
            variant="primary"
            hotkey="1"
            label="Continue in a fresh session"
            onPress={() => void freshSession($, handoff)}
          />
          <Button
            key="copy"
            hotkey="2"
            label="Copy prompt"
            onPress={() => void copyText($, handoff.prompt)}
          />
          <Button
            key="dismiss"
            hotkey="3"
            label="Keep going here"
            onPress={() => void update($, pending, () => null)}
          />
        </Box>
      </Box>
    )
  })
}
