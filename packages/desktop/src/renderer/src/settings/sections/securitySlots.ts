import type { ComponentType } from 'react'
import type { VaultStatus } from '../../../../shared/api'

export interface SecurityRowProps {
  status: VaultStatus
}

const rows: Array<ComponentType<SecurityRowProps>> = []

/**
 * Extra rows for Settings → Security, shown after the lock settings: quick unlock (Touch ID /
 * system keyring) registers here, so the section does not import it.
 */
export function registerSecurityRow(row: ComponentType<SecurityRowProps>): void {
  if (!rows.includes(row)) rows.push(row)
}

export function securityRows(): ReadonlyArray<ComponentType<SecurityRowProps>> {
  return rows
}
