import { isAbsolute } from 'node:path'
import * as v2 from 'acp-v2-sdk/experimental/v2/unstable'
import type { PiChannelReplyScope } from '../pi-rpc/process.js'

type OperatorConfiguration = Pick<PiChannelReplyScope, 'command' | 'socket' | 'extension'>

export function channelReplyConfiguration(): OperatorConfiguration | undefined {
  const command = process.env.PI_ACP_V2_CHANNEL_REPLY_COMMAND ?? ''
  const socket = process.env.PI_ACP_V2_CHANNEL_REPLY_SOCKET ?? ''
  const extension = process.env.PI_ACP_V2_CHANNEL_REPLY_EXTENSION ?? ''
  if (isAbsolute(command) && isAbsolute(socket) && isAbsolute(extension)) return { command, socket, extension }
}

export function channelReplyScope(
  servers: v2.McpServer[] | undefined,
  sessionId: string,
  config: OperatorConfiguration | undefined
): PiChannelReplyScope | undefined {
  if (!servers?.length) return undefined
  const [server] = servers
  if (
    !config ||
    servers.length !== 1 ||
    !v2.McpServer.isStdio(server) ||
    server.name !== 'channel_reply' ||
    server.command !== config.command
  ) {
    throw v2.RequestError.invalidParams(undefined, 'Only the configured channel_reply stdio MCP is supported on resume')
  }
  const [socket, session, source, eventId] = server.args ?? []
  if (
    server.args?.length !== 4 ||
    socket !== config.socket ||
    session !== sessionId ||
    !source ||
    !eventId ||
    /[\u0000-\u001f\u007f]/.test(source + eventId)
  ) {
    throw v2.RequestError.invalidParams(
      undefined,
      'Channel reply must name the configured socket, resumed session, source, and event'
    )
  }
  const env = server.env ?? []
  const key = env.find(entry => entry.name === 'FABD_CHANNEL_REPLY_KEY')?.value
  const ownerHello = env.find(entry => entry.name === 'FABD_CHANNEL_REPLY_OWNER_HELLO')?.value
  if (env.length !== 2 || ownerHello !== '1' || !key || !/^[0-9a-f]{64}$/i.test(key)) {
    throw v2.RequestError.invalidParams(undefined, 'Channel reply requires a delegated key and owner hello environment')
  }
  return { ...config, sessionId, source, eventId, key }
}
