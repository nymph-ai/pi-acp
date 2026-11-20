import assert from 'node:assert/strict'
import { test } from 'node:test'
import { channelReplyScope } from '../../src/acp/channel-reply.js'

const config = { command: '/fixture/reply', socket: '/fixture/fabd.sock', extension: '/fixture/channel-reply.mjs' }
const sessionId = 'fixture-session'
const key = 'd1'.repeat(32)
const declaration = {
  type: 'stdio' as const,
  name: 'channel_reply',
  command: config.command,
  args: [config.socket, sessionId, 'fixture/source', 'fixture-event'],
  env: [
    { name: 'FABD_CHANNEL_REPLY_KEY', value: key },
    { name: 'FABD_CHANNEL_REPLY_OWNER_HELLO', value: '1' }
  ]
}

test('Pi restricts channel reply bootstrap to the configured native process', () => {
  assert.equal(channelReplyScope([], sessionId, config), undefined)
  assert.deepEqual(channelReplyScope([declaration], sessionId, config), {
    ...config,
    sessionId,
    source: 'fixture/source',
    eventId: 'fixture-event',
    key
  })
  assert.throws(() => channelReplyScope([declaration], sessionId, undefined), /configured channel_reply/)
  assert.throws(() => channelReplyScope([declaration], 'foreign-session', config), /resumed session/)
  assert.throws(() => channelReplyScope([declaration, declaration], sessionId, config), /configured channel_reply/)
  const overridden = { ...declaration, env: [...declaration.env, { name: 'UNEXPECTED', value: '1' }] }
  assert.throws(() => channelReplyScope([overridden], sessionId, config), /delegated key/)
})
