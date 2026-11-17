import { describe, expect, it, vi } from 'vitest';
import {
  fieldNodes,
  loadChildren,
  methodNodes,
  paramNodes,
  providerNodes,
  qualifiedName,
  resourceGroupNodes,
  resourceNodes,
  serviceNodes,
  visibleRows,
  type ChildState,
  type ExplorerApi,
} from './explorerTree';

function api(over: Partial<ExplorerApi> = {}): ExplorerApi {
  return {
    providers: vi.fn(() => Promise.resolve([])),
    services: vi.fn(() => Promise.resolve([])),
    resources: vi.fn(() => Promise.resolve([])),
    methods: vi.fn(() => Promise.resolve([])),
    fields: vi.fn(() => Promise.resolve([])),
    methodFields: vi.fn(() => Promise.resolve([])),
    ...over,
  };
}

describe('qualifiedName', () => {
  it('joins the parts that are present', () => {
    expect(qualifiedName({ provider: 'github' })).toBe('github');
    expect(qualifiedName({ provider: 'github', service: 'repos' })).toBe('github.repos');
    expect(qualifiedName({ provider: 'github', service: 'repos', resource: 'repos' })).toBe(
      'github.repos.repos',
    );
    expect(
      qualifiedName({ provider: 'github', service: 'repos', resource: 'repos', method: 'get' }),
    ).toBe('github.repos.repos.get');
  });
});

describe('nodes', () => {
  it('sorts providers and copies the provider name', () => {
    const nodes = providerNodes([
      { name: 'homebrew', version: 'v2' },
      { name: 'github', version: 'v1' },
    ]);
    expect(nodes.map((n) => n.label)).toEqual(['github', 'homebrew']);
    expect(nodes[0]).toMatchObject({ kind: 'provider', detail: 'v1', copyText: 'github' });
    expect(nodes.every((n) => n.expandable)).toBe(true);
  });

  it('copies the fully qualified name for services and resources', () => {
    const [service] = serviceNodes('homebrew', [
      { name: 'formula', id: 'formula:v25', title: 'Homebrew Formulae API', description: '' },
    ]);
    expect(service).toMatchObject({
      copyText: 'homebrew.formula',
      detail: 'Homebrew Formulae API',
    });

    const [resource] = resourceNodes('homebrew', 'formula', [
      { name: 'vw_info', id: 'homebrew.formula.vw_info', description: '' },
    ]);
    expect(resource).toMatchObject({ copyText: 'homebrew.formula.vw_info', expandable: true });
  });

  it('does not repeat a service title that equals its name', () => {
    const [service] = serviceNodes('x', [
      { name: 'repos', id: '', title: 'repos', description: '' },
    ]);
    expect(service?.detail).toBe('');
  });

  it('opens a resource into fields and methods', () => {
    const groups = resourceGroupNodes({ provider: 'a', service: 'b', resource: 'c' });
    expect(groups.map((g) => g.kind)).toEqual(['fieldsGroup', 'methodsGroup']);
    expect(groups.every((g) => g.copyText === null)).toBe(true);
    expect(new Set(groups.map((g) => g.id)).size).toBe(2);
  });

  it('keeps fields in column order and copies the bare column name', () => {
    const nodes = fieldNodes({ provider: 'a', service: 'b', resource: 'c' }, [
      { name: 'name', type: 'string', description: '' },
      { name: 'aliases', type: 'array', description: '' },
    ]);
    expect(nodes.map((n) => n.label)).toEqual(['name', 'aliases']);
    expect(nodes[1]).toMatchObject({ copyText: 'aliases', detail: 'array', expandable: false });
  });

  it('shows the SQL verb on a method and copies its qualified name', () => {
    const [method] = methodNodes({ provider: 'github', service: 'repos', resource: 'repos' }, [
      {
        name: 'list_for_org',
        sqlVerb: 'SELECT',
        requiredParams: ['org'],
        description: 'repos/list-for-org',
      },
    ]);
    expect(method).toMatchObject({
      detail: 'SELECT',
      copyText: 'github.repos.repos.list_for_org',
      expandable: true,
    });
    expect(method?.title).toContain('Required: org');
    expect(method?.path.method).toBe('list_for_org');
  });

  it('orders method parameters: required, optional, then outputs', () => {
    const nodes = paramNodes({ provider: 'a', service: 'b', resource: 'c', method: 'm' }, [
      { name: 'out_b', type: 'string', paramType: 'output', shape: '', description: '' },
      { name: 'opt', type: 'string', paramType: 'input_optional', shape: '', description: '' },
      { name: 'req', type: 'string', paramType: 'input_required', shape: '', description: '' },
      { name: 'out_a', type: 'array', paramType: 'output', shape: '', description: '' },
    ]);
    expect(nodes.map((n) => n.label)).toEqual(['req', 'opt', 'out_b', 'out_a']);
    expect(nodes.map((n) => n.detail)).toEqual([
      'required string',
      'optional string',
      'output string',
      'output array',
    ]);
  });

  it('gives the same parameter name distinct ids as input and output', () => {
    const nodes = paramNodes({ provider: 'a', service: 'b', resource: 'c', method: 'm' }, [
      { name: 'x', type: '', paramType: 'input_required', shape: '', description: '' },
      { name: 'x', type: '', paramType: 'output', shape: '', description: '' },
    ]);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(2);
  });
});

describe('loadChildren', () => {
  it('loads providers for the root', async () => {
    const explorer = api({
      providers: vi.fn(() => Promise.resolve([{ name: 'github', version: 'v1' }])),
    });
    const nodes = await loadChildren(null, explorer);
    expect(nodes.map((n) => n.label)).toEqual(['github']);
  });

  it('asks the host with the names on the path', async () => {
    const explorer = api();
    const [provider] = providerNodes([{ name: 'github', version: 'v1' }]);
    const [service] = serviceNodes('github', [
      { name: 'repos', id: '', title: '', description: '' },
    ]);
    const [resource] = resourceNodes('github', 'repos', [
      { name: 'repos', id: '', description: '' },
    ]);
    if (!provider || !service || !resource) {
      throw new Error('fixtures missing');
    }

    await loadChildren(provider, explorer);
    expect(explorer.services).toHaveBeenCalledWith('github');

    await loadChildren(service, explorer);
    expect(explorer.resources).toHaveBeenCalledWith('github', 'repos');

    // A resource opens into its two groups without a host call.
    const groups = await loadChildren(resource, explorer);
    expect(groups).toHaveLength(2);
    expect(explorer.fields).not.toHaveBeenCalled();

    const [fieldsGroup, methodsGroup] = groups;
    if (!fieldsGroup || !methodsGroup) {
      throw new Error('groups missing');
    }
    await loadChildren(fieldsGroup, explorer);
    expect(explorer.fields).toHaveBeenCalledWith('github', 'repos', 'repos');
    await loadChildren(methodsGroup, explorer);
    expect(explorer.methods).toHaveBeenCalledWith('github', 'repos', 'repos');
  });

  it('loads method parameters with all four names', async () => {
    const explorer = api();
    const [method] = methodNodes({ provider: 'p', service: 's', resource: 'r' }, [
      { name: 'get', sqlVerb: 'SELECT', requiredParams: [], description: '' },
    ]);
    if (!method) {
      throw new Error('fixture missing');
    }
    await loadChildren(method, explorer);
    expect(explorer.methodFields).toHaveBeenCalledWith('p', 's', 'r', 'get');
  });

  it('has nothing under a field', async () => {
    const [field] = fieldNodes({ provider: 'p', service: 's', resource: 'r' }, [
      { name: 'x', type: '', description: '' },
    ]);
    if (!field) {
      throw new Error('fixture missing');
    }
    expect(await loadChildren(field, api())).toEqual([]);
  });
});

describe('visibleRows', () => {
  const roots = providerNodes([
    { name: 'github', version: 'v1' },
    { name: 'homebrew', version: 'v2' },
  ]);
  const services = serviceNodes('github', [{ name: 'repos', id: '', title: '', description: '' }]);

  it('shows only roots when nothing is expanded', () => {
    const rows = visibleRows(roots, new Set(), new Map());
    expect(rows.map((r) => [r.node.label, r.depth])).toEqual([
      ['github', 0],
      ['homebrew', 0],
    ]);
  });

  it('shows loaded children under an expanded node, one level deeper', () => {
    const children = new Map<string, ChildState>([
      ['p:github', { status: 'loaded', nodes: services }],
    ]);
    const rows = visibleRows(roots, new Set(['p:github']), children);
    expect(rows.map((r) => [r.node.label, r.depth])).toEqual([
      ['github', 0],
      ['repos', 1],
      ['homebrew', 0],
    ]);
  });

  it('hides children of a collapsed node even when they are loaded', () => {
    const children = new Map<string, ChildState>([
      ['p:github', { status: 'loaded', nodes: services }],
    ]);
    expect(visibleRows(roots, new Set(), children)).toHaveLength(2);
  });

  it('carries the loading and error state on the expanded row', () => {
    const loading = visibleRows(
      roots,
      new Set(['p:github']),
      new Map<string, ChildState>([['p:github', { status: 'loading' }]]),
    );
    expect(loading[0]?.state).toEqual({ status: 'loading' });

    const failed = visibleRows(
      roots,
      new Set(['p:github']),
      new Map<string, ChildState>([['p:github', { status: 'error', message: 'nope' }]]),
    );
    expect(failed[0]?.state).toEqual({ status: 'error', message: 'nope' });
    expect(failed).toHaveLength(2);
  });
});
