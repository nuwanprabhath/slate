export type RemotePath =
  | { kind: 'chunk' | 'snapshot'; docId: string; deviceId: string; seq: number }
  | { kind: 'blob'; name: string }
  | { kind: 'device' | 'other' }

/** OneDrive folder names cannot hold `:`; doc ids are `<kind>:<uuid>`, and uuids hold no `_`. */
export function docKey(docId: string): string {
  return docId.replace(':', '_')
}

export function docIdFromKey(key: string): string {
  return key.replace('_', ':')
}

const pad = (seq: number) => String(seq).padStart(8, '0')

export function chunkPath(docId: string, deviceId: string, seq: number): string {
  return `docs/${docKey(docId)}/${deviceId}/${pad(seq)}.chunk`
}

export function snapshotPath(docId: string, deviceId: string, seq: number): string {
  return `docs/${docKey(docId)}/${deviceId}/snapshot-${pad(seq)}.bin`
}

export function parseRemotePath(path: string): RemotePath {
  const parts = path.split('/')
  if (parts[0] === 'docs' && parts.length === 4) {
    const [, key, deviceId, file] = parts as [string, string, string, string]
    const chunk = file.match(/^(\d+)\.chunk$/)
    if (chunk) return { kind: 'chunk', docId: docIdFromKey(key), deviceId, seq: Number(chunk[1]) }
    const snapshot = file.match(/^snapshot-(\d+)\.bin$/)
    if (snapshot) return { kind: 'snapshot', docId: docIdFromKey(key), deviceId, seq: Number(snapshot[1]) }
  }
  if (parts[0] === 'blobs' && parts.length === 2 && parts[1] !== '') return { kind: 'blob', name: parts[1]! }
  if (parts[0] === 'devices' && parts.length === 2 && parts[1]!.endsWith('.json')) return { kind: 'device' }
  return { kind: 'other' }
}
