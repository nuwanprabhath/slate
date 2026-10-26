// @ts-check

/**
 * `slate/ipc-channel-from-ch`: the channel argument of an IPC call is a `CH.<name>` member. A string
 * literal or a variable is a channel CHANNEL_POLICY never classified, so the vault gate and the
 * guard tests cannot see it.
 */
const METHODS = new Set(['handle', 'handleOnce', 'on', 'once', 'off', 'removeListener', 'removeAllListeners', 'invoke', 'send', 'sendSync', 'postMessage'])
const RECEIVERS = new Set(['ipcMain', 'ipcRenderer', 'ipc'])

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'IPC channels are CH members (src/shared/ipc.ts).' },
    messages: {
      member:
        'Pass a `CH.<name>` member as the channel (src/shared/ipc.ts), never a string or a variable. A new channel is a `CH` entry plus its CHANNEL_POLICY row (src/main/ipcGuard.ts); steps in docs/architecture/golden-paths.md#ipc.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier' || !METHODS.has(callee.property.name)) return
        if (callee.object.type !== 'Identifier' || !RECEIVERS.has(callee.object.name)) return
        const channel = node.arguments[0]
        if (channel === undefined) return
        const ok = channel.type === 'MemberExpression' && channel.object.type === 'Identifier' && channel.object.name === 'CH' && !channel.computed
        if (!ok) context.report({ node: channel, messageId: 'member' })
      },
    }
  },
}
