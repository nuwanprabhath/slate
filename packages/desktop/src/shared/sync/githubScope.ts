/**
 * GDPR-11: what Slate's GitHub sign-in asks for, in words a person can weigh before approving it. Shared so the
 * device-code step (renderer) shows exactly the scope main requests.
 */
export const DEVICE_FLOW_SCOPE = 'repo'

export const DEVICE_FLOW_SCOPE_HELP =
  'GitHub will ask you to grant the "repo" permission: read and write access to every repository your account can reach, including private and organisation ones, not only your notes repository. A fine-grained token for one repository grants less.'

export const FINE_GRAINED_TOKEN_HELP =
  'Recommended: a fine-grained token for your notes repository only, with Contents: read and write. Make one at github.com → Settings → Developer settings → Fine-grained tokens.'
