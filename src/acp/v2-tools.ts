import type { ContentBlock, SessionUpdate } from 'acp-v2-sdk/experimental/v2/unstable'
import type { PiSessionEntry } from '../pi-rpc/process.js'

type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>
type ToolCall = { id: string; name: string }
type ToolMessage = NonNullable<PiSessionEntry['message']>

function toolContent(value: unknown): ContentBlock | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) return
  if (value.type === 'text' && 'text' in value && typeof value.text === 'string') {
    return { type: 'text', text: value.text }
  }
  if (
    value.type === 'image' &&
    'data' in value &&
    typeof value.data === 'string' &&
    'mimeType' in value &&
    typeof value.mimeType === 'string'
  ) {
    return { type: 'image', data: value.data, mimeType: value.mimeType }
  }
}

/** Project the tool calls and results that occur within one native assistant step. */
export class PiToolUpdates {
  private readonly pending = new Map<string, ToolCall | null>()

  activeId(nativeId: string): string | undefined {
    return this.pending.get(nativeId)?.id
  }

  start(entryId: string, content: unknown): ToolUpdate[] {
    this.pending.clear()
    if (!Array.isArray(content)) return []
    return content.flatMap((part: unknown, index): ToolUpdate[] => {
      if (
        typeof part !== 'object' ||
        part === null ||
        !('type' in part) ||
        part.type !== 'toolCall' ||
        !('id' in part) ||
        typeof part.id !== 'string' ||
        !part.id ||
        !('name' in part) ||
        typeof part.name !== 'string'
      ) {
        return []
      }
      const id = `pi-tool:${entryId}:${index}`
      // A model can reuse its call ID, so a retained call occurrence uses the journal entry and block.
      this.pending.set(part.id, this.pending.has(part.id) ? null : { id, name: part.name })
      return [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          name: part.name,
          title: part.name,
          status: 'pending',
          ...('arguments' in part ? { rawInput: part.arguments } : {}),
          _meta: { 'nymph.ai/fabric': { nativeToolCallId: part.id } }
        }
      ]
    })
  }

  finish(message: ToolMessage): ToolUpdate | undefined {
    const { toolCallId, toolName, isError, content, details } = message
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string') return
    const call = this.pending.get(toolCallId)
    if (!call || call.name !== toolName) return
    this.pending.delete(toolCallId)
    const blocks = Array.isArray(content) ? content.map(toolContent).filter(block => block !== undefined) : []
    const partial = typeof isError !== 'boolean' || !Array.isArray(content) || blocks.length !== content.length
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: call.id,
      ...(typeof isError === 'boolean' ? { status: isError ? 'failed' : 'completed' } : {}),
      content: blocks.map(block => ({ type: 'content', content: block })),
      rawOutput: { content, details, isError },
      ...(partial ? { _meta: { 'nymph.ai/fabric': { toolOutputPartial: true } } } : {})
    }
  }
}
