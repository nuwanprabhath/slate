// @ts-check
import plugin from './plugin.mjs'
import { at, ruleTester } from './ruleTester.mjs'

// The plugin's copy, so the cases cover the rule's scope (its `files`) as well as its logic.
const rule = /** @type {import('eslint').Rule.RuleModule} */ (plugin.rules['mcp-pages-through-docsource'])

const TOOLS = 'packages/mcp/src/tools.ts'
const SERVER = 'packages/mcp/src/server.ts'

ruleTester().run('mcp-pages-through-docsource', rule, {
  valid: [
    // The agent view is what the tool layer may hold (A2's allowed list).
    at(TOOLS, "import { agentBoxes, agentMarkdown, agentPageMarkdown, markdownToBlocks, type Access, type AgentBox, type AgentPage, type NotebookDoc, type PMJSON, type TreeItem } from '@slate/core'"),
    at(SERVER, "import { agentPageMarkdown } from '@slate/core'"),
    // A name that merely looks like one of the three.
    at(TOOLS, "import { contentToJSONish } from '@slate/core'\nvoid contentToJSONish"),
    // Another module's PageDoc is not core's.
    at(TOOLS, "import { PageDoc } from './pageDocStub'\nvoid PageDoc"),
    // A namespace import on its own, used only for allowed names.
    at(TOOLS, "import * as core from '@slate/core'\nvoid core.agentBoxes"),
    // The sanctioned holders are outside the rule's `files`, so the rule is scoped, not name-based.
    at('packages/desktop/src/main/mcp/docSource.ts', "import { contentToJSON, PageDoc } from '@slate/core'\nvoid contentToJSON\nvoid PageDoc"),
    at('packages/mcp/test/memorySource.ts', "import { PageDoc } from '@slate/core'\nvoid new PageDoc().contentMap()"),
    at('packages/core/src/agentView.ts', "import { contentToJSON } from './content'\nvoid contentToJSON"),
  ],
  invalid: [
    { ...at(TOOLS, "import { PageDoc } from '@slate/core'\nvoid PageDoc"), errors: [{ messageId: 'page' }] },
    // Type-only, which a naive check passes.
    { ...at(TOOLS, "import type { PageDoc } from '@slate/core'\nexport declare const p: PageDoc"), errors: [{ messageId: 'page' }] },
    { ...at(TOOLS, "import { type PageDoc } from '@slate/core'\nexport declare const p: PageDoc"), errors: [{ messageId: 'page' }] },
    // A local alias.
    { ...at(TOOLS, "import { PageDoc as P } from '@slate/core'\nvoid P"), errors: [{ messageId: 'page' }] },
    { ...at(TOOLS, "import { contentToJSON } from '@slate/core'\nvoid contentToJSON"), errors: [{ messageId: 'page' }] },
    { ...at(TOOLS, "import { contentMap } from '@slate/core'\nvoid contentMap"), errors: [{ messageId: 'page' }] },
    // A deep path into the package, and a relative path into packages/core/src.
    { ...at(TOOLS, "import { PageDoc } from '@slate/core/src/page'\nvoid PageDoc"), errors: [{ messageId: 'page' }] },
    { ...at(TOOLS, "import { contentToJSON } from '../../core/src/content'\nvoid contentToJSON"), errors: [{ messageId: 'page' }] },
    // A namespace import, which a naive check passes: the import binds nothing by name.
    { ...at(TOOLS, "import * as core from '@slate/core'\nvoid core.contentToJSON"), errors: [{ messageId: 'page' }] },
    { ...at(TOOLS, "import * as core from '@slate/core'\nvoid new core.PageDoc()"), errors: [{ messageId: 'page' }] },
    { ...at(TOOLS, "import * as core from '@slate/core'\nexport declare const p: core.PageDoc"), errors: [{ messageId: 'page' }] },
    // contentMap is a PageDoc method, so it is reached through a value, not an import.
    { ...at(TOOLS, 'export function f(/** @type {any} */ page) {\n  return page.contentMap()\n}'), errors: [{ messageId: 'page' }] },
    // Re-exporting reaches just as far.
    { ...at(SERVER, "export { PageDoc } from '@slate/core'"), errors: [{ messageId: 'page' }] },
    { ...at(SERVER, "export * from '@slate/core'"), errors: [{ messageId: 'page' }] },
    // The module object without a binding reaches just as far.
    { ...at(TOOLS, "export async function f() {\n  return (await import('@slate/core')).contentToJSON\n}"), errors: [{ messageId: 'page' }] },
    // The rule covers server.ts as well as tools.ts.
    { ...at(SERVER, "import { contentToJSON } from '@slate/core'\nvoid contentToJSON"), errors: [{ messageId: 'page' }] },
  ],
})
