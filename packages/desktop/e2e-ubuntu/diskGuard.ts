/** The image is about 4 GB, a rebuild needs scratch space and a cache of v0.1.0 on top; below this the disk fills. */
export const MIN_FREE_GB = 8 // GiB, as `df -k` divided by 1024²

/** Free kilobytes from `df -k <path>` output (the Available column of its one data row), or undefined. */
export function parseDfFreeKb(output: string): number | undefined {
  const row = output.trim().split('\n').at(-1)?.trim().split(/\s+/)
  const kb = row === undefined ? NaN : Number(row[3])
  return Number.isFinite(kb) ? kb : undefined
}

/**
 * macOS: the home volume's free space as Finder counts it ("available for important usage"), in bytes.
 * That includes purgeable space macOS frees as soon as a write needs it, which `df` leaves out.
 */
export const MAC_FREE_BYTES_JXA =
  'ObjC.import("Foundation"); const k = "NSURLVolumeAvailableCapacityForImportantUsageKey"; ' +
  'String($.NSURL.fileURLWithPath($.NSHomeDirectory()).resourceValuesForKeysError($([k]), null).objectForKey(k).js)'

/** Kilobytes from the byte count `MAC_FREE_BYTES_JXA` prints, or undefined for anything else. */
export function parseFreeBytesAsKb(output: string): number | undefined {
  const bytes = Number(output.trim())
  return output.trim() !== '' && Number.isFinite(bytes) && bytes >= 0 ? bytes / 1024 : undefined
}

/** The refusal message when the disk is too full to build the bed, else undefined. */
export function lowDiskMessage(freeKb: number): string | undefined {
  const freeGb = freeKb / 1024 / 1024
  if (freeGb >= MIN_FREE_GB) return undefined
  return `Refusing to build the Ubuntu test bed: ${freeGb.toFixed(1)} GiB free, need at least ${String(MIN_FREE_GB)} GiB (the image is about 4 GB).`
}
