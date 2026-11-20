import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import * as v2 from 'acp-v2-sdk/experimental/v2/unstable'
import { PiAcpAgent } from './agent.js'
import type { PiAcpConnection, PiAcpSession, StopReason } from './session.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import { getPiAcpDir } from './paths.js'
import type { PiForkAnchor, PiRpcEvent, PiSessionEntry } from '../pi-rpc/process.js'
import { PiToolUpdates } from './v2-tools.js'

const FABRIC_CURSOR_REPLAY = '_fabric_cursor'

type StateNotification = Extract<v2.SessionUpdate, { sessionUpdate: 'state_update' }>
type Runtime = {
  session: PiAcpSession
  seen: Set<string>
  receipts: Set<string>
  tools: PiToolUpdates
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

async function retainedBranch(session: PiAcpSession): Promise<PiSessionEntry[]> {
  const { entries, leafId } = await session.proc.getEntries()
  return branch(entries, leafId)
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

function cursorSigningKey(): Uint8Array {
  const directory = getPiAcpDir()
  const path = join(directory, 'v2-cursor-key')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    return readCursorKey()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporary = path + '.' + randomUUID()
  try {
    writeFileSync(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 })
    try {
      linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    rmSync(temporary, { force: true })
  }
  return readCursorKey()

  function readCursorKey(): Uint8Array {
    const bytes = readFileSync(path)
    if (bytes.length !== 32) throw new Error('Pi ACP has an invalid cursor signing key')
    return bytes
  }
}

function entryMessageId(entry: PiSessionEntry): string {
  return entry.clientSubmission?.messageId ?? `pi-entry:${entry.id}`
}

function cursorAnchor(entry: PiSessionEntry): PiForkAnchor | undefined {
  if (entry.type !== 'message') return undefined
  if (entry.message?.role === 'user') return { entryId: entry.id, position: 'before' }
  const content: unknown = entry.message?.content
  if (
    entry.message?.role === 'assistant' &&
    Array.isArray(content) &&
    !content.some(block => typeof block === 'object' && block?.type === 'toolCall')
  ) {
    return { entryId: entry.id, position: 'after' }
  }
}

class PiV2Agent {
  private readonly agent: PiAcpAgent
  private readonly sessions = new Map<string, Runtime>()
  private cursorKey?: Uint8Array

  constructor(
    private readonly client: Pick<v2.AgentContext, 'notify' | 'request'>,
    private readonly activeSteering: boolean,
    private readonly nativeCursors: boolean
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
    if (this.nativeCursors && !this.cursorKey) this.cursorKey = cursorSigningKey()
    return {
      protocolVersion: 2,
      info: legacy.agentInfo ?? { name: 'pi-acp', version: 'development' },
      capabilities: { session: { prompt: { image: {} }, delete: {}, ...(this.nativeCursors ? { fork: {} } : {}) } },
      _meta: {
        'nymph.ai/fabric': {
          keyedTextPrompts: true,
          ...(this.activeSteering ? { keyedTextSteering: true } : {}),
          ...(this.nativeCursors ? { replayFromCursor: FABRIC_CURSOR_REPLAY } : {})
        },
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
    const cursorId = this.replayCursorId(params.replayFrom)
    const { session, configOptions } = await translateError(() =>
      this.agent.resumeActiveSession(params.sessionId, params.cwd)
    )
    const preflight =
      cursorId !== undefined && !this.sessions.has(params.sessionId)
        ? await this.replayPlan(session, cursorId)
        : undefined
    const kept = this.sessions.get(params.sessionId)
    const runtime = kept ?? this.track(session)
    if (runtime.closing) throw new v2.RequestError(-32002, 'Session is closing')
    await this.enqueue(runtime, async () => {
      if (params.replayFrom) {
        const plan = kept ? undefined : preflight
        const { entries, from } = plan ?? (await this.replayPlan(session, cursorId))
        for (const entry of entries.slice(0, from)) runtime.seen.add(entry.id)
        await this.publishMessages(runtime, true, entries.slice(from))
        await this.notify(runtime, { sessionUpdate: 'replay_complete' })
      } else if (!kept) {
        for (const entry of await retainedBranch(session)) runtime.seen.add(entry.id)
      }
      await this.notify(runtime, runtime.state)
    })
    return { configOptions: configure(configOptions) }
  }

  private replayCursorId(replayFrom: v2.ReplayFrom | null | undefined): string | undefined {
    if (replayFrom == null || replayFrom.type === 'start') return undefined
    if (!this.nativeCursors || replayFrom.type !== FABRIC_CURSOR_REPLAY) {
      throw invalid('Pi does not support this replay cursor type')
    }
    if (typeof replayFrom.cursorId !== 'string' || !/^pi-cursor:[A-Za-z0-9_-]{43}$/.test(replayFrom.cursorId)) {
      throw invalid('Pi cursor replay requires an issued cursorId')
    }
    return replayFrom.cursorId
  }

  private async replayPlan(
    session: PiAcpSession,
    cursorId?: string
  ): Promise<{ entries: PiSessionEntry[]; from: number }> {
    const entries = await retainedBranch(session)
    if (cursorId === undefined) return { entries, from: 0 }
    const { index, anchor } = this.findCursor(entries, session.sessionId, cursorId)
    return { entries, from: index + (anchor.position === 'after' ? 1 : 0) }
  }

  async forkSession(params: v2.ForkSessionRequest, signal: AbortSignal): Promise<v2.ForkSessionResponse> {
    validateRoots(params)
    signal.throwIfAborted()
    const { session: source } = await translateError(() => this.agent.resumeActiveSession(params.sessionId, params.cwd))
    const anchor =
      params.cursorId == null
        ? undefined
        : this.findCursor(await retainedBranch(source), params.sessionId, params.cursorId).anchor
    signal.throwIfAborted()
    const fork = await source.proc.forkSnapshot(anchor)
    if (!fork) throw invalid('The cursor no longer belongs to this Pi session branch')
    const { session, configOptions } = await translateError(() =>
      this.agent.resumeForkedSession(fork.sessionId, params.cwd, fork.sessionFile)
    )
    const runtime = this.track(session)
    for (const entry of await retainedBranch(session)) runtime.seen.add(entry.id)
    return { sessionId: fork.sessionId, configOptions: configure(configOptions) }
  }

  private findCursor(
    entries: PiSessionEntry[],
    sessionId: string,
    cursorId: string
  ): { index: number; anchor: PiForkAnchor } {
    for (const [index, entry] of entries.entries()) {
      const anchor = cursorAnchor(entry)
      if (anchor && this.cursorId(sessionId, anchor) === cursorId) return { index, anchor }
    }
    throw invalid('The cursor does not identify a supported point on this Pi session branch')
  }

  private cursorId(sessionId: string, anchor: PiForkAnchor): string {
    if (!this.cursorKey) throw new Error('Pi ACP cursor support is not initialized')
    return (
      'pi-cursor:' +
      createHmac('sha256', this.cursorKey)
        .update(JSON.stringify([sessionId, anchor.entryId, anchor.position]))
        .digest('base64url')
    )
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
      tools: new PiToolUpdates(),
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
          (event.message.role === 'assistant' || event.message.role === 'toolResult')
        )
          await this.publishMessages(runtime, false)
        break
      case 'tool_execution_start':
        await this.publishMessages(runtime, false)
        break
      case 'turn_end': {
        const message = event.message as { role?: string; stopReason?: string } | null | undefined
        if (message?.role === 'assistant') runtime.failed = message.stopReason === 'error'
        break
      }
      case 'agent_settled': {
        await this.publishMessages(runtime, false)
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

  private async publishMessages(runtime: Runtime, replay: boolean, history?: PiSessionEntry[]): Promise<void> {
    const tools = replay ? new PiToolUpdates() : runtime.tools
    for (const entry of history ?? (await retainedBranch(runtime.session))) {
      if (entry.type !== 'message' || !entry.message || (!replay && runtime.seen.has(entry.id))) continue
      const { role, content } = entry.message
      const submission = entry.clientSubmission
      const messageId = entryMessageId(entry)
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
        if (role === 'assistant') {
          for (const tool of tools.start(entry.id, content)) await this.notify(runtime, tool)
        }
        const anchor = this.nativeCursors ? cursorAnchor(entry) : undefined
        if (anchor) {
          await this.notify(runtime, {
            sessionUpdate: 'cursor_update',
            cursorId: this.cursorId(runtime.session.sessionId, anchor),
            anchor:
              role === 'user'
                ? { type: 'user_message', messageId, position: anchor.position }
                : { type: 'agent_message', messageId, position: anchor.position },
            capabilities: { fork: {} }
          })
        }
      }
      if (role === 'toolResult') {
        const tool = tools.finish(entry.message)
        if (tool) await this.notify(runtime, tool)
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
    }
  }

  private async permission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const runtime = this.sessions.get(params.sessionId)
    if (!runtime || runtime.closing || runtime.permissions.signal.aborted) return { outcome: { outcome: 'cancelled' } }
    const permissions = runtime.permissions
    await this.enqueue(runtime, async () => {
      await this.publishMessages(runtime, false)
      runtime.state = { sessionUpdate: 'state_update', state: 'requires_action' }
      await this.notify(runtime, runtime.state)
    })
    try {
      const { toolCallId, title } = params.toolCall
      const retainedId = runtime.tools.activeId(toolCallId)
      const response = await this.client.request(
        v2.methods.client.session.requestPermission,
        {
          sessionId: params.sessionId,
          title: title ?? 'Pi requests permission',
          ...(retainedId ? { subject: { type: 'tool_call', toolCall: { toolCallId: retainedId } } } : {}),
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

export function piAgentRouter(activeSteering = false, nativeCursors = false) {
  let active: PiV2Agent
  let dispose: (() => void) | undefined
  const standard = v2
    .agent({ name: 'pi-acp' })
    .onConnect(({ client, signal }) => {
      active = new PiV2Agent(client, activeSteering, nativeCursors)
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
  const steering = activeSteering
    ? standard.onRequest('_session/steering', parseSteering, ctx => active.steer(ctx.params, ctx.signal))
    : standard
  const experimental = nativeCursors
    ? steering.onRequest(v2.methods.agent.session.fork, ctx => active.forkSession(ctx.params, ctx.signal))
    : steering
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
