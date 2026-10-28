import { describe, expect, it } from 'vitest';

import {
  decidePreviewCandidate,
  formatPreviewUrl,
  getCandidatePorts,
  groupPreviewCandidates,
  isNonHttpListener,
  mergeDetectedServices,
  rankPopoverServers,
  splitListeningPorts,
  type PreviewUrlCandidate,
} from '../../../src/renderer/lib/dev-preview-candidates';

import type { DevPreviewOtherServer, DevPreviewService } from '../../../src/shared/types';
import type { TerminalExecutionLocation } from '../../../src/shared/types/terminal';

function scanned(
  url: string,
  executionLocation: TerminalExecutionLocation = 'workspace'
): PreviewUrlCandidate {
  return { url, terminalId: 'terminal-1', executionLocation };
}

function service(
  port: number,
  scheme: DevPreviewService['scheme'] = 'http',
  executionLocation: TerminalExecutionLocation = 'workspace'
): DevPreviewService {
  return {
    port,
    scheme,
    pid: port,
    processName: `proc-${port}`,
    terminalId: 'terminal-2',
    executionLocation,
  };
}

function otherServer(port: number): DevPreviewOtherServer {
  return { port, scheme: 'http', processName: 'python3', executionLocation: 'workspace' };
}

describe('getCandidatePorts', () => {
  it('returns each port once, defaulting by scheme', () => {
    expect(
      getCandidatePorts(
        [
          scanned('http://localhost:5173/'),
          scanned('http://127.0.0.1:5173/api'),
          scanned('http://localhost/'),
          scanned('https://localhost/'),
        ],
        false
      )
    ).toEqual({ local: [5173, 80, 443], remote: [] });
  });

  it('separates SSH host URLs from Local copy URLs in an SSH workspace', () => {
    expect(
      getCandidatePorts(
        [scanned('http://localhost:3000/'), scanned('http://localhost:4000/', 'local-mirror')],
        true
      )
    ).toEqual({ local: [4000], remote: [3000] });
  });

  it('skips ports a server cannot listen on', () => {
    expect(
      getCandidatePorts([scanned('http://localhost:0/'), scanned('http://localhost:3000/')], false)
    ).toEqual({ local: [3000], remote: [] });
  });

  it('caps each list at the IPC limit', () => {
    const candidates = Array.from({ length: 40 }, (_, index) =>
      scanned(`http://localhost:${3000 + index}/`)
    );
    expect(getCandidatePorts(candidates, false).local).toHaveLength(32);
  });
});

describe('mergeDetectedServices', () => {
  it('returns the scan unchanged without a detection', () => {
    const candidates = [scanned('http://localhost:3000/')];
    expect(mergeDetectedServices(candidates, null, false)).toBe(candidates);
  });

  it('marks liveness, attaches listening processes, and appends unprinted ports', () => {
    const merged = mergeDetectedServices(
      [
        scanned('http://localhost:3000/'),
        scanned('http://localhost:5173/'),
        scanned('http://localhost:8080/health'),
      ],
      {
        services: [service(5173), service(6006, 'https'), service(5432, null)],
        otherServers: [],
        openPorts: [8080],
        remoteOpenPorts: null,
      },
      false
    );

    expect(merged.map(({ url, live, listenerOnly }) => ({ url, live, listenerOnly }))).toEqual([
      { url: 'http://localhost:5173/', live: true, listenerOnly: undefined },
      { url: 'http://localhost:8080/health', live: true, listenerOnly: undefined },
      { url: 'https://localhost:6006/', live: true, listenerOnly: true },
      { url: 'http://localhost:3000/', live: false, listenerOnly: undefined },
      { url: 'http://localhost:5432/', live: true, listenerOnly: true },
    ]);
    expect(merged[0].service?.processName).toBe('proc-5173');
    expect(merged[2]).toMatchObject({ terminalId: 'terminal-2', executionLocation: 'workspace' });
    expect(merged.map(isNonHttpListener)).toEqual([false, false, false, false, true]);
  });

  it('matches SSH host URLs and Local copy URLs against their own machine', () => {
    const merged = mergeDetectedServices(
      [
        scanned('http://localhost:5173/'),
        scanned('http://localhost:3000/'),
        scanned('http://localhost:3000/', 'local-mirror'),
      ],
      {
        services: [service(5173, 'http', 'local-mirror'), service(8000, 'http', 'workspace')],
        otherServers: [],
        openPorts: [],
        remoteOpenPorts: [5173],
      },
      true
    );

    expect(
      merged.map(({ url, executionLocation, live, listenerOnly }) => ({
        url,
        executionLocation,
        live,
        listenerOnly,
      }))
    ).toEqual([
      {
        url: 'http://localhost:5173/',
        executionLocation: 'workspace',
        live: true,
        listenerOnly: undefined,
      },
      {
        url: 'http://localhost:5173/',
        executionLocation: 'local-mirror',
        live: true,
        listenerOnly: true,
      },
      {
        url: 'http://localhost:8000/',
        executionLocation: 'workspace',
        live: true,
        listenerOnly: true,
      },
      {
        url: 'http://localhost:3000/',
        executionLocation: 'workspace',
        live: false,
        listenerOnly: undefined,
      },
      {
        url: 'http://localhost:3000/',
        executionLocation: 'local-mirror',
        live: false,
        listenerOnly: undefined,
      },
    ]);
    expect(merged[0].service).toBeUndefined();
  });

  it("adds servers outside Komla after the terminals' ports, unless a terminal printed them", () => {
    const merged = mergeDetectedServices(
      [scanned('http://localhost:8765/')],
      {
        services: [service(5173)],
        otherServers: [otherServer(8765), otherServer(8000)],
        openPorts: [8765],
        remoteOpenPorts: null,
      },
      false
    );

    expect(merged).toEqual([
      { ...scanned('http://localhost:8765/'), live: true },
      expect.objectContaining({ url: 'http://localhost:5173/', listenerOnly: true }),
      {
        url: 'http://localhost:8000/',
        executionLocation: 'workspace',
        live: true,
        otherServer: otherServer(8000),
      },
    ]);
  });

  it('leaves SSH host URLs unchecked when the host could not be read', () => {
    expect(
      mergeDetectedServices(
        [scanned('http://localhost:3000/')],
        { services: [], otherServers: [], openPorts: [], remoteOpenPorts: null },
        true
      )
    ).toEqual([scanned('http://localhost:3000/')]);
  });
});

describe('decidePreviewCandidate', () => {
  it('auto-picks a single rootless URL or a single URL, as the scan alone does', () => {
    expect(
      decidePreviewCandidate([
        scanned('http://localhost:5173/'),
        scanned('http://localhost:5173/api'),
      ])
    ).toEqual({ kind: 'auto', candidate: scanned('http://localhost:5173/') });
    expect(decidePreviewCandidate([scanned('http://localhost:3000/dashboard')])).toEqual({
      kind: 'auto',
      candidate: scanned('http://localhost:3000/dashboard'),
    });
  });

  it('collapses localhost and 127.0.0.1 aliases before deciding', () => {
    expect(
      decidePreviewCandidate([scanned('http://127.0.0.1:4000/'), scanned('http://localhost:4000/')])
    ).toEqual({ kind: 'auto', candidate: scanned('http://127.0.0.1:4000/') });
  });

  it('asks the user when the scan is ambiguous or empty', () => {
    expect(
      decidePreviewCandidate([scanned('http://localhost:5173/'), scanned('http://localhost:5555/')])
    ).toMatchObject({ kind: 'pick' });
    expect(decidePreviewCandidate([])).toEqual({ kind: 'empty' });
  });

  it('prefers the one printed URL that still answers', () => {
    const live = { ...scanned('http://localhost:5173/'), live: true };
    const dead = { ...scanned('http://localhost:3000/'), live: false };

    expect(decidePreviewCandidate([live, dead])).toEqual({ kind: 'auto', candidate: live });
  });

  it('never opens a port no terminal printed on its own', () => {
    const listener: PreviewUrlCandidate = {
      ...scanned('http://localhost:5173/'),
      live: true,
      listenerOnly: true,
      service: service(5173),
    };
    const dead = { ...scanned('http://localhost:3000/'), live: false };

    expect(decidePreviewCandidate([listener])).toEqual({ kind: 'pick', candidates: [listener] });
    expect(decidePreviewCandidate([dead, listener])).toEqual({
      kind: 'pick',
      candidates: [dead, listener],
    });
  });

  it('ignores ports that do not answer HTTP', () => {
    const postgres: PreviewUrlCandidate = {
      ...scanned('http://localhost:5432/'),
      live: true,
      listenerOnly: true,
      service: service(5432, null),
    };

    expect(decidePreviewCandidate([postgres])).toEqual({ kind: 'empty' });
  });

  it('offers servers outside Komla without letting them open or change a choice', () => {
    const other: PreviewUrlCandidate = {
      url: 'http://localhost:8765/',
      executionLocation: 'workspace',
      live: true,
      otherServer: otherServer(8765),
    };
    const live = { ...scanned('http://localhost:5173/'), live: true };
    const booting = { ...scanned('http://localhost:3000/'), live: false };

    expect(decidePreviewCandidate([other])).toEqual({ kind: 'pick', candidates: [other] });
    expect(decidePreviewCandidate([live, other])).toEqual({ kind: 'auto', candidate: live });
    expect(decidePreviewCandidate([booting, other])).toEqual({ kind: 'auto', candidate: booting });
  });
});

describe('groupPreviewCandidates', () => {
  it('puts printed URLs that answer first, then other ports, other servers, and stopped URLs', () => {
    const listener = (port: number, scheme: DevPreviewService['scheme']): PreviewUrlCandidate => ({
      ...scanned(`http://localhost:${port}/`),
      live: true,
      listenerOnly: true,
      service: service(port, scheme),
    });
    const running = { ...scanned('http://127.0.0.1:40603/'), live: true, service: service(40603) };
    const alias = { ...scanned('http://localhost:40603/'), live: true, service: service(40603) };
    const unchecked = scanned('http://localhost:8080/health');
    const stopped = { ...scanned('http://localhost:3000/'), live: false };
    const other: PreviewUrlCandidate = {
      url: 'http://localhost:8765/',
      executionLocation: 'workspace',
      live: true,
      otherServer: otherServer(8765),
    };

    expect(
      groupPreviewCandidates([
        unchecked,
        other,
        listener(36005, null),
        stopped,
        alias,
        listener(9229, 'http'),
        running,
      ])
    ).toEqual({
      printed: [alias, unchecked],
      otherPorts: [listener(9229, 'http'), listener(36005, null)],
      otherServers: [other],
      stopped: [stopped],
    });
  });
});

describe('splitListeningPorts', () => {
  const port = (number: number, scheme: DevPreviewService['scheme'] = 'http') => ({
    url: `http://localhost:${number}/`,
    executionLocation: 'workspace' as const,
    live: true,
    listenerOnly: true,
    service: service(number, scheme),
  });
  const titles: Record<string, string> = {
    'http://localhost:3000/': 'Acme Admin',
    'http://localhost:3001/': 'Acme Admin',
    'http://localhost:6006/': 'Storybook',
  };
  const titleOf = (candidate: PreviewUrlCandidate) => titles[candidate.url];
  const urls = (candidates: PreviewUrlCandidate[]) => candidates.map((candidate) => candidate.url);

  it('keeps titled pages in view and folds the rest, repeats and non-HTTP ports too', () => {
    const { shown, folded } = splitListeningPorts(
      [],
      [port(9229), port(3000), port(3001), port(6006), port(5432, null)],
      titleOf
    );

    expect(urls(shown)).toEqual(['http://localhost:3000/', 'http://localhost:6006/']);
    expect(urls(folded)).toEqual([
      'http://localhost:9229/',
      'http://localhost:3001/',
      'http://localhost:5432/',
    ]);
  });

  it('folds untitled ports once a printed URL is in view', () => {
    const { shown, folded } = splitListeningPorts(
      [scanned('http://localhost:5173/')],
      [port(9229), port(6006)],
      titleOf
    );

    expect(urls(shown)).toEqual(['http://localhost:6006/']);
    expect(urls(folded)).toEqual(['http://localhost:9229/']);
  });

  it('folds a port showing the page a printed URL shows', () => {
    const { shown } = splitListeningPorts(
      [scanned('http://localhost:3000/')],
      [port(3001)],
      titleOf
    );

    expect(shown).toEqual([]);
  });

  it('shows every HTTP port when nothing stands out', () => {
    const { shown, folded } = splitListeningPorts(
      [],
      [port(8080), port(9229), port(5432, null)],
      () => undefined
    );

    expect(urls(shown)).toEqual(['http://localhost:8080/', 'http://localhost:9229/']);
    expect(urls(folded)).toEqual(['http://localhost:5432/']);
  });
});

describe('rankPopoverServers', () => {
  const urls = (candidates: PreviewUrlCandidate[]) => candidates.map((candidate) => candidate.url);
  const detection = mergeDetectedServices(
    [scanned('http://localhost:5173/'), scanned('http://localhost:4000/')],
    {
      services: [service(5173), service(9229), service(5432, null)],
      otherServers: [otherServer(8765)],
      openPorts: [],
    },
    false
  );

  it('puts printed running URLs first, then the rest behind Show more, stopped last', () => {
    const { shown, more, outside } = rankPopoverServers(detection, () => undefined);

    expect(urls(shown)).toEqual(['http://localhost:5173/']);
    expect(urls(more)).toEqual([
      'http://localhost:9229/',
      'http://localhost:5432/',
      'http://localhost:4000/',
    ]);
    expect(urls(outside)).toEqual(['http://localhost:8765/']);
  });

  it('keeps servers outside Komla apart when nothing else runs', () => {
    const { shown, more, outside } = rankPopoverServers(
      mergeDetectedServices(
        [scanned('http://localhost:4000/')],
        { services: [], otherServers: [otherServer(8765)], openPorts: [] },
        false
      ),
      () => undefined
    );

    expect(urls(shown)).toEqual(['http://localhost:4000/']);
    expect(urls(more)).toEqual([]);
    expect(urls(outside)).toEqual(['http://localhost:8765/']);
  });
});

describe('formatPreviewUrl', () => {
  it('drops the http scheme and a bare trailing slash', () => {
    expect(formatPreviewUrl('http://localhost:5173/')).toBe('localhost:5173');
    expect(formatPreviewUrl('http://127.0.0.1:3000/dashboard?tab=1')).toBe(
      '127.0.0.1:3000/dashboard?tab=1'
    );
    expect(formatPreviewUrl('https://localhost:6006/')).toBe('https://localhost:6006');
    expect(formatPreviewUrl('not a url')).toBe('not a url');
  });
});
