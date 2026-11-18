import { describe, expect, it, vi } from 'vitest';
import {
  fieldNodes,
  loadChildren,
  methodNodes,
  compareVersions,
  filterRows,
  hoverText,
  methodGroupNodes,
  paramNodes,
  parseJump,
  unopenedServices,
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
      verb: 'SELECT',
      detail: '',
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
    // An output shows only its type. The group it sits in says it is one.
    expect(nodes.map((n) => n.detail)).toEqual([
      'required string',
      'optional string',
      'string',
      'array',
    ]);
  });

  it('splits a method into an Inputs group and an Outputs group', () => {
    const path = { provider: 'a', service: 'b', resource: 'c', method: 'm' };
    const [inputs, outputs] = methodGroupNodes(path, [
      { name: 'out_b', type: 'string', paramType: 'output', shape: '', description: '' },
      { name: 'opt', type: 'string', paramType: 'input_optional', shape: '', description: '' },
      { name: 'req', type: 'string', paramType: 'input_required', shape: '', description: '' },
      { name: 'out_a', type: 'array', paramType: 'output', shape: '', description: '' },
    ]);
    expect(inputs).toMatchObject({
      kind: 'inputsGroup',
      label: 'Inputs',
      detail: '2, 1 required',
      expandable: true,
      copyText: null,
    });
    expect(inputs?.children?.map((n) => n.label)).toEqual(['req', 'opt']);
    expect(outputs).toMatchObject({
      kind: 'outputsGroup',
      label: 'Outputs',
      detail: '2',
      expandable: true,
    });
    expect(outputs?.children?.map((n) => n.label)).toEqual(['out_b', 'out_a']);
    expect(inputs?.id).not.toBe(outputs?.id);
  });

  it('counts a field the engine calls a response as an output', () => {
    // The provider built into the engine marks what a method returns as
    // `response`, where the others say `output`.
    const path = { provider: 'a', service: 'b', resource: 'c', method: 'm' };
    const [inputs, outputs] = methodGroupNodes(path, [
      { name: 'vpc_id', type: 'string', paramType: 'response', shape: '', description: '' },
      { name: 'region', type: 'string', paramType: 'input_optional', shape: '', description: '' },
      { name: 'cidr', type: 'string', paramType: 'response', shape: '', description: '' },
    ]);
    expect(inputs?.children?.map((n) => n.label)).toEqual(['region']);
    expect(inputs?.detail).toBe('1, 0 required');
    expect(outputs?.children?.map((n) => n.label)).toEqual(['vpc_id', 'cidr']);
    expect(outputs?.children?.map((n) => n.detail)).toEqual(['string', 'string']);
  });

  it('shows an empty group as one that cannot be opened', () => {
    const path = { provider: 'a', service: 'b', resource: 'c', method: 'm' };
    const [inputs, outputs] = methodGroupNodes(path, [
      { name: 'req', type: 'string', paramType: 'input_required', shape: '', description: '' },
    ]);
    expect(inputs).toMatchObject({ detail: '1, 1 required', expandable: true });
    expect(outputs).toMatchObject({ detail: 'none', expandable: false });
    expect(outputs?.children).toEqual([]);
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
    const groups = await loadChildren(method, explorer);
    expect(explorer.methodFields).toHaveBeenCalledWith('p', 's', 'r', 'get');
    expect(groups.map((n) => n.kind)).toEqual(['inputsGroup', 'outputsGroup']);
  });

  it('opens a method group from the fields it already holds', async () => {
    const explorer = api({
      methodFields: vi.fn(() =>
        Promise.resolve([
          { name: 'org', type: 'string', paramType: 'input_required', shape: '', description: '' },
          { name: 'id', type: 'integer', paramType: 'output', shape: '', description: '' },
        ]),
      ),
    });
    const [method] = methodNodes({ provider: 'p', service: 's', resource: 'r' }, [
      { name: 'get', sqlVerb: 'SELECT', requiredParams: ['org'], description: '' },
    ]);
    if (!method) {
      throw new Error('fixture missing');
    }
    const [inputs, outputs] = await loadChildren(method, explorer);
    if (!inputs || !outputs) {
      throw new Error('groups missing');
    }
    expect((await loadChildren(inputs, explorer)).map((n) => n.label)).toEqual(['org']);
    expect((await loadChildren(outputs, explorer)).map((n) => n.label)).toEqual(['id']);
    expect(explorer.methodFields).toHaveBeenCalledTimes(1);
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

describe('filterRows', () => {
  const roots = providerNodes([
    { name: 'aws', version: 'v1' },
    { name: 'github', version: 'v2' },
  ]);
  const [aws, github] = roots;
  const awsServices = serviceNodes('aws', [
    { name: 'ec2', id: '', title: '', description: '' },
    { name: 's3', id: '', title: '', description: '' },
  ]);
  const githubServices = serviceNodes('github', [
    { name: 'repos', id: '', title: '', description: '' },
  ]);
  const reposResources = resourceNodes('github', 'repos', [
    { name: 'repos', id: '', description: '' },
    { name: 'branches', id: '', description: '' },
  ]);
  const loaded = (nodes: ReturnType<typeof providerNodes>) => ({
    status: 'loaded' as const,
    nodes,
  });
  if (!aws || !github || !githubServices[0]) {
    throw new Error('fixtures missing');
  }
  const children = new Map([
    [aws.id, loaded(awsServices)],
    [github.id, loaded(githubServices)],
    [githubServices[0].id, loaded(reposResources)],
  ]);
  const labels = (query: string, expanded = new Set<string>()) =>
    filterRows(roots, expanded, children, query).map((row) => `${row.depth}:${row.node.label}`);

  it('is the plain tree when the filter is empty', () => {
    expect(labels('')).toEqual(['0:aws', '0:github']);
    expect(labels('   ')).toEqual(['0:aws', '0:github']);
  });

  it('keeps the parents of a match in view, opened', () => {
    expect(labels('branch')).toEqual(['0:github', '1:repos', '2:branches']);
    const rows = filterRows(roots, new Set(), children, 'branch');
    expect(rows.map((row) => row.expanded)).toEqual([true, true, false]);
    expect(rows.map((row) => row.matched)).toEqual([false, false, true]);
  });

  it('matches part of a name at any level, without regard to case', () => {
    expect(labels('EC')).toEqual(['0:aws', '1:ec2']);
    expect(labels('git')).toEqual(['0:github']);
    // The service and the resource of the same name both match.
    expect(labels('repo')).toEqual(['0:github', '1:repos', '2:repos']);
  });

  it('shows nothing when nothing loaded matches', () => {
    expect(labels('lambda')).toEqual([]);
  });

  it('lets a node that matched by name be opened to show all it has', () => {
    expect(labels('git', new Set([github.id]))).toEqual(['0:github', '1:repos']);
  });

  it('does not match on the Fields and Methods groups', () => {
    const [resource] = reposResources;
    if (!resource) {
      throw new Error('fixture missing');
    }
    const withGroups = new Map(children).set(resource.id, {
      status: 'loaded' as const,
      nodes: resourceGroupNodes(resource.path),
    });
    const rows = filterRows(roots, new Set(), withGroups, 'methods');
    expect(rows).toEqual([]);
  });

  it('counts the services whose resources are not loaded yet', () => {
    expect(unopenedServices(roots, children).map((node) => node.label)).toEqual(['ec2', 's3']);
    // A provider whose services are not loaded contributes none.
    expect(unopenedServices(roots, new Map())).toEqual([]);
  });
});

describe('parseJump', () => {
  it('reads one to three dotted names', () => {
    expect(parseJump('github')).toEqual({ provider: 'github' });
    expect(parseJump('github.repos')).toEqual({ provider: 'github', service: 'repos' });
    expect(parseJump(' aws.ec2.instances; ')).toEqual({
      provider: 'aws',
      service: 'ec2',
      resource: 'instances',
    });
    expect(parseJump('"aws"."ec2"."instances"')).toEqual({
      provider: 'aws',
      service: 'ec2',
      resource: 'instances',
    });
  });

  it('refuses anything else', () => {
    for (const bad of ['', '.', 'aws.', '.ec2', 'a..b', 'a.b.c.d']) {
      expect(parseJump(bad)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders versions by their numbers, not as text', () => {
    expect(compareVersions('v26.08.00444', 'v26.09.00461')).toBeLessThan(0);
    expect(compareVersions('v26.09.00461', 'v26.08.00444')).toBeGreaterThan(0);
    expect(compareVersions('v26.08.00444', 'v26.08.00444')).toBe(0);
    expect(compareVersions('v9.1.5', 'v10.0.0')).toBeLessThan(0);
    expect(compareVersions('26.08.444', 'v26.08.00444')).toBe(0);
  });

  it('claims nothing about a version it cannot read', () => {
    expect(compareVersions('internal', 'v1.0.0')).toBeNull();
    expect(compareVersions('v1.0', 'v1.0.0')).toBeNull();
    expect(compareVersions('', '')).toBeNull();
  });
});

describe('hoverText', () => {
  it('leads with the whole name, then what the engine says', () => {
    const [service] = serviceNodes('github', [
      { name: 'repos', id: 'repos:v1', title: 'repos API', description: 'Repositories.' },
    ]);
    expect(service && hoverText(service)).toBe('github.repos\nRepositories.');
    const [resource] = resourceNodes('github', 'repos', [
      { name: 'repos', id: 'github.repos.repos', description: '' },
    ]);
    expect(resource && hoverText(resource)).toBe('github.repos.repos');
  });

  it('names the verb of a method', () => {
    const [method] = methodNodes({ provider: 'github', service: 'repos', resource: 'repos' }, [
      { name: 'list_for_org', sqlVerb: 'select', requiredParams: ['org'], description: '' },
    ]);
    expect(method && hoverText(method)).toBe(
      'SELECT github.repos.repos.list_for_org\nRequired: org',
    );
  });

  it('gives a provider its version and a field its type', () => {
    const [provider] = providerNodes([{ name: 'github', version: 'v26.08.00448' }]);
    expect(provider && hoverText(provider)).toBe('github v26.08.00448');
    const [field] = fieldNodes({ provider: 'github', service: 'repos', resource: 'repos' }, [
      { name: 'stargazers_count', type: 'integer', description: 'Stars.' },
    ]);
    expect(field && hoverText(field)).toBe('stargazers_count integer\nStars.');
  });
});
