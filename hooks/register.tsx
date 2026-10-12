import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, Column, SessionLink, SessionState, Tone } from '../types'
import {
  BOARD_TOOL_DESCRIPTION,
  BOARD_TOOL_SCHEMA,
  COLUMNS,
  COLUMN_NAME,
  DONE_SHOWN,
  addCard,
  applyLinks,
  cardTag,
  editCard,
  forecastPrompt,
  forecastView,
  linkCard,
  moveCard,
  neighbour,
  parseLink,
  planSteps,
  removeCard,
  runBoardTool,
  sessionText,
  sourceName,
  syncTodos,
  taggedCard,
  taskCreated,
  taskUpdated,
  todayOf,
  workPrompt,
} from './lib'
import type { BoardToolInput } from './lib'
import { columnsHeightFor, wrap } from './columns'
import type { ColumnsMessage, ColumnsProps } from './columns'

const PANE = 'task-board'
const TITLE = 'Board'
const TOOL = 'board'
// Theme colors follow the light or dark scheme by themselves; the green is one that reads on both.
const ACCENT = 'claude'
const GREEN = '#2da44e'
/** Each column's dot. */
const DOT: Record<Column, { color?: string }> = { todo: {}, doing: { color: ACCENT }, done: { color: GREEN } }
/** The mark in a card's footer: who put it there (✦ Claude, ◆ a plan); the card's details say it in words. */
const TAG: Record<Card['source'], string> = { you: '', todo: '✦', claude: '✦', plan: '◆' }
/** Rows above the columns (the progress row and the blank under it) and below them (the pane's last blank). */
const HEADER_ROWS = 3
/** Cells in the progress bar. */
const BAR = 12
const TONE: Record<Tone, string> = { ok: GREEN, tight: '#d29922', late: '#cf222e', info: '#2f81f7' }
const POLL_MS = 5_000

const cards = atom({ plugin: 'task-board', key: 'cards' } as const, [])
const selected = atom({ plugin: 'task-board', key: 'selected' } as const, null)
const composer = atom({ plugin: 'task-board', key: 'composer' } as const, null)
const working = atom({ plugin: 'task-board', key: 'working' } as const, null)
const forecast = atom({ plugin: 'task-board', key: 'forecast' } as const, null)
const today = atom({ plugin: 'task-board', key: 'today' } as const, '')
const linkedTo = atom({ plugin: 'task-board', key: 'linkedTo' } as const, null)

/** The board's full tool name, as Claude calls it: `mcp__task-board__board`, else what registering answered. */
let toolName = `mcp__task-board__${TOOL}`
const seen = new Map<string, number>()

/**
 * Writes the board; the first cards Claude puts on an empty board open the
 * pane, so the board shows up as Claude starts working.
 */
async function setCards($: EngineInterface, next: (current: Card[]) => Card[], isClaude: boolean): Promise<void> {
  const before = await read($, cards)
  const after = next(before)
  if (JSON.stringify(after) === JSON.stringify(before)) return
  await update($, cards, () => after)
  if (isClaude && before.length === 0 && after.length > 0) await $.ui.open({ id: PANE, title: TITLE })
}

/** Opens the composer: empty for a new card, or holding `card` to edit it. */
async function compose($: EngineInterface, card: Card | null): Promise<void> {
  await update($, composer, () =>
    card === null
      ? { id: null, title: '', note: '', hasNote: false }
      : { id: card.id, title: card.title, note: card.note, hasNote: false },
  )
  await $.ui.focus({ requestId: PANE, key: 'title' }).catch(() => undefined)
}

/** Swaps the Title field for the Description field, and moves the cursor into it. */
async function showNote($: EngineInterface): Promise<void> {
  await update($, composer, current => (current === null ? current : { ...current, hasNote: true }))
  await $.ui.focus({ requestId: PANE, key: 'note' }).catch(() => undefined)
}

/** Back to the Title field. */
async function showTitle($: EngineInterface): Promise<void> {
  await update($, composer, current => (current === null ? current : { ...current, hasNote: false }))
  await $.ui.focus({ requestId: PANE, key: 'title' }).catch(() => undefined)
}

async function typeIn($: EngineInterface, field: 'title' | 'note', text: string): Promise<void> {
  await update($, composer, current => (current === null ? current : { ...current, [field]: text }))
}

/** Saves what the composer holds: a new card in To do, or the edited card; then closes it. */
async function saveComposer($: EngineInterface): Promise<void> {
  const draft = await read($, composer)
  if (draft === null) return
  if (draft.title.trim() === '') {
    $.ui.toast('Give the card a title.')
    await $.ui.focus({ requestId: PANE, key: 'title' }).catch(() => undefined)
    return
  }
  const at = await $.clock.now()
  const id = draft.id
  await setCards(
    $,
    current =>
      id === null
        ? addCard(current, { title: draft.title, note: draft.note, source: 'you' }, at).cards
        : editCard(current, id, { title: draft.title, note: draft.note }),
    false,
  )
  await update($, composer, () => null)
}

async function select($: EngineInterface, id: string | null): Promise<void> {
  await update($, selected, current => (current === id ? null : id))
}

async function move($: EngineInterface, id: string, column: Column): Promise<void> {
  await setCards($, current => moveCard(current, id, column), false)
}

async function remove($: EngineInterface, id: string): Promise<void> {
  await setCards($, current => removeCard(current, id), false)
  if ((await read($, selected)) === id) await update($, selected, () => null)
}

/**
 * Hands Claude a card: the card moves to Doing and Claude gets a prompt to
 * work on it. Claude Code holds a prompt a mod sends until Claude is idle, so
 * a toast says when it waits.
 */
async function workOn($: EngineInterface, card: Card): Promise<void> {
  if ((await read($, working)) === card.id) {
    $.ui.toast('Claude already has this card.')
    return
  }
  await update($, working, () => card.id)
  await move($, card.id, 'doing')
  let isStarted = false
  const submitted = $.prompt.submit({ text: workPrompt(card) }).then(
    result => {
      isStarted = result.drop === undefined
    },
    () => {
      isStarted = false
    },
  )
  let isSettled = false
  void submitted.then(() => {
    isSettled = true
  })
  await Promise.race([submitted, $.clock.sleep(500)])
  if (!isSettled) $.ui.toast('Queued: Claude starts on this card once it finishes the current task.', { timeoutMs: 8_000 })
  await submitted
  if (!isStarted && (await read($, working)) === card.id) {
    await update($, working, () => null)
    $.ui.toast('The card was not handed to Claude.')
  }
}

async function linksDir($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')

  return home === undefined ? null : `${home}/.claude/task-board/links`
}

async function writeLink($: EngineInterface, card: string, link: SessionLink): Promise<void> {
  const dir = await linksDir($)
  if (dir !== null) await $.fs.write(`${dir}/${card}.json`, JSON.stringify({ card, ...link }))
}

async function dropLink($: EngineInterface, card: string): Promise<void> {
  const dir = await linksDir($)
  if (dir !== null) await $.process.run(['rm', '-f', `${dir}/${card}.json`]).catch(() => undefined)
}

async function readLinks($: EngineInterface, dir: string): Promise<Array<{ card: string; link: SessionLink; mtime: number }>> {
  const entries = await $.fs.list(dir).catch(() => [])
  const links: Array<{ card: string; link: SessionLink; mtime: number }> = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const card = entry.name.slice(0, -'.json'.length)
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => null)
    const link = text === null ? null : parseLink(text)
    if (link !== null) links.push({ card, link, mtime: entry.mtimeMs })
  }

  return links
}

async function syncLinks($: EngineInterface): Promise<void> {
  const day = todayOf(await $.clock.now())
  if ((await read($, today)) !== day) await update($, today, () => day)
  const board = await read($, cards)
  const dir = await linksDir($)
  if (dir === null || board.length === 0) return
  const ids = new Set(board.map(card => card.id))
  const entries = await $.fs.list(dir).catch(() => [])
  const changed = entries.filter(entry => ids.has(entry.name.slice(0, -'.json'.length)) && seen.get(entry.name) !== entry.mtimeMs)
  if (changed.length === 0) return
  const found = (await readLinks($, dir)).filter(one => ids.has(one.card))
  for (const one of found) seen.set(`${one.card}.json`, one.mtime)
  await setCards($, current => applyLinks(current, found), false)
}

async function report($: EngineInterface, state: SessionState): Promise<void> {
  const dir = await linksDir($)
  if (dir === null) return
  const host = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) ?? null
  let card = await read($, linkedTo)
  if (card === null && host !== null) {
    const own = new Set((await read($, cards)).map(one => one.id))
    card = (await readLinks($, dir)).find(one => one.link.host === host && !own.has(one.card))?.card ?? null
    if (card !== null) await update($, linkedTo, () => card)
  }
  if (card !== null) await writeLink($, card, { id: await $.session.id(), host, state, at: await $.clock.now() })
}

async function openSession($: EngineInterface, link: SessionLink): Promise<void> {
  if (link.host === null) {
    $.ui.toast('Only a session of the desktop app opens from here.')
    return
  }
  const url = `claude://claude.ai/epitaxy/${link.host}`
  for (const opener of ['xdg-open', 'open']) {
    const ran = await $.process.run([opener, url]).catch(() => null)
    if (ran?.exitCode === 0) return
  }
  $.ui.toast("The session couldn't be opened.")
}

async function unlink($: EngineInterface, id: string): Promise<void> {
  await setCards($, current => linkCard(current, id, null), false)
  await dropLink($, id)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: "Show the session's task board: To do, Doing and Done" })
    const registered = await $.tool.register({ name: TOOL, description: BOARD_TOOL_DESCRIPTION, inputSchema: BOARD_TOOL_SCHEMA })
    toolName = registered.tool
    $.clock.every(POLL_MS, () => void syncLinks($).catch(() => undefined))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const card = taggedCard(e.text)
    if (card !== null && !(await read($, cards)).some(one => one.id === card)) await update($, linkedTo, () => card)
    await report($, 'running').catch(() => undefined)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await report($, 'ended').catch(() => undefined)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const plan = await read($, forecast)
    if (plan === null || (plan.deadline === null && plan.finish === null)) return composed
    const section = { id: 'task-board:forecast', text: forecastPrompt(plan, todayOf(await $.clock.now())), scope: 'session' as const }

    return { sections: [...composed.sections, section] }
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Board opened.' }
  })

  // Claude's to-do list, in either of the tools it keeps it with.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const at = await $.clock.now()
      await setCards($, current => syncTodos(current, e.todos, at), true)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = (ran.result as { task?: { id?: unknown } } | undefined)?.task
    if (ran.deny === undefined && ran.isError !== true && typeof task?.id === 'string') {
      const at = await $.clock.now()
      const id = task.id
      await setCards($, current => taskCreated(current, { id, subject: e.subject, description: e.description }, at), true)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await setCards(
        $,
        current =>
          taskUpdated(current, {
            taskId: e.taskId,
            ...(e.status === undefined ? {} : { status: e.status }),
            ...(e.subject === undefined ? {} : { subject: e.subject }),
            ...(e.description === undefined ? {} : { description: e.description }),
          }),
        true,
      )
    }

    return ran
  })

  // An approved plan: its steps go to To do.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    const plan = (ran.result as { plan?: unknown } | undefined)?.plan
    if (ran.deny === undefined && ran.isError !== true && typeof plan === 'string') {
      const at = await $.clock.now()
      await setCards(
        $,
        current => planSteps(plan).reduce((board, step) => addCard(board, { title: step, source: 'plan' }, at).cards, current),
        true,
      )
    }

    return ran
  })

  // The board tool Claude calls: answered here, never passed on.
  on('tool.call', async ($, e, next) => {
    if (e.tool !== toolName) return next(e)
    const at = await $.clock.now()
    const before = await read($, cards)
    const shown = await read($, forecast)
    const outcome = runBoardTool(before, e as unknown as BoardToolInput, at, shown)
    await setCards($, () => outcome.cards, true)
    if (outcome.forecast !== undefined) {
      const banner = outcome.forecast
      await update($, forecast, () => banner)
      if (shown === null && banner !== null && before.length === 0) await $.ui.open({ id: PANE, title: TITLE })
    }
    const link = outcome.link
    if (link !== undefined) {
      if (link.host === null) await dropLink($, link.card)
      else await writeLink($, link.card, { id: null, host: link.host, state: null, at: 0 })
    }

    // A registered tool's result is text: what Claude reads back.
    return outcome.isError === true
      ? { result: outcome.text, text: outcome.text, isError: true as const }
      : { result: outcome.text, text: outcome.text }
  })

  // The draggable columns: a card dropped on another column, or clicked to open it.
  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const data = e.data as Partial<ColumnsMessage> | null
    const id = typeof data?.id === 'string' ? data.id : null
    if (id === null || !(await read($, cards)).some(card => card.id === id)) return {}
    if (data?.type === 'open') await select($, id)
    if (data?.type === 'move' && typeof data.column === 'number') {
      const column = COLUMNS[data.column]
      if (column !== undefined) await move($, id, column)
    }

    return {}
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // The turn Work on it started has ended: the card is Claude's no longer.
    if (e.agentId === undefined && (await read($, working)) !== null) await update($, working, () => null)
    if (e.agentId === undefined) await report($, 'idle').catch(() => undefined)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Input = 'Input' in table ? table.Input : undefined
    // The desktop app and the terminal draw a Client; VS Code's table lists one but draws none.
    const Client = (e.surface === 'desktop' || e.surface === 'terminal') && 'Client' in table ? table.Client : undefined
    const board = await read($, cards)
    const openId = await read($, selected)
    const writing = await read($, composer)
    const saveLabel = writing?.id == null ? 'Add card' : 'Save'
    const busy = await read($, working)
    const open = board.find(card => card.id === openId)
    const now = await $.clock.now()
    const day = (await read($, today)) || todayOf(now)
    const plan = await read($, forecast)

    const isLive = (card: Card) => card.id === busy || card.session?.state === 'running'
    const tagOf = (card: Card) =>
      `${card.id === busy ? '◐' : TAG[card.source]}${card.session === undefined ? '' : ' ⇄'}${card.note === '' ? '' : ' ≡'}`.trim()

    const cardView = (card: Card) => {
      const isOpen = card.id === openId
      const isBusy = isLive(card)
      const isDone = card.column === 'done'
      const next = neighbour(card.column, 1)
      const tag = tagOf(card)
      return (
        <Box
          key={`card:${card.id}`}
          flexDirection="column"
          borderStyle="round"
          {...(isOpen || isBusy ? { borderColor: ACCENT } : { borderDimColor: true })}
          hover={{ borderColor: ACCENT }}
          paddingX={1}
        >
          <Text wrap="wrap" dimColor={isDone}>
            {isDone ? `✓ ${card.title}` : card.title}
          </Text>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text {...(isBusy ? { color: ACCENT } : { dimColor: true })} wrap="truncate-end">
              {tag}
            </Text>
            <Box flexDirection="row" columnGap={1}>
              <Button key={`open:${card.id}`} label={isOpen ? 'Close' : 'Open'} plain dimColor onPress={() => void select($, card.id)} />
              {next !== null && (
                <Button key={`next:${card.id}`} label="›" plain dimColor onPress={() => void move($, card.id, next)} />
              )}
            </Box>
          </Box>
        </Box>
      )
    }

    // The cards as the draggable columns draw them, column by column, Done's latest first.
    const shownIn = (column: Column) => {
      const inColumn = board.filter(card => card.column === column)
      return column === 'done' ? inColumn.slice(-DONE_SHOWN).reverse() : inColumn
    }
    const columnsProps: ColumnsProps = {
      cards: COLUMNS.flatMap((column, index) =>
        shownIn(column).map(card => ({
          id: card.id,
          title: card.title,
          column: index,
          tag: tagOf(card),
          isDone: column === 'done',
          isOpen: card.id === openId,
          isBusy: isLive(card),
        })),
      ),
      names: COLUMNS.map(column => COLUMN_NAME[column]),
      counts: COLUMNS.map(column => board.filter(card => card.column === column).length),
      dots: COLUMNS.map(column => DOT[column].color ?? null),
    }

    // The columns fill the pane below the header, so a card can be dragged anywhere under them; with a
    // card's details or the composer open, they keep their own height and those sit right under them.
    const view = plan === null ? null : forecastView(plan, day)
    const bannerWidth = Math.max(10, e.props.bodyColumns - 4)
    const bannerRows =
      plan === null || view === null
        ? 0
        : 4 +
          (view.dates === '' ? 0 : wrap(view.dates, bannerWidth, 99).length) +
          (plan.note === '' ? 0 : wrap(plan.note, bannerWidth, 99).length)
    const banner =
      plan === null || view === null ? null : (
        <Box key="forecast" flexDirection="column" borderStyle="round" borderColor={TONE[view.tone]} paddingX={1} marginBottom={1}>
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text bold color="#ffffff" backgroundColor={TONE[view.tone]}>
              {` ${view.badge} `}
            </Text>
            {view.headline !== '' && (
              <Text bold color={TONE[view.tone]}>
                {view.headline}
              </Text>
            )}
          </Box>
          {view.dates !== '' && (
            <Text dimColor wrap="wrap">
              {view.dates}
            </Text>
          )}
          {plan.note !== '' && <Text wrap="wrap">{plan.note}</Text>}
        </Box>
      )

    const contentRows = columnsHeightFor(columnsProps.cards, e.props.bodyColumns)
    const fillRows = e.props.scroll.bodyRows - HEADER_ROWS - bannerRows
    const columnsHeight = open !== undefined || writing !== null ? contentRows : Math.max(contentRows, fillRows)

    const columnView = (column: Column) => {
      const inColumn = board.filter(card => card.column === column)
      // Done keeps the latest few: the column that only grows.
      const shown = column === 'done' ? inColumn.slice(-DONE_SHOWN).reverse() : inColumn
      return (
        <Box key={`column:${column}`} flexDirection="column" width="33%" flexShrink={1} rowGap={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text {...DOT[column]} dimColor={DOT[column].color === undefined}>
              ●
            </Text>
            <Text bold>{COLUMN_NAME[column]}</Text>
            <Text dimColor>{String(inColumn.length)}</Text>
          </Box>
          {shown.map(cardView)}
          {shown.length === 0 && (
            <Box borderStyle="round" borderDimColor paddingX={1}>
              <Text dimColor>No cards</Text>
            </Box>
          )}
          {inColumn.length > shown.length && <Text dimColor>{`+${inColumn.length - shown.length} earlier`}</Text>}
        </Box>
      )
    }

    // How far along the board is: the done cards of all.
    const doneCount = board.filter(card => card.column === 'done').length
    const filled = board.length === 0 ? 0 : Math.round((doneCount / board.length) * BAR)
    const newCard =
      Input === undefined || writing !== null ? null : (
        <Button key="new" label="+ New card" variant="secondary" onPress={() => void compose($, null)} />
      )
    const progress = (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Box flexDirection="row">
          {filled > 0 && <Text color={GREEN}>{'■'.repeat(filled)}</Text>}
          {filled < BAR && <Text dimColor>{'□'.repeat(BAR - filled)}</Text>}
        </Box>
        <Text dimColor>{`${doneCount} of ${board.length} done`}</Text>
      </Box>
    )
    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} marginBottom={1}>
        {board.length === 0 ? <Text bold>Nothing on the board yet</Text> : progress}
        {newCard}
      </Box>
    )

    const details = (card: Card) => {
      const left = neighbour(card.column, -1)
      const right = neighbour(card.column, 1)
      const session = card.session
      return (
        <Box key={`details:${card.id}`} flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Box flexDirection="row" columnGap={1} flexShrink={1}>
              <Text {...DOT[card.column]} dimColor={DOT[card.column].color === undefined}>
                ●
              </Text>
              <Text bold wrap="wrap">
                {card.title}
              </Text>
            </Box>
            <Button key="close" label="✕" plain dimColor onPress={() => void select($, null)} />
          </Box>
          <Text dimColor>{`${COLUMN_NAME[card.column]} · ${sourceName(card.source)}`}</Text>
          {card.session === undefined ? (
            <Text dimColor wrap="wrap">{`To follow a session on this card, start its first prompt with ${cardTag(card.id)}`}</Text>
          ) : (
            <Text {...(card.session.state === 'running' ? { color: ACCENT } : { dimColor: true })} wrap="wrap">
              {sessionText(card.session, now)}
            </Text>
          )}
          {card.note !== '' && (
            <Box marginTop={1}>
              <Text wrap="wrap">{card.note}</Text>
            </Box>
          )}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1} marginBottom={1}>
            {session?.host != null && (
              <Button key="open-session" label="↗ Open session" variant="primary" onPress={() => void openSession($, session)} />
            )}
            {card.column !== 'done' && (
              <Button
                key="work"
                label={card.id === busy ? 'Claude is on it' : '▶ Work on it'}
                variant="secondary"
                onPress={() => void workOn($, card)}
              />
            )}
            {left !== null && (
              <Button key="left" label={`‹ ${COLUMN_NAME[left]}`} variant="secondary" onPress={() => void move($, card.id, left)} />
            )}
            {right !== null && (
              <Button key="right" label={`${COLUMN_NAME[right]} ›`} variant="secondary" onPress={() => void move($, card.id, right)} />
            )}
            <Button key="edit" label="Edit" plain dimColor onPress={() => void compose($, card)} />
            {session !== undefined && <Button key="unlink" label="Unlink" plain dimColor onPress={() => void unlink($, card.id)} />}
            <Button key="delete" label="Delete" plain dimColor onPress={() => void remove($, card.id)} />
          </Box>
        </Box>
      )
    }

    return (
      // A focus ring at the content's top or bottom edge is cut off: keep a line below the last element.
      <Box flexDirection="column" paddingBottom={1}>
        {banner}
        {board.length === 0 ? (
          <Box flexDirection="column">
            {header}
            <Text dimColor wrap="wrap">
              Add a card with New card. Claude's to-do list and the plans you approve show up here by themselves, and Claude can add
              cards when you ask it to put something on the board.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {header}
            {Client !== undefined ? (
              // Dragging needs the pointer, which only a Client hears: it draws the columns itself.
              <Client key="columns" module="./columns.tsx" props={columnsProps} width="100%" height={columnsHeight} />
            ) : (
              <Box flexDirection="row" columnGap={1}>
                {COLUMNS.map(columnView)}
              </Box>
            )}
          </Box>
        )}
        {writing !== null && Input !== undefined && (
          <Box
            key="composer"
            flexDirection="column"
            borderStyle="round"
            borderColor={ACCENT}
            paddingX={1}
            paddingY={1}
            rowGap={1}
            marginTop={1}
          >
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{writing.id === null ? 'New card' : 'Edit card'}</Text>
              <Button key="cancel-x" label="✕" plain dimColor onPress={() => void update($, composer, () => null)} />
            </Box>
            {/* One field at a time: each field's Enter label is drawn as a button, always. */}
            {!writing.hasNote ? (
              <Box flexDirection="column" rowGap={1}>
                <Input
                  key="title"
                  label="Title"
                  placeholder="What needs doing"
                  value={writing.title}
                  submitLabel={saveLabel}
                  autoFocus
                  onInput={text => void typeIn($, 'title', text)}
                  onSubmit={text => void typeIn($, 'title', text).then(() => saveComposer($))}
                />
                <Box>
                  <Button
                    key="add-note"
                    label={writing.note === '' ? '+ Description' : 'Edit description'}
                    plain
                    dimColor
                    onPress={() => void showNote($)}
                  />
                </Box>
              </Box>
            ) : (
              <Box flexDirection="column" rowGap={1}>
                <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
                  <Text bold wrap="wrap">
                    {writing.title === '' ? 'Untitled' : writing.title}
                  </Text>
                  <Button key="back-title" label="‹ Title" plain dimColor onPress={() => void showTitle($)} />
                </Box>
                <Input
                  key="note"
                  label="Description"
                  placeholder="Why, where, what done means"
                  value={writing.note}
                  submitLabel={saveLabel}
                  autoFocus
                  onInput={text => void typeIn($, 'note', text)}
                  onSubmit={text => void typeIn($, 'note', text).then(() => saveComposer($))}
                />
              </Box>
            )}
          </Box>
        )}
        {open !== undefined && details(open)}
      </Box>
    )
  })
}
