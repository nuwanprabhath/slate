import type { ElectronApplication, Page } from '@playwright/test'
import type { ConsentFeature } from '../src/shared/privacy/consent'
import { launchApp } from './fixtures'

/** Launches, then grants the features through the real `privacy.grant` channel, as the consent dialog would. Strict mode stays on. */
export async function launchGranted(
  userData: string,
  features: ConsentFeature[],
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await launchApp(userData, env)
  for (const f of features) await launched.page.evaluate((x) => window.slate.privacy.grant(x), f)
  return launched
}
