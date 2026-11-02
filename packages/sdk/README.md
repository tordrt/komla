# @komla/sdk

A typed TypeScript client for Komla Operations: the actions and queries the `komla` CLI and MCP
also use, such as listing workspaces, tagging one, setting a status bar item or launching an agent.
It is an adapter over the same operations, so Komla applies the same capability toggles, context
rules and errors to it. See [ADR 0008](../../docs/adr/0008-a-typed-sdk-over-komla-operations.md)
and the SDK section of [docs/CLI.md](../../docs/CLI.md).

```ts
import { connectKomla, KomlaError } from '@komla/sdk';

// Declare what the script does beyond reading; the client has no other methods.
const komla = connectKomla({ capabilities: ['workspace.tag', 'status.set'] });

const { workspaces } = await komla.workspace.list();
for (const workspace of workspaces) {
  await komla.workspace.tag({ tag: 'CI running', spinner: true }, { workspace: workspace.id });
}
await komla.status.set({ id: 'tests', text: '142/150 passing', tone: 'warning' });
// Notifying needs no capability, as `komla notify` needs none.
await komla.workspace.notify({ title: 'CI failed', badge: 'CI', color: 'error' });

try {
  await komla.workspace.tag({ tag: 'CI failed', ifTag: 'CI running' });
} catch (error) {
  if (error instanceof KomlaError && error.code === 'CAPABILITY_DISABLED') {
    // The user turned `komla tag` off in Settings.
  }
}
```

`connectKomla` finds Komla as the CLI does, from a managed terminal's `KOMLA_*` environment or the
port file in Komla's data folder. `createKomlaClient({ transport })`, from `@komla/sdk/client`,
takes any transport and uses no Node APIs.

Each method is an operation: `komla.workspace.tag(input)` sends `{ type: 'workspace.tag', ...input }`
and `komla.execute(request)` sends a request as it is. `src/generated.ts` holds the request and
result types, rendered from the schemas Komla validates operations with; run
`npm run generate:sdk` in the repository root after changing them.

```bash
npm run build   # dist/
npm test        # type-checks, then runs the tests
```
