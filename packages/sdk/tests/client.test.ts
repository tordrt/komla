import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createKomlaClient,
  KOMLA_OPERATION_TYPES,
  KomlaError,
  requiredCapability,
  type KomlaCallOptions,
  type KomlaOperationRequest,
  type KomlaTransport,
  type WorkspaceListResult,
} from '../src/client.js';

function recordingTransport(result: unknown = { ok: true }) {
  const sent: Array<{ request: KomlaOperationRequest; options: KomlaCallOptions }> = [];
  const transport: KomlaTransport = {
    send: vi.fn(async (request, options) => {
      sent.push({ request, options });
      return result;
    }),
  };
  return { transport, sent };
}

describe('createKomlaClient', () => {
  it('sends each method as the operation of its name', async () => {
    const { transport, sent } = recordingTransport();
    const komla = createKomlaClient({ transport, capabilities: ['workspace.tag'] });

    await komla.workspace.tag({ tag: 'CI running', spinner: true }, { workspace: 'workspace-2' });
    await komla.workspace.list();
    await komla.tag.list();

    expect(sent).toEqual([
      {
        request: { type: 'workspace.tag', tag: 'CI running', spinner: true },
        options: { workspace: 'workspace-2' },
      },
      { request: { type: 'workspace.list' }, options: {} },
      { request: { type: 'tag.list' }, options: {} },
    ]);
  });

  it('has a method for every operation', () => {
    const komla = createKomlaClient({
      transport: recordingTransport().transport,
    }) as unknown as Record<string, Record<string, unknown>>;
    for (const type of KOMLA_OPERATION_TYPES) {
      const [namespace, method] = type.split('.') as [string, string];
      expect(typeof komla[namespace]?.[method], type).toBe('function');
    }
  });

  it('resolves to what the transport answers', async () => {
    const result: WorkspaceListResult = {
      workspaces: [{ id: 'w', name: 'W', environment: { kind: 'local' }, agentActive: false }],
    };
    const komla = createKomlaClient({ transport: recordingTransport(result).transport });

    await expect(komla.workspace.list({ includeTrashed: true })).resolves.toEqual(result);
  });

  it('reads and notifies without declaring anything', async () => {
    const { transport, sent } = recordingTransport();
    const komla = createKomlaClient({ transport });

    await komla.context.get();
    await komla.agent.presets();
    await komla.workspace.list();
    await komla.tag.list();
    // Ungated: waking undoes a snooze, and refreshing runs only the user's own item.
    await komla.workspace.wake();
    await komla.status.refresh({ id: 'tests' });
    // As `komla notify`, which no capability gates.
    await komla.workspace.notify({ title: 'CI failed', badge: 'CI' });

    expect(sent.map(({ request }) => request.type)).toEqual([
      'context.get',
      'agent.presets',
      'workspace.list',
      'tag.list',
      'workspace.wake',
      'status.refresh',
      'workspace.notify',
    ]);
  });

  it('refuses an operation whose capability it did not declare, before sending it', async () => {
    const { transport } = recordingTransport();
    const komla = createKomlaClient({ transport, capabilities: ['status.set'] });

    await expect(
      komla.execute({ type: 'agent.launch', destination: 'workspace', prompt: 'x' } as never)
    ).rejects.toMatchObject({
      name: 'KomlaError',
      code: 'CAPABILITY_NOT_DECLARED',
      details: { capability: 'agent.launch.workspace' },
    });
    // A method the type hides still refuses at run time, for code without types.
    const untyped = komla as unknown as Record<string, Record<string, (input: object) => unknown>>;
    await expect(untyped.workspace!.trash!({})).rejects.toBeInstanceOf(KomlaError);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('allows an agent launch only to the destinations it declared', async () => {
    const { transport, sent } = recordingTransport();
    const komla = createKomlaClient({ transport, capabilities: ['agent.launch.tab'] });

    await komla.agent.launch({ destination: 'tab', prompt: 'Review this' });
    await expect(
      komla.agent.launch({ destination: 'workspace' as 'tab', prompt: 'Review this' })
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_DECLARED' });

    expect(sent).toHaveLength(1);
  });

  it('refuses capabilities Komla does not have', () => {
    expect(() =>
      createKomlaClient({
        transport: recordingTransport().transport,
        capabilities: ['agent.launch' as 'agent.launch.tab'],
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));
  });

  it('reports what it declared', () => {
    const komla = createKomlaClient({
      transport: recordingTransport().transport,
      capabilities: ['status.set', 'workspace.tag'],
    });
    expect(komla.capabilities).toEqual(['status.set', 'workspace.tag']);
  });
});

describe('requiredCapability', () => {
  it('names the capability Komla checks for each operation', () => {
    expect(requiredCapability({ type: 'workspace.list' })).toBeUndefined();
    expect(requiredCapability({ type: 'status.clear' })).toBe('status.set');
    expect(requiredCapability({ type: 'workspace.unlink', workspaceIds: ['a'] })).toBe(
      'workspace.link'
    );
    expect(requiredCapability({ type: 'desktop.open', vncPort: 5901 })).toBe('preview.open');
    expect(requiredCapability({ type: 'agent.launch', destination: 'tab' })).toBe(
      'agent.launch.tab'
    );
    expect(requiredCapability({ type: 'agent.launch', destination: 'workspace' })).toBe(
      'agent.launch.workspace'
    );
  });
});

describe('client types', () => {
  it('have no methods for capabilities the client did not declare', () => {
    const readOnly = createKomlaClient({ transport: recordingTransport().transport });
    expectTypeOf(readOnly.workspace).toHaveProperty('list');
    expectTypeOf(readOnly.workspace).not.toHaveProperty('tag');
    expectTypeOf(readOnly.agent).not.toHaveProperty('launch');
    expectTypeOf(readOnly.status).toHaveProperty('refresh');
    expectTypeOf(readOnly.status).not.toHaveProperty('set');
    expectTypeOf(readOnly.workspace).toHaveProperty('notify');

    const tagger = createKomlaClient({
      transport: recordingTransport().transport,
      capabilities: ['workspace.tag', 'status.set'],
    });
    expectTypeOf(tagger.workspace).toHaveProperty('tag');
    expectTypeOf(tagger.status).toHaveProperty('clear');
    expectTypeOf(tagger.workspace).not.toHaveProperty('trash');
  });

  it('narrow an agent launch to the destinations declared', () => {
    const komla = createKomlaClient({
      transport: recordingTransport().transport,
      capabilities: ['agent.launch.tab'],
    });
    type LaunchInput = Parameters<typeof komla.agent.launch>[0];
    expectTypeOf<LaunchInput['destination']>().toEqualTypeOf<'tab'>();
    // @ts-expect-error A workspace launch needs agent.launch.workspace.
    void (() => komla.agent.launch({ destination: 'workspace' }));
  });

  it('type results by operation', () => {
    const komla = createKomlaClient({
      transport: recordingTransport().transport,
      capabilities: ['workspace.tag'],
    });
    expectTypeOf(komla.workspace.list).returns.resolves.toEqualTypeOf<WorkspaceListResult>();
    expectTypeOf(komla.execute({ type: 'workspace.tag', tag: 'x' }))
      .resolves.toHaveProperty('tag')
      .toHaveProperty('changed')
      .toEqualTypeOf<boolean>();
    // @ts-expect-error status.set wasn't declared.
    void (() => komla.execute({ type: 'status.set', id: 'x', text: 'y' }));
    // @ts-expect-error Requests are checked against the schemas Komla validates with.
    void (() => komla.workspace.tag({ tone: 'purple' }));
  });
});
