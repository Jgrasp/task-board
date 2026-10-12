import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Card } from '../types'
import {
  CARD_LIMIT,
  addCard,
  applyLinks,
  boardText,
  forecastView,
  hostOf,
  parseLink,
  planSteps,
  runBoardTool,
  syncTodos,
  taggedCard,
  taskCreated,
  taskUpdated,
} from '../hooks/lib'
import { cardAt, columnAt, layout, wrap } from '../hooks/columns'
import type { ColumnCard } from '../hooks/columns'

const NOW = Date.parse('2026-10-06T10:00:00Z')
const TOOL = 'mcp__task-board__board'

const PANE = {
  plugin: 'task-board',
  component: 'Pane',
  requestId: 'task-board',
  // The plain columns, with Open and ›: the desktop and the terminal draw them as a Client (tested below).
  surface: 'vscode',
  props: {
    title: 'Board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PLAN = `# Offline mode

## Context
Trips recorded without a connection are lost.

## Changes
1. Add an **offline queue** to \`TripStore\`
2. Show an offline banner on the map
3. Flush the queue when the connection returns

## Verification
- Run \`TripStoreTests\`
- Try it in airplane mode
`

type Fake = { opened: string[]; prompts: string[]; toasts: string[]; clock: MockClock }

/** Stands in for the session, the tools beneath the mod and the surface. */
async function fake($: Engine, on: On): Promise<Fake> {
  const state: Fake = { opened: [], prompts: [], toasts: [], clock: mock.clock(on, { now: NOW }) }
  on('command.register', () => ({ value: { command: 'board' } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__task-board__${e.name}` } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.open', ($, e) => {
    state.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.focus', () => ({}))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    state.prompts.push(e.text)

    return { text: e.text }
  })
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {}, text: 'Todos updated' }))
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => ({ result: { task: { id: String(e.subject.length), subject: e.subject } }, text: 'Task created' }))
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: {}, text: 'Task updated' }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: PLAN, isAgent: false }, text: 'Plan approved' }))
  await $.session.start({ cwd: '/work/orbit', surface: 'desktop', isInteractive: true })

  return state
}

type Ui = Mounted<'vscode', 'Pane'>

const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(one => one.text)

/** The cards' titles, column by column: To do, Doing, Done. */
const titles = async (ui: Ui, ...known: string[]) => (await texts(ui)).filter(text => known.includes(text))

/** Writes a card in the composer, as a person does: + New card, the title, the description, Add card. */
async function newCard(ui: Ui, title: string, note = ''): Promise<void> {
  await ui.press({ key: 'new' })
  if (note === '') {
    await ui.input({ key: 'title', text: title })
    return
  }
  await ui.input({ key: 'title', text: title, kind: 'change' })
  await ui.press({ key: 'add-note' })
  await ui.input({ key: 'note', text: note })
}

/** Opens the card titled `title`: its Open link, found by the card around it. */
async function openCard(ui: Ui, title: string): Promise<void> {
  const card = (await ui.findAll({ type: 'Box' })).find(
    box => box.key?.startsWith('card:') === true && JSON.stringify(box.children ?? []).includes(JSON.stringify(title)),
  )
  await ui.press({ key: `open:${card?.key?.slice('card:'.length) ?? ''}` })
}

describe('pane', () => {
  test('an empty board says what fills it; New card writes a card with a title and a description', async ($, on) => {
    const state = await fake($, on)
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: 'Nothing on the board yet' })).toBeDefined()
    expect(await ui.find({ key: 'title' })).toBeUndefined()

    // A title is needed.
    await ui.press({ key: 'new' })
    expect(await ui.find({ type: 'Text', text: 'New card' })).toBeDefined()
    expect(await ui.find({ key: 'new' })).toBeUndefined()
    expect(await ui.find({ key: 'note' })).toBeUndefined()
    await ui.input({ key: 'title', text: '' })
    expect(state.toasts).toEqual(['Give the card a title.'])

    await ui.input({ key: 'title', text: 'Fix login crash on iOS 17', kind: 'change' })
    await ui.press({ key: 'add-note' })
    // One field at a time: the title shows as text above the description.
    expect(await ui.find({ key: 'title' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Fix login crash on iOS 17' })).toBeDefined()
    await ui.press({ key: 'back-title' })
    expect(await ui.find({ key: 'note' })).toBeUndefined()
    await ui.press({ key: 'add-note' })
    await ui.input({ key: 'note', text: 'Crashes on launch when signed out' })
    expect(await ui.find({ key: 'title' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Fix login crash on iOS 17' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '≡' })).toBeDefined()
    expect(await texts(ui)).toEqual(expect.arrayContaining(['To do', '1', 'Doing', '0', 'Done', 'No cards', '0 of 1 done']))
    expect(state.opened).toEqual([])
  })

  test("Claude's to-do list fills the board and moves its cards; the first cards open the pane", async ($, on) => {
    const state = await fake($, on)
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Add the offline queue', status: 'completed', activeForm: 'Adding the offline queue' },
        { content: 'Show the banner', status: 'in_progress', activeForm: 'Showing the banner' },
        { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
      ],
    })
    expect(state.opened).toEqual(['task-board'])

    const ui = await $.ui.mount(PANE)
    // Cards read column by column: To do, Doing, Done.
    const todo = ['Write tests', 'Show the banner', 'Add the offline queue']
    // Done cards carry a tick.
    expect(await titles(ui, ...todo, '✓ Add the offline queue')).toEqual(['Write tests', 'Show the banner', '✓ Add the offline queue'])
    expect(await texts(ui)).toEqual(expect.arrayContaining(['■■■■', '□□□□□□□□', '1 of 3 done', '✦']))

    // Claude finishes the banner and drops "Write tests" from its list.
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Add the offline queue', status: 'completed', activeForm: 'Adding the offline queue' },
        { content: 'Show the banner', status: 'completed', activeForm: 'Showing the banner' },
      ],
    })
    expect(await titles(ui, ...todo, '✓ Show the banner', '✓ Add the offline queue')).toEqual(['✓ Show the banner', '✓ Add the offline queue'])
    expect(state.opened).toEqual(['task-board'])
  })

  test('the task tools Claude may keep its list with move cards too', async ($, on) => {
    await fake($, on)
    await $.tool.call({ tool: 'TaskCreate', subject: 'Bump the version', description: 'To 2.4 on both platforms' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: String('Bump the version'.length), status: 'in_progress' })

    const ui = await $.ui.mount(PANE)
    await openCard(ui, 'Bump the version')
    expect(await texts(ui)).toEqual(expect.arrayContaining(["Doing · From Claude's to-do list", 'To 2.4 on both platforms']))

    await $.tool.call({ tool: 'TaskUpdate', taskId: String('Bump the version'.length), status: 'deleted' })
    expect(await ui.find({ type: 'Text', text: 'Bump the version' })).toBeUndefined()
  })

  test('an approved plan puts its steps in To do', async ($, on) => {
    await fake($, on)
    await $.tool.call({ tool: 'ExitPlanMode' })

    const ui = await $.ui.mount(PANE)
    const steps = ['Add an offline queue to TripStore', 'Show an offline banner on the map', 'Flush the queue when the connection returns']
    expect(await titles(ui, ...steps)).toEqual(steps)
    expect(await texts(ui)).toEqual(expect.arrayContaining(['◆']))

    // A card's › moves it a column on.
    const first = (await ui.findAll({ type: 'Button' })).find(one => one.key?.startsWith('next:'))
    await ui.press({ key: first?.key ?? '' })
    expect(await texts(ui)).toEqual(expect.arrayContaining(['Doing', '1']))
  })

  test('Claude adds, lists, moves and removes cards with the board tool', async ($, on) => {
    await fake($, on)
    const added = await $.tool.call({ tool: TOOL, action: 'add', title: 'Localise the banner', note: 'German and Italian' })
    expect(added.text).toMatch(/^Added "Localise the banner" to To do \(c\w+\)\.$/)
    const again = await $.tool.call({ tool: TOOL, action: 'add', title: 'localise the banner' })
    expect(again.text).toMatch(/is already on the board/)

    const moved = await $.tool.call({ tool: TOOL, action: 'move', card: 'Localise the banner', column: 'done' })
    expect(moved.text).toBe('Moved "Localise the banner" to Done.')
    const listed = await $.tool.call({ tool: TOOL, action: 'list' })
    expect(listed.text).toMatch(/^To do \(0\)\n\nDoing \(0\)\n\nDone \(1\)\n- \[c\w+\] Localise the banner$/)

    const wrong = await $.tool.call({ tool: TOOL, action: 'move', card: 'nope', column: 'done' })
    expect(wrong.isError).toBe(true)
    expect(wrong.text).toContain('No card "nope"')

    const removed = await $.tool.call({ tool: TOOL, action: 'remove', card: 'Localise the banner' })
    expect(removed.text).toBe('Removed "Localise the banner".')
  })

  test('a card opens its details: move it, hand it to Claude, delete it', async ($, on) => {
    const state = await fake($, on)
    const ui = await $.ui.mount(PANE)
    await newCard(ui, 'Add an offline banner')
    await openCard(ui, 'Add an offline banner')
    expect(await texts(ui)).toEqual(expect.arrayContaining(['To do · Added by you']))
    expect(await ui.find({ key: 'left' })).toBeUndefined()

    await ui.press({ key: 'right' })
    expect(await texts(ui)).toEqual(expect.arrayContaining(['Doing · Added by you']))
    expect((await ui.find({ key: 'left' }))?.text).toBe('‹ To do')
    expect((await ui.find({ key: 'right' }))?.text).toBe('Done ›')

    await ui.press({ key: 'work' })
    expect(state.prompts).toEqual(['Work on this card from the task board: "Add an offline banner"'])
    expect((await ui.find({ key: 'work' }))?.text).toBe('Claude is on it')

    // Edit opens the composer on the card.
    await ui.press({ key: 'edit' })
    expect(await ui.find({ type: 'Text', text: 'Edit card' })).toBeDefined()
    expect(await ui.find({ key: 'note' })).toBeUndefined()
    expect((await ui.find({ key: 'add-note' }))?.text).toBe('+ Description')
    await ui.press({ key: 'add-note' })
    await ui.input({ key: 'note', text: 'Show it while offline' })
    expect(await texts(ui)).toEqual(expect.arrayContaining(['Show it while offline']))

    await ui.press({ key: 'delete' })
    expect(await ui.find({ type: 'Text', text: 'Nothing on the board yet' })).toBeDefined()
  })

  test('/board opens the pane', async ($, on) => {
    const state = await fake($, on)
    const ran = await $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(ran.text).toBe('Board opened.')
    expect(state.opened).toEqual(['task-board'])
  })
})

describe('dragging', () => {
  /** Where a card's middle is, in the Client's cells, laid out as the module does at 60 columns. */
  const spot = (cards: ColumnCard[], id: string) => {
    const at = layout(cards, 60)
    const card = at.cards.find(one => one.id === id)
    return { x: (card?.column ?? 0) * (at.columnWidth + 1) + 3, y: (card?.top ?? 0) + 1, columnWidth: at.columnWidth }
  }

  test('a card dragged onto another column moves there; a click opens it', async ($, on) => {
    await fake($, on)
    for (const title of ['Add an offline banner', 'Fix login crash']) await $.tool.call({ tool: TOOL, action: 'add', title })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.resize({ columns: 60, rows: 30, in: 'columns' })

    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('"module":"hooks/columns.tsx"')
    // The columns fill the pane under the header (40 rows less 3), so a drag below the cards is not cut.
    expect(drawn).toContain('"width":"100%","height":37')
    const listed = await $.tool.call({ tool: TOOL, action: 'list' })
    const ids = [...(listed.text ?? '').matchAll(/\[(c\w+)\]/g)].map(match => match[1] ?? '')
    const cards: ColumnCard[] = ids.map((id, index) => ({
      id, title: index === 0 ? 'Add an offline banner' : 'Fix login crash', column: 0, tag: '✦', isDone: false, isOpen: false, isBusy: false,
    }))
    const from = spot(cards, ids[0] ?? '')

    // Press, drag right into Done, release.
    await ui.pointer({ type: 'down', x: from.x, y: from.y, button: 'left' })
    await ui.pointer({ type: 'move', x: from.x + from.columnWidth + 1, y: from.y, button: 'left' })
    await ui.pointer({ type: 'move', x: from.x + 2 * (from.columnWidth + 1), y: from.y, button: 'left' })
    // Mid-drag: the column under the pointer offers a slot.
    const midDrag = JSON.stringify(await ui.drawn({ in: 'columns' }))
    expect(midDrag).toContain('Drop here')
    // The ghost follows the pointer, held where the card was grabbed.
    expect(midDrag).toMatch(new RegExp(`"key":"ghost","position":"absolute","top":${from.y - 1},"left":${2 * (from.columnWidth + 1)}`))
    await ui.pointer({ type: 'up', x: from.x + 2 * (from.columnWidth + 1), y: from.y, button: 'left' })
    expect((await $.tool.call({ tool: TOOL, action: 'list' })).text).toMatch(/Done \(1\)\n- \[c\w+\] Add an offline banner/)

    // A press and release in place opens the card.
    const still = spot([cards[1] as ColumnCard], ids[1] ?? '')
    await ui.pointer({ type: 'down', x: still.x, y: still.y, button: 'left' })
    await ui.pointer({ type: 'up', x: still.x, y: still.y, button: 'left' })
    expect(await ui.find({ type: 'Text', text: 'To do · Added by Claude' })).toBeDefined()
    // With a card's details open below, the columns keep their own height.
    expect(JSON.stringify(await ui.drawn())).not.toContain('"height":37')

    // A drag released in its own column moves nothing.
    await ui.pointer({ type: 'down', x: still.x, y: still.y, button: 'left' })
    await ui.pointer({ type: 'move', x: still.x + 3, y: still.y + 2, button: 'left' })
    await ui.pointer({ type: 'up', x: still.x + 3, y: still.y + 2, button: 'left' })
    expect((await $.tool.call({ tool: TOOL, action: 'list' })).text).toMatch(/To do \(1\)/)
  })

  test('the terminal drags too: its pane draws the same Client', async ($, on) => {
    await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Drag me' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.resize({ columns: 60, rows: 20, in: 'columns' })
    expect(JSON.stringify(await ui.drawn())).toContain('"module":"hooks/columns.tsx"')

    const at = layout([{ id: 'x', title: 'Drag me', column: 0, tag: '✦', isDone: false, isOpen: false, isBusy: false }], 60)
    const y = (at.cards[0]?.top ?? 1) + 1
    await ui.pointer({ type: 'down', x: 3, y, button: 'left' })
    await ui.pointer({ type: 'move', x: 3 + at.columnWidth + 1, y, button: 'left' })
    await ui.pointer({ type: 'up', x: 3 + at.columnWidth + 1, y, button: 'left' })
    expect((await $.tool.call({ tool: TOOL, action: 'list' })).text).toMatch(/Doing \(1\)\n- \[c\w+\] Drag me/)
  })

  test('a message naming no card, or no column, changes nothing', async ($, on) => {
    await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Keep me' })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.post({ type: 'move', id: 'nope', column: 2 })
    await ui.post({ type: 'move', id: 7, column: 'done' })
    await ui.post('garbage')
    expect((await $.tool.call({ tool: TOOL, action: 'list' })).text).toMatch(/To do \(1\)/)
  })

  test('layout: wrapped titles, cards a row apart, and what the pointer lands on', () => {
    expect(wrap('Flush the queue when the connection returns', 12)).toEqual(['Flush the', 'queue when', 'the', 'connection…'])
    expect(wrap('Supercalifragilistic', 8, 3)).toEqual(['Supercal', 'ifragili', 'stic'])
    const cards: ColumnCard[] = [
      { id: 'a', title: 'One', column: 0, tag: '', isDone: false, isOpen: false, isBusy: false },
      { id: 'b', title: 'Two words here', column: 0, tag: '', isDone: false, isOpen: false, isBusy: false },
      { id: 'c', title: 'Done thing', column: 2, tag: '', isDone: true, isOpen: false, isBusy: false },
    ]
    const at = layout(cards, 62)
    expect(at.columnWidth).toBe(20)
    expect(at.cards.map(card => [card.id, card.top, card.bottom])).toEqual([['a', 1, 4], ['b', 6, 9], ['c', 1, 4]])
    expect(cardAt(at, 2, 7)?.id).toBe('b')
    expect(cardAt(at, 2, 5)).toBeUndefined()
    expect(cardAt(at, 45, 2)?.id).toBe('c')
    expect(columnAt(21, 20)).toBe(1)
  })
})

describe('lib', () => {
  test('planSteps: numbered items, else bullets, else headings that are steps', () => {
    expect(planSteps(PLAN)).toEqual([
      'Add an offline queue to TripStore',
      'Show an offline banner on the map',
      'Flush the queue when the connection returns',
    ])
    expect(planSteps('Intro\n- [ ] One thing\n- Another: [docs](https://example.com)\n')).toEqual(['One thing', 'Another: docs'])
    expect(planSteps('## Context\nwhy\n## Step 1: Model\n## Step 2 - Views\n## Verification\n')).toEqual(['Model', 'Views'])
    expect(planSteps('Just a sentence.')).toEqual([])
  })

  test('syncTodos keeps your cards and only replaces its own', () => {
    const mine = addCard([], { title: 'My card', source: 'you' }, NOW).cards
    const synced = syncTodos(mine, [{ content: 'Claude card', status: 'pending' }], NOW)
    expect(synced.map(card => [card.title, card.column, card.source])).toEqual([
      ['My card', 'todo', 'you'],
      ['Claude card', 'todo', 'todo'],
    ])
    expect(syncTodos(synced, [], NOW).map(card => card.title)).toEqual(['My card'])
  })

  test('task tools, the card limit and the board as text', () => {
    let board: Card[] = taskCreated([], { id: '7', subject: 'Ship it' }, NOW)
    board = taskUpdated(board, { taskId: '7', status: 'completed', subject: 'Ship 2.4' })
    expect(board.map(card => [card.title, card.column])).toEqual([['Ship 2.4', 'done']])
    expect(taskUpdated(board, { taskId: 'missing', status: 'deleted' })).toEqual(board)

    let many: Card[] = []
    for (let n = 0; n < CARD_LIMIT + 5; n += 1) many = addCard(many, { title: `Card ${n}`, source: 'you', column: n < 10 ? 'done' : 'todo' }, NOW).cards
    expect(many).toHaveLength(CARD_LIMIT)
    expect(many.filter(card => card.column === 'done')).toHaveLength(5)

    expect(boardText([])).toBe('The board is empty.')
    expect(runBoardTool([], { action: 'fly' }, NOW)).toMatchObject({ isError: true, text: 'action is list, add, move, remove, link or forecast.' })
    expect(runBoardTool([], { action: 'add', title: 'x', column: 'later' }, NOW)).toMatchObject({ isError: true })
  })
})

describe('sessions and deadline', () => {
  const LINKS = '/home/me/.claude/task-board/links'

  type World = { files: Map<string, { text: string; mtime: number }>; runs: string[][] }

  function world(on: On, files: Record<string, unknown> = {}): World {
    const state: World = {
      files: new Map(Object.entries(files).map(([name, data]) => [`${LINKS}/${name}`, { text: JSON.stringify(data), mtime: 1 }])),
      runs: [],
    }
    on('fs.list', ($, e) => ({
      value: [...state.files.entries()]
        .filter(([path]) => path.startsWith(`${e.path}/`))
        .map(([path, file]) => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: file.mtime, isLink: false })),
    }))
    on('fs.read', ($, e) => {
      const file = state.files.get(e.path)
      if (file === undefined) throw new Error(`ENOENT ${e.path}`)
      return { value: file.text }
    })
    on('fs.write', ($, e) => {
      state.files.set(e.path, { text: e.text, mtime: (state.files.get(e.path)?.mtime ?? 0) + 1 })
      return { value: undefined }
    })
    on('process.run', ($, e) => {
      state.runs.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('session.id', () => ({ value: 'cli-child' }))
    on('turn.complete', () => ({ text: '' }))

    return state
  }

  test('a session started with a card tag reports to the card: working, then waiting', async ($, on) => {
    mock.env(on, { HOME: '/home/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1111aaaa-2222-3333-4444-555566667777' })
    const files = world(on)
    await fake($, on)
    await $.prompt.submit({ text: '[board:c9z1] Write the offline banner', wait: false, origin: { kind: 'composer' } })
    expect(JSON.parse(files.files.get(`${LINKS}/c9z1.json`)?.text ?? '{}')).toEqual({
      card: 'c9z1',
      id: 'cli-child',
      host: 'local_1111aaaa-2222-3333-4444-555566667777',
      state: 'running',
      at: NOW,
    })
    await $.turn.complete({ reason: 'answer', answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1' })
    expect(JSON.parse(files.files.get(`${LINKS}/c9z1.json`)?.text ?? '{}').state).toBe('idle')
  })

  test('the board follows a linked session and opens it', async ($, on) => {
    mock.env(on, { HOME: '/home/me' })
    const files = world(on)
    const state = await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Write the offline banner' })
    const id = String((await $.tool.call({ tool: TOOL, action: 'list' })).text).match(/\[(c\w+)\]/)?.[1] ?? ''
    const link = { card: id, id: 'cli-child', host: 'local_1111aaaa-2222-3333-4444-555566667777', state: 'running', at: NOW }
    files.files.set(`${LINKS}/${id}.json`, { text: JSON.stringify(link), mtime: 1 })
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: '✦' })).toBeDefined()

    await state.clock.advance(5_000)
    expect(await ui.find({ type: 'Text', text: '✦ ⇄' })).toBeDefined()
    await openCard(ui, 'Write the offline banner')
    expect(await texts(ui)).toEqual(expect.arrayContaining(['Doing · Added by Claude', 'Session · Working · active just now']))
    await ui.press({ key: 'open-session' })
    expect(files.runs).toEqual([['xdg-open', 'claude://claude.ai/epitaxy/local_1111aaaa-2222-3333-4444-555566667777']])

    await ui.press({ key: 'unlink' })
    expect(files.runs.at(-1)).toEqual(['rm', '-f', `${LINKS}/${id}.json`])
    expect(await ui.find({ key: 'open-session' })).toBeUndefined()
  })

  const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as const

  test('Claude links a card by hand and keeps a deadline banner', async ($, on) => {
    mock.env(on, { HOME: '/home/me' })
    const files = world(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
    const state = await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Ship the release' })
    const linked = await $.tool.call({ tool: TOOL, action: 'link', card: 'Ship the release', session: 'claude://claude.ai/epitaxy/local_aaaabbbb-cccc' })
    expect(linked.text).toBe('Linked "Ship the release" to session local_aaaabbbb-cccc.')
    expect([...files.files.keys()]).toEqual([expect.stringMatching(/\/c\w+\.json$/)])

    const set = await $.tool.call({ tool: TOOL, action: 'forecast', deadline: '2026-10-16', finish: '2026-10-13', note: 'QA on Wednesday' })
    expect(set.text).toBe('Deadline banner: on track, 3 days of margin (deadline 2026-10-16, finish 2026-10-13, note "QA on Wednesday").')
    expect(state.opened).toEqual(['task-board'])
    const ui = await $.ui.mount(PANE)
    expect(await texts(ui)).toEqual(expect.arrayContaining([' ON TRACK ', '3 days of margin', 'Deadline Fri 16 Oct (in 10 days) · Finish Tue 13 Oct', 'QA on Wednesday']))
    const prompt = await $.prompt.compose(COMPOSE)
    expect(prompt.sections.at(-1)?.id).toBe('task-board:forecast')
    expect(prompt.sections.at(-1)?.text).toContain('Deadline: 2026-10-16 (in 10 days). Your forecast finish: 2026-10-13, set on 2026-10-06.')

    await $.tool.call({ tool: TOOL, action: 'forecast', finish: '2026-10-19' })
    expect(await texts(ui)).toEqual(expect.arrayContaining([' LATE ', 'Finishing 3 days late']))
    const bad = await $.tool.call({ tool: TOOL, action: 'forecast', finish: '19/10' })
    expect(bad.isError).toBe(true)

    await $.tool.call({ tool: TOOL, action: 'forecast', deadline: '', finish: '', note: '' })
    expect(await ui.find({ key: 'forecast' })).toBeUndefined()
    expect((await $.prompt.compose(COMPOSE)).sections.map(one => one.id)).toEqual(['intro'])
  })

  test('forecast tones, tags and links', () => {
    const at = { note: '', tone: null, updatedAt: NOW } as const
    expect(forecastView({ ...at, deadline: '2026-10-16', finish: '2026-10-15' }, '2026-10-06')).toMatchObject({ tone: 'tight', headline: '1 day of margin' })
    expect(forecastView({ ...at, deadline: '2026-10-16', finish: '2026-10-16' }, '2026-10-06')).toMatchObject({ tone: 'tight', headline: 'No margin left' })
    expect(forecastView({ ...at, deadline: '2026-10-16', finish: null }, '2026-10-06')).toMatchObject({ tone: 'info', badge: 'DEADLINE', headline: 'Due in 10 days' })
    expect(forecastView({ ...at, deadline: '2026-10-01', finish: null }, '2026-10-06')).toMatchObject({ tone: 'late', headline: 'Deadline passed 5 days ago' })
    expect(forecastView({ ...at, deadline: null, finish: null, note: 'Demo on Friday', tone: 'ok' }, '2026-10-06')).toMatchObject({ tone: 'ok', dates: '' })

    expect(taggedCard('[board:c1x2] Do it')).toBe('c1x2')
    expect(taggedCard('board c1x2')).toBeNull()
    expect(hostOf('claude://claude.ai/epitaxy/local_626b34e5-82c4')).toBe('local_626b34e5-82c4')
    expect(hostOf('a2c8724d-de77')).toBeNull()
    expect(parseLink('{"host":"local_1"}')).toEqual({ id: null, host: 'local_1', state: null, at: 0 })
    expect(parseLink('{"state":"idle"}')).toBeNull()
    expect(parseLink('nope')).toBeNull()

    const board = addCard([], { title: 'Ship it', source: 'you' }, NOW).cards
    const id = board[0]?.id ?? ''
    const linked = applyLinks(board, [{ card: id, link: { id: 's', host: null, state: 'idle', at: NOW } }])
    expect(linked[0]).toMatchObject({ column: 'doing', session: { id: 's', state: 'idle' } })
    expect(boardText(linked)).toContain('Ship it (session: waiting for you)')
    expect(runBoardTool(linked, { action: 'link', card: id, session: 'nope' }, NOW).isError).toBe(true)
    expect(runBoardTool(linked, { action: 'link', card: id, session: '' }, NOW).cards[0]?.session).toBeUndefined()
  })
})
