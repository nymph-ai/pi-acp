import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import * as v2 from 'acp-v2-sdk/experimental/v2/unstable'
import { piAgentRouter } from '../../src/acp/v2-agent.js'
import { PiRpcProcess, type PiPromptInsertion, type PiSessionEntry } from '../../src/pi-rpc/process.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'

class Session extends FakePiRpcProcess {
  disposed = false
  starts = 0
  active = false

  constructor(
    readonly id: string,
    readonly file: string,
    readonly entries: PiSessionEntry[]
  ) {
    super()
  }

  override async getState() {
    return {
      sessionId: this.id,
      sessionFile: this.file,
      thinkingLevel: 'medium',
      model: { provider: 'test', id: 'model' }
    }
  }

  async getEntries() {
    return { entries: [...this.entries], leafId: this.entries.at(-1)?.id ?? null }
  }

  async promptWithId(
    message: string,
    clientMessageId: string,
    _images?: unknown[],
    clientContent?: string
  ): Promise<PiPromptInsertion> {
    const retained = this.entries.find(entry => entry.clientSubmission?.messageId === clientMessageId)
    if (retained) {
      return {
        clientMessageId,
        entryId: retained.id,
        disposition: 'reused',
        clientContent: retained.clientSubmission?.clientContent
      }
    }
    this.starts++
    this.active = true
    this.emit({ type: 'agent_start' })
    const entryId = `native-${this.entries.length}`
    this.append({
      id: entryId,
      parentId: this.entries.at(-1)?.id ?? null,
      type: 'message',
      message: { role: 'user', content: message },
      clientSubmission: { sessionId: this.id, messageId: clientMessageId, clientContent }
    })
    return { clientMessageId, entryId, disposition: 'inserted', clientContent }
  }

  override async abort() {
    await super.abort()
    if (this.active) {
      this.active = false
      this.emit({ type: 'agent_settled', aborted: true })
    }
  }

  finish(text: string) {
    const message = { role: 'assistant', content: [{ type: 'text', text }] }
    this.active = false
    this.append({
      id: `native-${this.entries.length}`,
      parentId: this.entries.at(-1)?.id ?? null,
      type: 'message',
      message
    })
    this.emit({ type: 'message_end', message })
    this.emit({ type: 'turn_end', message: { ...message, stopReason: 'stop' } })
    this.emit({ type: 'agent_settled', aborted: false })
  }

  dispose() {
    this.disposed = true
  }

  async shutdown() {
    this.dispose()
  }

  private append(entry: PiSessionEntry) {
    this.entries.push(entry)
    writeFileSync(this.file, this.entries.map(item => JSON.stringify(item)).join('\n') + '\n')
  }
}

function createStreams() {
  const toAgent = new TransformStream<v2.AnyMessage, v2.AnyMessage>()
  const toClient = new TransformStream<v2.AnyMessage, v2.AnyMessage>()
  return {
    agent: { readable: toAgent.readable, writable: toClient.writable },
    client: { readable: toClient.readable, writable: toAgent.writable }
  }
}

test('Pi router preserves ACP v1 negotiation', async () => {
  const streams = createStreams()
  const router = piAgentRouter()
  router.connect(streams.agent)
  const client = new acp.ClientSideConnection(() => ({}) as acp.Client, streams.client as acp.Stream)
  try {
    const initialized = await client.initialize({ protocolVersion: 1 })
    assert.equal(initialized.protocolVersion, 1)
    assert.equal(initialized._meta?.['nymph.ai/fabric'], undefined)
  } finally {
    router.dispose()
  }
})

test('Pi ACP v2 keeps native receipts, replays a reopened session, and cancels queued prompts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-acp-v2-'))
  const previousHome = process.env.HOME
  const previousPi = process.env.PI_CODING_AGENT_DIR
  process.env.HOME = directory
  process.env.PI_CODING_AGENT_DIR = directory
  const byPath = new Map<string, { id: string; entries: PiSessionEntry[] }>()
  const spawned: Session[] = []
  t.mock.method(PiRpcProcess, 'spawn', async ({ sessionPath }: { sessionPath?: string }) => {
    const file = sessionPath ?? join(directory, `${byPath.size + 1}.jsonl`)
    const native = byPath.get(file) ?? { id: `s${byPath.size + 1}`, entries: [] }
    byPath.set(file, native)
    const process = new Session(native.id, file, native.entries)
    spawned.push(process)
    return process
  })
  const streams = createStreams()
  const router = piAgentRouter(false, false, true)
  router.connect(streams.agent)
  const updates: v2.UpdateSessionNotification[] = []
  const connection = v2
    .client({ name: 'test' })
    .onNotification(v2.methods.client.session.update, ({ params }) => {
      updates.push(params)
    })
    .connect(streams.client)
  const request = connection.agent.request.bind(connection.agent)
  const methods = v2.methods.agent
  try {
    const initialized = await request(methods.initialize, {
      protocolVersion: 2,
      info: { name: 'test', version: 'test' }
    })
    assert.equal(initialized.protocolVersion, 2)
    assert.deepEqual(initialized._meta?.['nymph.ai/fabric'], { keyedTextPrompts: true, keyedResourceLinkPrompts: true })
    const first = await request(methods.session.new, { cwd: directory })
    const second = await request(methods.session.new, { cwd: directory })
    const listed = await request(methods.session.list, {})
    assert.deepEqual(listed.sessions.map(session => session.sessionId).sort(), [first.sessionId, second.sessionId])
    assert.equal(spawned[0]!.disposed, false)

    const params = {
      sessionId: first.sessionId,
      idempotencyKey: 'stable-key',
      prompt: [
        { type: 'text' as const, text: 'hello' },
        { type: 'resource_link' as const, name: 'reference', uri: 'fixture://exact', title: 'keep me' }
      ]
    }
    const receipt = await request(methods.session.prompt, params)
    assert.equal(spawned[0]!.starts, 1)
    assert.equal(spawned[0]!.active, true)
    assert.deepEqual(await request(methods.session.prompt, params), receipt)
    const changed = { ...params, prompt: [...params.prompt].reverse() }
    const invalidParams = (error: unknown) => (error as { code?: number })?.code === -32602
    await assert.rejects(request(methods.session.prompt, changed), invalidParams)
    assert.equal(spawned[0]!.starts, 1)

    const queued = request(methods.session.prompt, { ...params, idempotencyKey: 'queued' })
    const rejected = assert.rejects(queued, (error: unknown) => (error as { code?: number })?.code === -32800)
    await connection.agent.notify(methods.session.cancel, { sessionId: first.sessionId })
    await rejected
    await request(methods.session.close, { sessionId: first.sessionId })
    assert.equal(spawned[0]!.disposed, true)
    assert.equal(spawned[1]!.disposed, false)

    const before = updates.length
    await request(methods.session.resume, { sessionId: first.sessionId, cwd: directory, replayFrom: { type: 'start' } })
    const replay = updates
      .slice(before)
      .filter(update => update.sessionId === first.sessionId)
      .map(frame => frame.update)
    assert.deepEqual(
      replay.map(update => update.sessionUpdate),
      ['user_message', 'replay_complete', 'state_update']
    )
    assert.deepEqual(replay[0], { sessionUpdate: 'user_message', messageId: receipt.messageId, content: params.prompt })
    assert.deepEqual(await request(methods.session.prompt, params), receipt)
    await assert.rejects(request(methods.session.prompt, changed), invalidParams)
    assert.equal(spawned[2]!.starts, 0)

    await request(methods.session.prompt, { ...params, idempotencyKey: 'fresh' })
    spawned[2]!.finish('hello from Pi')
    for (
      let attempt = 0;
      attempt < 30 && !updates.some(({ update }) => update.sessionUpdate === 'agent_message');
      attempt++
    ) {
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.ok(updates.some(({ update }) => update.sessionUpdate === 'agent_message'))
  } finally {
    connection.close()
    router.dispose()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousPi
    rmSync(directory, { recursive: true, force: true })
  }
})
