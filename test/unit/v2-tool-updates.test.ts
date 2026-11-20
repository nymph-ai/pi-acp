import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PiToolUpdates } from '../../src/acp/v2-tools.js'

const call = { type: 'toolCall', id: 'provider-reused', name: 'read', arguments: { path: 'fixture.txt' } }
const result = {
  role: 'toolResult',
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: 'text', text: 'saved output' }]
}

test('uses a distinct native occurrence for a reused provider tool ID', () => {
  const tools = new PiToolUpdates()
  assert.equal(tools.finish({ ...result, isError: false }), undefined)
  assert.equal(tools.start('assistant-1', [call])[0]?.toolCallId, 'pi-tool:assistant-1:0')
  assert.equal(tools.activeId(call.id), 'pi-tool:assistant-1:0')
  assert.equal(tools.finish({ ...result, isError: false })?.status, 'completed')
  assert.equal(tools.start('assistant-2', [call])[0]?.toolCallId, 'pi-tool:assistant-2:0')
  const failed = tools.finish({ ...result, isError: true })
  assert.equal(failed?.toolCallId, 'pi-tool:assistant-2:0')
  assert.equal(failed.status, 'failed')
})

test('preserves partial and ambiguous results without implying success', () => {
  const tools = new PiToolUpdates()
  tools.start('assistant-1', [call, call])
  assert.equal(tools.activeId(call.id), undefined)
  assert.equal(tools.finish({ ...result, isError: false }), undefined)
  tools.start('assistant-2', [call])
  assert.equal(tools.finish({ ...result, toolName: 'unrelated', isError: false }), undefined)
  const partial = tools.finish(result)
  assert.equal(partial?.toolCallId, 'pi-tool:assistant-2:0')
  assert.equal(partial.status, undefined)
  assert.deepEqual(partial._meta, { 'nymph.ai/fabric': { toolOutputPartial: true } })
  assert.deepEqual(partial.content, [{ type: 'content', content: result.content[0] }])
})
