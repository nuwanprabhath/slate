import { protocol } from 'electron'
import { APP_SCHEME, appResponse } from './appProtocol'

/**
 * The only file that registers custom protocol handlers (lint rule `slate/protocols-through-the-gate`).
 * A handler that serves note data goes through `handleNoteProtocol`, which refuses while the vault is
 * locked, the same rule IPC follows: a page cannot read an image by URL that it may not ask for.
 */

type ProtocolHandler = (request: Request) => Response | Promise<Response>

const locked = () => new Response('Locked', { status: 423, headers: { 'Cache-Control': 'no-store' } })

/** `handler` behind the vault gate: 423 while the notes are closed, without calling it. */
export function gatedNoteHandler(notesOpen: () => boolean, handler: ProtocolHandler): ProtocolHandler {
  return (request) => (notesOpen() ? handler(request) : locked())
}

/** A protocol whose responses carry note data (images, attachments): served only while unlocked. */
export function handleNoteProtocol(scheme: string, notesOpen: () => boolean, handler: ProtocolHandler): void {
  protocol.handle(scheme, gatedNoteHandler(notesOpen, handler))
}

/** `app://slate/`: the renderer's own files (B-6). Holds no note data, so the lock screen loads it. */
export function handleAppProtocol(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, (request) => appResponse(rendererRoot, request.url))
}
