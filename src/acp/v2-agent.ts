import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import * as v2 from 'acp-v2-sdk/experimental/v2/unstable'
import { PiAcpAgent } from './agent.js'
import type { PiAcpConnection, PiAcpSession, StopReason } from './session.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import type { PiRpcEvent, PiSessionEntry } from '../pi-rpc/process.js'

type StateNotification = Extract<v2.SessionUpdate, { sessionUpdate: 'state_update' }>
type Runtime = {
  session: PiAcpSession
  seen: Set<string>
  receipts: Set<string>
  work: Set<Promise<StopReason>>
  output: Promise<void>
  state: StateNotification
  failed: boolean
  closing: boolean
  permissions: AbortController
  unsubscribe: () => void
}

function invalid(message: string): v2.RequestError {
  return v2.RequestError.invalidParams(undefined, message)
}

async function translateError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof acp.RequestError) throw new v2.RequestError(error.code, error.message, error.data)
    throw error
  }
}

function configure(options: acp.SessionConfigOption[] | null | undefined): v2.SessionConfigOption[] {
  return (options ?? []).flatMap(option => {
    if (option.type !== 'select') return []
    const { id, options, ...fields } = option
    const values = options.map(value => {
      if ('group' in value) {
        const { group, ...fields } = value
        return { groupId: group, ...fields }
      }
      return value
    }) as v2.SessionConfigSelectOptions
    return [{ configId: id, options: values, ...fields }]
  })
}

function branch(entries: PiSessionEntry[], leafId: string | null): PiSessionEntry[] {
  const index = new Map(entries.map(entry => [entry.id, entry]))
  const result: PiSessionEntry[] = []
  while (leafId !== null) {
    const entry = index.get(leafId)
    if (!entry || (entry.parentId !== null && typeof entry.parentId !== 'string')) {
      throw new Error('Pi returned a broken native history branch')
    }
    index.delete(leafId)
    result.push(entry)
    leafId = entry.parentId
  }
  return result.reverse()
}

function idle(reason?: StopReason): StateNotification {
  if (reason === 'error')
    return {
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: 'error',
      error: { code: -32603, message: 'Pi reported a failed turn' }
    }
  if (reason === 'cancelled') return { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' }
  if (reason === 'end_turn') return { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }
  return { sessionUpdate: 'state_update', state: 'idle', stopReason: null }
}

function validateRoots(params: {
  cwd: string
  additionalDirectories?: string[]
  mcpServers?: unknown[]
  configOptions?: unknown[]
  systemPrompt?: unknown
}): void {
  if (!isAbsolute(params.cwd)) throw invalid('cwd must be an absolute path')
  if (
    params.additionalDirectories?.length ||
    params.mcpServers?.length ||
    params.configOptions?.length ||
    params.systemPrompt != null
  ) {
    throw invalid('Pi ACP v2 does not accept additional roots, client MCP servers, initial options, or a system prompt')
  }
}

type Steering = { sessionId: string; message: string; key?: string }

function parseSteering(value: unknown): Steering {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    !('prompt' in value) ||
    !Array.isArray(value.prompt) ||
    value.prompt.length === 0
  ) {
    throw invalid('expected a sessionId and nonempty steering prompt')
  }
  const meta = '_meta' in value ? value._meta : undefined
  const steering = typeof meta === 'object' && meta !== null && 'steering' in meta ? meta.steering : undefined
  if (
    steering !== undefined &&
    (typeof steering !== 'object' ||
      steering === null ||
      ('idleBehavior' in steering && steering.idleBehavior !== 'promptRequired'))
  ) {
    throw invalid('unsupported steering idle behavior')
  }
  const key = steering && 'idempotencyKey' in steering ? steering.idempotencyKey : undefined
  if (key !== undefined && (typeof key !== 'string' || key.length === 0 || [...key].length > 255)) {
    throw invalid('idempotencyKey must be a string of 1 to 255 characters')
  }
  const message = value.prompt
    .map((block: unknown) => {
      if (typeof block === 'object' && block !== null && 'type' in block) {
        if (block.type === 'text' && 'text' in block && typeof block.text === 'string') return block.text
        if (block.type === 'resource_link' && 'uri' in block && typeof block.uri === 'string')
          return `
[Context] ${block.uri}`
      }
      throw invalid('Pi keyed steering accepts text and resource links')
    })
    .join('')
  return { sessionId: value.sessionId, message, key }
}

function nativeMessageId(sessionId: string, key: string | undefined | null): string {
  return key == null
    ? randomUUID()
    : 'pi-acp-v2:' +
        createHash('sha256')
          .update(JSON.stringify([sessionId, key]))
          .digest('hex')
}

class PiV2Agent {
  private readonly agent: PiAcpAgent
  private readonly sessions = new Map<string, Runtime>()

  constructor(
    private readonly client: Pick<v2.AgentContext, 'notify' | 'request'>,
    private readonly activeSteering: boolean
  ) {
    const connection: PiAcpConnection = {
      sessionUpdate: params => this.legacyUpdate(params),
      requestPermission: params => this.permission(params)
    }
    this.agent = new PiAcpAgent(connection, { keepSessions: true })
  }

  dispose(): void {
    for (const runtime of this.sessions.values()) {
      runtime.unsubscribe()
      runtime.permissions.abort()
    }
    this.sessions.clear()
    this.agent.dispose()
  }

  async initialize(): Promise<v2.InitializeResponse> {
    const legacy = await this.agent.initialize({ protocolVersion: 1 })
    return {
      protocolVersion: 2,
      info: legacy.agentInfo ?? { name: 'pi-acp', version: 'development' },
      capabilities: { session: { prompt: { image: {} }, delete: {} } },
      _meta: {
        'nymph.ai/fabric': { keyedTextPrompts: true, ...(this.activeSteering ? { keyedTextSteering: true } : {}) },
        ...(this.activeSteering ? { steering: { supported: true } } : {})
      }
    }
  }

  async newSession(params: v2.NewSessionRequest): Promise<v2.NewSessionResponse> {
    validateRoots(params)
    const created = await translateError(() => this.agent.newSession({ cwd: params.cwd, mcpServers: [] }))
    const session = this.agent.getActiveSession(created.sessionId)
    if (!session) throw new Error('Pi did not keep its newly created session')
    this.track(session)
    return { sessionId: created.sessionId, configOptions: configure(created.configOptions) }
  }

  async listSessions(params: v2.ListSessionsRequest): Promise<v2.ListSessionsResponse> {
    return translateError(() => this.agent.listSessions(params))
  }

  async resumeSession(params: v2.ResumeSessionRequest): Promise<v2.ResumeSessionResponse> {
    validateRoots(params)
    if (params.replayFrom != null && params.replayFrom.type !== 'start') {
      throw invalid('Pi only supports replay from the start of the retained branch')
    }
    const { session, configOptions } = await translateError(() =>
      this.agent.resumeActiveSession(params.sessionId, params.cwd)
    )
    const kept = this.sessions.get(params.sessionId)
    const runtime = kept ?? this.track(session)
    if (runtime.closing) throw new v2.RequestError(-32002, 'Session is closing')
    await this.enqueue(runtime, async () => {
      if (params.replayFrom) {
        await this.publishMessages(runtime, true)
        await this.notify(runtime, { sessionUpdate: 'replay_complete' })
      } else if (!kept) {
        const { entries, leafId } = await session.proc.getEntries()
        for (const entry of branch(entries, leafId)) runtime.seen.add(entry.id)
      }
      await this.notify(runtime, runtime.state)
    })
    return { configOptions: configure(configOptions) }
  }

  async prompt(params: v2.PromptRequest, signal: AbortSignal): Promise<v2.PromptResponse> {
    const runtime = this.requireSession(params.sessionId)
    const key = params.idempotencyKey
    if (key != null && (typeof key !== 'string' || key.length === 0 || [...key].length > 255)) {
      throw invalid('idempotencyKey must be a string of 1 to 255 characters')
    }
    if (params.prompt.length === 0) throw invalid('prompt must contain at least one block')
    let message = ''
    const images: { type: 'image'; mimeType: string; data: string }[] = []
    for (const block of params.prompt) {
      switch (block.type) {
        case 'text':
          if (typeof block.text !== 'string') throw invalid('Expected text content')
          message += block.text
          break
        case 'resource_link':
          if (typeof block.uri !== 'string') throw invalid('Expected a resource URI')
          message += `\n[Context] ${block.uri}`
          break
        case 'image':
          if (typeof block.mimeType !== 'string' || typeof block.data !== 'string') throw invalid('Expected image data')
          images.push({ type: 'image', mimeType: block.mimeType, data: block.data })
          break
        default:
          throw invalid('Unsupported Pi prompt content')
      }
    }
    const messageId = nativeMessageId(params.sessionId, key)
    if (runtime.receipts.has(messageId)) return { messageId }
    const submission = runtime.session.submitKeyedPrompt(message, messageId, images, signal)
    runtime.work.add(submission.completed)
    void submission.completed.finally(() => runtime.work.delete(submission.completed)).catch(() => {})
    const receipt = await translateError(() => submission.inserted)
    if (receipt === null) throw v2.RequestError.requestCancelled()
    runtime.receipts.add(receipt.clientMessageId)
    if (receipt.disposition === 'inserted') {
      await this.enqueue(runtime, () => this.publishMessages(runtime, false)).catch(reportEventError)
    }
    return { messageId: receipt.clientMessageId }
  }

  async steer(params: Steering, signal: AbortSignal) {
    const runtime = this.requireSession(params.sessionId)
    const messageId = nativeMessageId(params.sessionId, params.key)
    signal.throwIfAborted()
    if (!runtime.receipts.has(messageId)) {
      const receipt = await runtime.session.proc.steerWithId(params.message, messageId)
      if (receipt === null) return { outcome: 'promptRequired', reason: 'noRunningTurn' }
      runtime.receipts.add(messageId)
      if (receipt.disposition === 'inserted') {
        await this.enqueue(runtime, () => this.publishMessages(runtime, false)).catch(reportEventError)
      }
    }
    return { outcome: 'injected', messageId }
  }

  async cancel(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId)
    if (!runtime || runtime.closing || runtime.work.size === 0) return
    runtime.permissions.abort()
    await translateError(() => runtime.session.cancel())
  }

  async close(sessionId: string): Promise<v2.CloseSessionResponse> {
    const runtime = this.requireSession(sessionId)
    runtime.closing = true
    try {
      runtime.permissions.abort()
      if (runtime.work.size > 0) await translateError(() => runtime.session.cancel())
      await Promise.allSettled(runtime.work)
      await runtime.output
    } finally {
      runtime.unsubscribe()
      this.agent.closeActiveSession(sessionId)
      this.sessions.delete(sessionId)
    }
    return {}
  }

  async delete(sessionId: string): Promise<v2.DeleteSessionResponse> {
    if (this.sessions.has(sessionId)) await this.close(sessionId)
    return translateError(() => this.agent.deleteSession({ sessionId }))
  }

  async setConfig(params: v2.SetSessionConfigOptionRequest): Promise<v2.SetSessionConfigOptionResponse> {
    this.requireSession(params.sessionId)
    const value = params.value
    if (params.type !== 'id' || typeof value !== 'string') throw invalid('Pi config options use string IDs')
    const { configOptions } = await translateError(() =>
      this.agent.setSessionConfigOption({
        sessionId: params.sessionId,
        configId: params.configId,
        value
      })
    )
    return { configOptions: configure(configOptions) }
  }

  private requireSession(sessionId: string): Runtime {
    const runtime = this.sessions.get(sessionId)
    if (!runtime || runtime.closing) throw new v2.RequestError(-32002, 'Session is not active')
    return runtime
  }

  private track(session: PiAcpSession): Runtime {
    const runtime: Runtime = {
      session,
      seen: new Set(),
      receipts: new Set(),
      work: new Set(),
      output: Promise.resolve(),
      state: idle(),
      closing: false,
      failed: false,
      permissions: new AbortController(),
      unsubscribe: () => {}
    }
    runtime.unsubscribe = session.proc.onEvent(event => {
      void this.enqueue(runtime, () => this.nativeEvent(runtime, event)).catch(reportEventError)
    })
    this.sessions.set(session.sessionId, runtime)
    return runtime
  }

  private enqueue(runtime: Runtime, send: () => Promise<void>): Promise<void> {
    const sent = runtime.output.then(send)
    runtime.output = sent.catch(() => {})
    return sent
  }

  private async notify(runtime: Runtime, update: v2.SessionUpdate): Promise<void> {
    await this.client.notify(v2.methods.client.session.update, { sessionId: runtime.session.sessionId, update })
  }

  private async nativeEvent(runtime: Runtime, event: PiRpcEvent): Promise<void> {
    switch (event.type) {
      case 'agent_start':
        if (runtime.state.state === 'idle') runtime.failed = false
        runtime.permissions = new AbortController()
        runtime.state = { sessionUpdate: 'state_update', state: 'running' }
        await this.notify(runtime, runtime.state)
        break
      case 'message_end':
        if (
          event.message &&
          typeof event.message === 'object' &&
          'role' in event.message &&
          event.message.role === 'assistant'
        )
          await this.publishMessages(runtime, false)
        break
      case 'turn_end': {
        const message = event.message as { role?: string; stopReason?: string } | null | undefined
        if (message?.role === 'assistant') runtime.failed = message.stopReason === 'error'
        break
      }
      case 'agent_settled': {
        const stop = event.aborted === true ? 'cancelled' : runtime.failed ? 'error' : 'end_turn'
        runtime.state = idle(stop)
        await this.notify(runtime, runtime.state)
        break
      }
      case 'pi_acp_process_exit':
        runtime.state = { sessionUpdate: 'state_update', state: 'unknown' }
        await this.notify(runtime, runtime.state)
        runtime.unsubscribe()
        this.sessions.delete(runtime.session.sessionId)
        this.agent.closeActiveSession(runtime.session.sessionId)
        break
    }
  }

  private async publishMessages(runtime: Runtime, replay: boolean): Promise<void> {
    const { entries, leafId } = await runtime.session.proc.getEntries()
    for (const entry of branch(entries, leafId)) {
      if (entry.type !== 'message' || !entry.message || (!replay && runtime.seen.has(entry.id))) continue
      const { role, content } = entry.message
      const submission = entry.clientSubmission
      const messageId =
        submission?.sessionId === runtime.session.sessionId ? submission.messageId : `pi-entry:${entry.id}`
      if (role === 'user' && submission?.sessionId === runtime.session.sessionId) runtime.receipts.add(messageId)
      if (role === 'user' || role === 'assistant') {
        const text = role === 'user' ? normalizePiMessageText(content) : normalizePiAssistantText(content)
        const blocks: v2.ContentBlock[] = text ? [{ type: 'text', text }] : []
        if (role === 'user' && Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
              blocks.push({ type: 'image', data: part.data, mimeType: part.mimeType })
            }
          }
        }
        await this.notify(
          runtime,
          role === 'user'
            ? { sessionUpdate: 'user_message', messageId, content: blocks }
            : { sessionUpdate: 'agent_message', messageId, content: blocks }
        )
      }
      runtime.seen.add(entry.id)
    }
  }

  private async legacyUpdate({ sessionId, update }: acp.SessionNotification): Promise<void> {
    const runtime = this.sessions.get(sessionId)
    if (!runtime) return
    switch (update.sessionUpdate) {
      case 'config_option_update':
        await this.enqueue(runtime, () =>
          this.notify(runtime, { ...update, configOptions: configure(update.configOptions) })
        )
        break
      case 'usage_update':
        await this.enqueue(runtime, () => this.notify(runtime, { ...update, sessionUpdate: 'usage_update' }))
        break
      case 'tool_call':
      case 'tool_call_update': {
        const { content, ...fields } = update
        const display = content?.filter(item => item.type === 'content')
        await this.enqueue(runtime, () =>
          this.notify(runtime, {
            ...fields,
            sessionUpdate: 'tool_call_update',
            ...(display ? { content: display as v2.ToolCallContent[] } : {})
          })
        )
        break
      }
    }
  }

  private async permission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const runtime = this.sessions.get(params.sessionId)
    if (!runtime || runtime.closing || runtime.permissions.signal.aborted) return { outcome: { outcome: 'cancelled' } }
    const permissions = runtime.permissions
    await this.enqueue(runtime, async () => {
      runtime.state = { sessionUpdate: 'state_update', state: 'requires_action' }
      await this.notify(runtime, runtime.state)
    })
    try {
      const { toolCallId, title } = params.toolCall
      const response = await this.client.request(
        v2.methods.client.session.requestPermission,
        {
          sessionId: params.sessionId,
          title: title ?? 'Pi requests permission',
          subject: { type: 'tool_call', toolCall: { toolCallId } },
          options: params.options
        },
        { cancellationSignal: permissions.signal }
      )
      if (response.outcome.outcome === 'selected' && typeof response.outcome.optionId === 'string') {
        return { outcome: { outcome: 'selected', optionId: response.outcome.optionId } }
      }
      return { outcome: { outcome: 'cancelled' } }
    } finally {
      await this.enqueue(runtime, async () => {
        if (runtime.closing || permissions.signal.aborted || runtime.state.state !== 'requires_action') return
        runtime.state = { sessionUpdate: 'state_update', state: 'running' }
        await this.notify(runtime, runtime.state)
      })
    }
  }
}

function reportEventError(error: unknown): void {
  process.stderr.write(`pi-acp: v2 event failed: ${String(error)}\n`)
}

export function piAgentRouter(activeSteering = false) {
  let active: PiV2Agent
  let dispose: (() => void) | undefined
  const standard = v2
    .agent({ name: 'pi-acp' })
    .onConnect(({ client, signal }) => {
      active = new PiV2Agent(client, activeSteering)
      dispose = () => active.dispose()
      signal.addEventListener('abort', dispose, { once: true })
    })
    .onRequest(v2.methods.agent.initialize, () => active.initialize())
    .onRequest(v2.methods.agent.session.new, ctx => active.newSession(ctx.params))
    .onRequest(v2.methods.agent.session.list, ctx => active.listSessions(ctx.params))
    .onRequest(v2.methods.agent.session.resume, ctx => active.resumeSession(ctx.params))
    .onRequest(v2.methods.agent.session.prompt, ctx => active.prompt(ctx.params, ctx.signal))
    .onNotification(v2.methods.agent.session.cancel, ctx => active.cancel(ctx.params.sessionId))
    .onRequest(v2.methods.agent.session.close, ctx => active.close(ctx.params.sessionId))
    .onRequest(v2.methods.agent.session.delete, ctx => active.delete(ctx.params.sessionId))
    .onRequest(v2.methods.agent.session.setConfigOption, ctx => active.setConfig(ctx.params))
  const experimental = activeSteering
    ? standard.onRequest('_session/steering', parseSteering, ctx => active.steer(ctx.params, ctx.signal))
    : standard
  const router = v2
    .agentProtocolRouter()
    .withV1({
      connect: stream => {
        const connection = new acp.AgentSideConnection(client => {
          const agent = new PiAcpAgent(client)
          dispose = () => agent.dispose()
          return agent
        }, stream as acp.Stream)
        connection.signal.addEventListener('abort', () => dispose?.(), { once: true })
        return connection
      }
    })
    .withV2(experimental)
  return { connect: router.connect.bind(router), dispose: () => dispose?.() }
}
