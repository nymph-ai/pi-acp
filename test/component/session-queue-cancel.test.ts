import test from 'node:test'
import assert from 'node:assert/strict'
import type { PiPromptInsertion, PiRpcProcess } from '../../src/pi-rpc/process.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')

  // first started, second+third queued
  assert.equal(proc.prompts.length, 1)

  await session.cancel()

  assert.equal(proc.abortCount, 1)

  // queued prompts should resolve as cancelled
  assert.equal(await second, 'cancelled')
  assert.equal(await third, 'cancelled')

  // finish first prompt as cancelled after abort
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'cancelled')

  // queue should have been cleared, so no further prompt started
  assert.equal(proc.prompts.length, 1)
})

test('PiAcpSession exposes native insertion separately from foreground completion', async () => {
  const proc = new FakePiRpcProcess()
  const prompt = proc.prompt.bind(proc)
  proc.prompt = async (message, attachments) => {
    await prompt(message, attachments)
    return 'started'
  }
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const first = session.submitPrompt('one')
  const second = session.submitPrompt('two')
  let insertionObserved = false
  let completed = false
  void first.inserted.then(() => {
    insertionObserved = true
  })
  void first.completed.then(() => {
    completed = true
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(insertionObserved, false)
  assert.equal(proc.prompts.length, 1)

  const message = { role: 'user', content: 'one', timestamp: 17 }
  proc.emit({ type: 'message_end', message })
  assert.deepEqual(await first.inserted, message)
  assert.equal(completed, false)

  await session.cancel()
  assert.equal(await second.inserted, null)
  assert.equal(await second.completed, 'cancelled')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first.completed, 'cancelled')
})

test('PiAcpSession settles a native handled prompt without inventing an insertion', async () => {
  const proc = new FakePiRpcProcess()
  proc.prompt = async () => 'handled' as const
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const prompt = session.submitPrompt('/handled-by-pi')
  assert.equal(await prompt.inserted, null)
  assert.equal(await prompt.completed, 'end_turn')
})

test('PiAcpSession waits for the native keyed receipt and settles a retained retry without a turn', async () => {
  let respond!: (receipt: PiPromptInsertion) => void
  const seen: string[] = []
  const proc = Object.assign(new FakePiRpcProcess(), {
    promptWithId: (_message: string, clientMessageId: string) => {
      seen.push(clientMessageId)
      return new Promise<PiPromptInsertion>(resolve => {
        respond = resolve
      })
    }
  })
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const prompt = session.submitKeyedPrompt('one', 'client-1')
  let inserted = false
  void prompt.inserted.then(() => {
    inserted = true
  })
  proc.emit({ type: 'message_end', message: { role: 'user', content: 'one' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(inserted, false)
  assert.deepEqual(seen, ['client-1'])

  const receipt = { clientMessageId: 'client-1', entryId: 'native-1', disposition: 'reused' } as const
  respond(receipt)
  assert.deepEqual(await prompt.inserted, receipt)
  assert.equal(await prompt.completed, 'end_turn')
  assert.equal(proc.prompts.length, 0)
})
