import { describe, expect, it } from 'vitest';
import type { Method, MethodField } from '../host/types';
import {
  generateStatement,
  ident,
  otherSelectMethods,
  pickSelectMethod,
  tableName,
} from './generateSql';

const path = { provider: 'github', service: 'repos', resource: 'repos' };
const field = (name: string, paramType: string, type = 'string'): MethodField => ({
  name,
  type,
  paramType,
  shape: '',
  description: '',
});
const method = (name: string, sqlVerb: string, requiredParams: string[]): Method => ({
  name,
  sqlVerb,
  requiredParams,
  description: '',
});

describe('names', () => {
  it('leaves plain names bare and quotes the rest', () => {
    expect(ident('repos')).toBe('repos');
    expect(ident('list')).toBe('list');
    expect(ident('my-thing')).toBe('"my-thing"');
    expect(ident('odd"name')).toBe('"odd""name"');
    expect(ident('1st')).toBe('"1st"');
  });

  it('writes the dotted table name', () => {
    expect(tableName(path)).toBe('github.repos.repos');
    expect(tableName({ provider: 'a', service: 'b-c', resource: 'd' })).toBe('a."b-c".d');
  });
});

describe('pickSelectMethod', () => {
  it('takes the SELECT method that needs the fewest parameters', () => {
    const picked = pickSelectMethod([
      method('get', 'SELECT', ['owner', 'repo']),
      method('delete', 'DELETE', []),
      method('list_for_org', 'SELECT', ['org']),
      method('list_for_user', 'select', ['username']),
    ]);
    expect(picked?.name).toBe('list_for_org');
  });

  it('has nothing to pick when no method is a SELECT', () => {
    expect(pickSelectMethod([method('delete', 'DELETE', ['id'])])).toBeNull();
    expect(pickSelectMethod([])).toBeNull();
  });
});

describe('otherSelectMethods', () => {
  const methods = [
    method('list_public', 'SELECT', []),
    method('list_for_org', 'SELECT', ['org']),
    method('get', 'select', ['owner', 'repo']),
    method('delete', 'DELETE', ['owner', 'repo']),
  ];

  it('names the SELECT methods that were not picked, with what each requires', () => {
    const picked = methods[0];
    expect(picked && otherSelectMethods(methods, picked)).toBe(
      '-- Other SELECT methods, with what each requires: list_for_org (org); get (owner, repo).',
    );
  });

  it('says nothing when the picked method is the only SELECT', () => {
    const only = method('list', 'SELECT', []);
    expect(otherSelectMethods([only, method('delete', 'DELETE', [])], only)).toBe('');
  });
});

describe('generateStatement', () => {
  const fields = [
    field('org', 'input_required'),
    field('per_page', 'input_optional', 'integer'),
    field('name', 'output'),
    field('stargazers_count', 'output', 'integer'),
  ];

  it('lists the output fields and puts required parameters in WHERE', () => {
    expect(generateStatement(path, 'SELECT', 'list_for_org', fields)).toBe(
      [
        '-- github.repos.repos, method list_for_org (SELECT). Fill in each <placeholder> before running.',
        'SELECT',
        '  name,',
        '  stargazers_count',
        'FROM github.repos.repos',
        "WHERE org = '<org>';",
        '',
      ].join('\n'),
    );
  });

  it('joins several required parameters with AND and leaves numbers unquoted', () => {
    const sql = generateStatement(path, 'SELECT', 'get', [
      field('owner', 'input_required'),
      field('page', 'input_required', 'integer'),
      field('id', 'output'),
    ]);
    expect(sql).toContain("WHERE owner = '<owner>'\n  AND page = <page>;");
  });

  it('counts a field the engine calls a response as an output', () => {
    const sql = generateStatement(path, 'SELECT', 'get', [field('vpc_id', 'response')]);
    expect(sql).toContain('SELECT\n  vpc_id\nFROM');
    expect(sql).not.toContain('WHERE');
  });

  it('selects everything when the outputs are not known', () => {
    expect(generateStatement(path, 'SELECT', 'get', [field('org', 'input_required')])).toContain(
      'SELECT\n  *\nFROM github.repos.repos\nWHERE',
    );
  });

  it('builds INSERT from the required inputs', () => {
    const sql = generateStatement(path, 'INSERT', 'create_in_org', [
      field('org', 'input_required'),
      field('name', 'input_required'),
      field('private', 'input_optional', 'boolean'),
      field('id', 'output'),
    ]);
    expect(sql).toContain(
      "INSERT INTO github.repos.repos (\n  org,\n  name\n)\nSELECT\n  '<org>',\n  '<name>';",
    );
    expect(sql).not.toContain('private');
  });

  it('puts optional inputs in SET and required ones in WHERE for UPDATE and REPLACE', () => {
    const inputs = [
      field('owner', 'input_required'),
      field('repo', 'input_required'),
      field('description', 'input_optional'),
    ];
    const update = generateStatement(path, 'UPDATE', 'update', inputs);
    expect(update).toContain(
      "UPDATE github.repos.repos\nSET\n  description = '<description>'\nWHERE owner = '<owner>'\n  AND repo = '<repo>';",
    );
    expect(generateStatement(path, 'replace', 'replace', inputs)).toContain(
      'REPLACE github.repos.repos\nSET',
    );
  });

  it('builds DELETE and EXEC from the required inputs', () => {
    const inputs = [field('owner', 'input_required'), field('repo', 'input_required')];
    expect(generateStatement(path, 'DELETE', 'delete', inputs)).toContain(
      "DELETE FROM github.repos.repos\nWHERE owner = '<owner>'\n  AND repo = '<repo>';",
    );
    expect(generateStatement(path, 'EXEC', 'list_languages', inputs)).toContain(
      "EXEC github.repos.repos.list_languages\n  @owner = '<owner>',\n  @repo = '<repo>';",
    );
  });

  it('still gives a usable shape when a method takes nothing', () => {
    expect(generateStatement(path, 'DELETE', 'purge', [])).toContain(
      'DELETE FROM github.repos.repos;',
    );
    expect(generateStatement(path, 'EXEC', 'sync', [])).toContain('EXEC github.repos.repos.sync;');
    expect(generateStatement(path, 'INSERT', 'create', [])).toContain('<field>');
    expect(generateStatement(path, 'UPDATE', 'touch', [])).toContain("<field> = '<value>'");
  });

  it('puts a note under the first line', () => {
    const sql = generateStatement(path, 'SELECT', 'list_public', [], '-- A note.');
    expect(sql.split('\n').slice(0, 3)).toEqual([
      '-- github.repos.repos, method list_public (SELECT).',
      '-- A note.',
      'SELECT',
    ]);
  });

  it('asks for placeholders to be filled in only when there are some', () => {
    const none = generateStatement(path, 'SELECT', 'list_public', [field('name', 'output')]);
    expect(none).not.toContain('placeholder');
    expect(none).toContain('SELECT\n  name\nFROM github.repos.repos;');
    expect(
      generateStatement(path, 'DELETE', 'delete', [field('repo', 'input_required')]),
    ).toContain('Fill in each <placeholder> before running.');
  });

  it('says so when it has no template for a verb', () => {
    expect(generateStatement(path, 'MERGE', 'merge', [])).toContain(
      'no template for the verb MERGE',
    );
  });

  it('quotes names that are not plain identifiers', () => {
    const sql = generateStatement(
      { provider: 'aws', service: 'ec2', resource: 'my-res' },
      'SELECT',
      'get',
      [field('odd-param', 'input_required'), field('some col', 'output')],
    );
    expect(sql).toContain('FROM aws.ec2."my-res"');
    expect(sql).toContain('"some col"');
    expect(sql).toContain('WHERE "odd-param" = \'<odd-param>\'');
  });
});
