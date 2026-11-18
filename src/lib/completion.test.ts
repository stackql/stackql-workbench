import { describe, expect, it } from 'vitest';
import {
  EMPTY_CATALOG,
  catalogFrom,
  currentStatement,
  sampleStatement,
  statementAt,
  suggest,
  type Catalog,
} from './completion';
import {
  fieldNodes,
  methodGroupNodes,
  methodNodes,
  providerNodes,
  resourceNodes,
  serviceNodes,
  type ChildState,
  type TreeNode,
} from './explorerTree';

const catalog: Catalog = {
  providers: ['github', 'aws'],
  services: (provider) => (provider === 'github' ? ['repos', 'orgs'] : null),
  resources: (provider, service) =>
    provider === 'github' && service === 'repos' ? ['repos', 'branches', 'my-res'] : null,
  fields: (provider, service, resource) =>
    provider === 'github' && service === 'repos' && resource === 'repos'
      ? [
          { name: 'name', type: 'string' },
          { name: 'stargazers_count', type: 'integer' },
        ]
      : null,
};

const labels = (before: string, statement = before, explicit = false) =>
  suggest(catalog, before, statement, explicit)?.options.map((option) => option.label) ?? null;

describe('suggest: names', () => {
  it('offers providers after FROM, in order', () => {
    expect(labels('SELECT * FROM ')).toEqual(['aws', 'github']);
    expect(suggest(catalog, 'SELECT * FROM gi', 'SELECT * FROM gi', false)).toMatchObject({
      replace: 2,
      options: [
        { label: 'aws', kind: 'provider' },
        { label: 'github', kind: 'provider' },
      ],
    });
  });

  it('offers the next level after a dot', () => {
    expect(labels('SELECT * FROM github.')).toEqual(['orgs', 'repos']);
    expect(labels('SELECT * FROM github.repos.')).toEqual(['branches', 'my-res', 'repos']);
    expect(suggest(catalog, 'SELECT * FROM github.repos.br', '', false)?.replace).toBe(2);
  });

  it('offers nothing for a level that has not been loaded', () => {
    expect(labels('SELECT * FROM aws.')).toBeNull();
    expect(labels('SELECT * FROM github.orgs.')).toBeNull();
    expect(labels('SELECT * FROM github.repos.repos.')).toBeNull();
  });

  it('knows the other keywords that take a name', () => {
    for (const lead of [
      'INSERT INTO ',
      'UPDATE ',
      'DESCRIBE ',
      'DESCRIBE EXTENDED ',
      'DESCRIBE METHOD ',
      'EXEC ',
      'SELECT a FROM x.y.z JOIN ',
      'SHOW SERVICES IN ',
      'SHOW EXTENDED RESOURCES IN ',
    ]) {
      expect(labels(lead), lead).toEqual(['aws', 'github']);
    }
  });

  it('does not take the IN of a WHERE clause for one', () => {
    expect(labels('SELECT name FROM github.repos.repos WHERE org IN ')).toBeNull();
  });

  it('reads a quoted name', () => {
    expect(labels('SELECT * FROM "github".')).toEqual(['orgs', 'repos']);
    expect(labels('SELECT * FROM "github"."repos".')).toEqual(['branches', 'my-res', 'repos']);
  });
});

describe('suggest: fields', () => {
  const statement = "SELECT  FROM github.repos.repos WHERE org = 'stackql'";

  it('offers the fields of the resource the statement names, in the select list', () => {
    expect(labels('SELECT na', statement)).toEqual(['name', 'stargazers_count']);
    expect(suggest(catalog, 'SELECT na', statement, false)).toMatchObject({
      replace: 2,
      options: [
        { label: 'name', kind: 'field', detail: 'string' },
        { label: 'stargazers_count', kind: 'field', detail: 'integer' },
      ],
    });
  });

  it('offers them in WHERE too', () => {
    const full = 'SELECT name FROM github.repos.repos WHERE st';
    expect(labels(full, full)).toEqual(['name', 'stargazers_count']);
  });

  it('offers them after an alias and a dot', () => {
    const full = 'SELECT r. FROM github.repos.repos r';
    expect(labels('SELECT r.', full)).toEqual(['name', 'stargazers_count']);
  });

  it('waits to be asked when nothing has been typed', () => {
    expect(labels('SELECT ', statement)).toBeNull();
    expect(labels('SELECT ', statement, true)).toEqual(['name', 'stargazers_count']);
  });

  it('offers nothing when the fields of the resource have not been loaded', () => {
    const full = 'SELECT na FROM github.repos.branches';
    expect(labels('SELECT na', full)).toBeNull();
    expect(labels('SELECT na', 'SELECT na')).toBeNull();
  });
});

describe('suggest: where it stays quiet', () => {
  it('offers nothing inside a string or a comment', () => {
    expect(labels("SELECT * FROM github.repos.repos WHERE org = 'gi")).toBeNull();
    expect(labels('-- FROM ')).toBeNull();
    expect(labels("SELECT '--' FROM ")).toEqual(['aws', 'github']);
  });

  it('offers nothing with nothing loaded', () => {
    expect(suggest(EMPTY_CATALOG, 'SELECT * FROM ', 'SELECT * FROM ', true)).toBeNull();
  });
});

describe('currentStatement', () => {
  it('takes the statement around the cursor', () => {
    const text = 'SHOW PROVIDERS; SELECT a FROM x.y.z WHERE b = 1; SHOW VERSION';
    const cursor = text.indexOf('FROM');
    expect(currentStatement(text, cursor)).toEqual({
      before: ' SELECT a ',
      statement: ' SELECT a FROM x.y.z WHERE b = 1',
    });
    expect(currentStatement(text, text.length).statement).toBe(' SHOW VERSION');
    expect(currentStatement('SELECT 1', 3)).toEqual({ before: 'SEL', statement: 'SELECT 1' });
  });
});

describe('statementAt', () => {
  const text = 'SHOW PROVIDERS;\nSHOW VERSION;\n';

  it('takes the statement the cursor is in', () => {
    expect(statementAt(text, 4)).toBe('SHOW PROVIDERS');
    expect(statementAt(text, text.indexOf('VERSION'))).toBe('SHOW VERSION');
  });

  it('takes the statement that has just ended when the cursor follows its semicolon', () => {
    expect(statementAt(text, text.length)).toBe('SHOW VERSION');
    expect(statementAt(text, 'SHOW PROVIDERS;'.length)).toBe('SHOW PROVIDERS');
    expect(statementAt('SHOW VERSION ;  ', 16)).toBe('SHOW VERSION');
  });

  it('has nothing to give for an empty editor', () => {
    expect(statementAt('', 0)).toBe('');
    expect(statementAt(' ;; ', 4)).toBe('');
  });
});

describe('catalogFrom', () => {
  const path = { provider: 'github', service: 'repos', resource: 'repos' };
  const roots = providerNodes([{ name: 'github', version: 'v1' }]);
  const services = serviceNodes('github', [
    { name: 'repos', id: 'repos:v1', title: 'repos API', description: '' },
  ]);
  const resources = resourceNodes('github', 'repos', [
    { name: 'repos', id: 'github.repos.repos', description: '' },
  ]);
  const methods = methodNodes(path, [
    { name: 'list_for_org', sqlVerb: 'SELECT', requiredParams: ['org'], description: '' },
  ]);
  const loaded = (nodes: TreeNode[]): ChildState => ({ status: 'loaded', nodes });

  it('reads names from what is loaded and nothing from what is not', () => {
    const children = new Map<string, ChildState>([
      ['p:github', loaded(services)],
      ['s:github.repos', { status: 'loading' }],
    ]);
    const made = catalogFrom(roots, children);
    expect(made.providers).toEqual(['github']);
    expect(made.services('github')).toEqual(['repos']);
    expect(made.services('aws')).toBeNull();
    expect(made.resources('github', 'repos')).toBeNull();
    expect(made.fields('github', 'repos', 'repos')).toBeNull();
  });

  it('gathers fields from the resource and from the methods that have been opened', () => {
    const groups = methodGroupNodes({ ...path, method: 'list_for_org' }, [
      { name: 'org', type: 'string', paramType: 'input_required', shape: '', description: '' },
      { name: 'name', type: 'string', paramType: 'output', shape: '', description: '' },
      { name: 'forks', type: 'integer', paramType: 'output', shape: '', description: '' },
    ]);
    const children = new Map<string, ChildState>([
      ['p:github', loaded(services)],
      ['s:github.repos', loaded(resources)],
      [
        'fg:github.repos.repos',
        loaded(fieldNodes(path, [{ name: 'name', type: 'string', description: '' }])),
      ],
      ['mg:github.repos.repos', loaded(methods)],
      ['m:github.repos.repos.list_for_org', loaded(groups)],
    ]);
    const made = catalogFrom(roots, children);
    expect(made.resources('github', 'repos')).toEqual(['repos']);
    expect(made.fields('github', 'repos', 'repos')).toEqual([
      { name: 'name', type: 'string' },
      { name: 'org', type: 'required string' },
      { name: 'forks', type: 'integer' },
    ]);
  });
});

describe('sampleStatement', () => {
  it('names an installed provider', () => {
    expect(sampleStatement(['homebrew', 'github'])).toContain('-- SHOW SERVICES IN github;');
  });

  it('points at the registry when nothing is installed', () => {
    expect(sampleStatement([])).toContain('-- REGISTRY LIST;');
  });

  it('is all comments, so running it does nothing', () => {
    for (const text of [sampleStatement(['github']), sampleStatement([])]) {
      expect(text.split('\n').every((line) => line.startsWith('--'))).toBe(true);
    }
  });
});
