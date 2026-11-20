import { describe, expect, it } from 'vitest';
import { equivalentSql } from './equivalentSql';

describe('equivalentSql', () => {
  it('gives the statement the engine builds for each discovery tool', () => {
    expect(equivalentSql('list_providers', {})).toBe('SHOW PROVIDERS;');
    expect(equivalentSql('list_services', { provider: 'github' })).toBe('SHOW SERVICES IN github;');
    expect(equivalentSql('list_resources', { provider: 'github', service: 'repos' })).toBe(
      'SHOW RESOURCES IN github.repos;',
    );
    expect(
      equivalentSql('list_methods', { provider: 'aws', service: 'ec2', resource: 'instances' }),
    ).toBe('SHOW METHODS IN aws.ec2.instances;');
  });

  it('covers the registry tools, with and without the optional argument', () => {
    expect(equivalentSql('list_registry', {})).toBe('REGISTRY LIST;');
    expect(equivalentSql('list_registry', { provider: 'aws' })).toBe('REGISTRY LIST aws;');
    expect(equivalentSql('pull_provider', { provider: 'github' })).toBe('REGISTRY PULL github;');
    expect(equivalentSql('pull_provider', { provider: 'github', version: 'v26.08.00448' })).toBe(
      'REGISTRY PULL github v26.08.00448;',
    );
  });

  it('ignores arguments that only shape the output', () => {
    expect(
      equivalentSql('list_services', { provider: 'aws', format: 'json', row_limit: 10000 }),
    ).toBe('SHOW SERVICES IN aws;');
    expect(equivalentSql('list_providers', { format: 'markdown' })).toBe('SHOW PROVIDERS;');
  });

  it('gives nothing when an argument it does not know could change the statement', () => {
    expect(equivalentSql('list_services', { provider: 'aws', like: 'ec%' })).toBeNull();
    expect(equivalentSql('list_providers', { filter: 'git' })).toBeNull();
  });

  it('gives nothing when a required name is missing', () => {
    expect(equivalentSql('list_services', {})).toBeNull();
    expect(equivalentSql('list_resources', { provider: 'github' })).toBeNull();
    expect(equivalentSql('list_methods', { provider: 'aws', service: 'ec2' })).toBeNull();
    expect(equivalentSql('pull_provider', {})).toBeNull();
  });

  it('never builds a statement from a name that is not a plain identifier', () => {
    expect(equivalentSql('list_services', { provider: 'aws; DROP' })).toBeNull();
    expect(equivalentSql('list_services', { provider: "x' OR '1'='1" })).toBeNull();
    expect(equivalentSql('list_resources', { provider: 'aws', service: 'ec2.x' })).toBeNull();
    expect(equivalentSql('pull_provider', { provider: 'github', version: 'v1; x' })).toBeNull();
    expect(equivalentSql('list_services', { provider: 42 })).toBeNull();
  });

  it('has nothing for tools with no statement form, or that carry their own SQL', () => {
    for (const tool of [
      'server_info',
      'reload_credentials',
      'query_library_search',
      'query_library_get',
      'describe_method',
      'run_select_query',
      'subagent',
      'made_up',
    ]) {
      expect(equivalentSql(tool, { provider: 'aws' })).toBeNull();
    }
  });

  it('copes with arguments that are not an object', () => {
    expect(equivalentSql('list_providers', null)).toBe('SHOW PROVIDERS;');
    expect(equivalentSql('list_providers', 'text')).toBe('SHOW PROVIDERS;');
    expect(equivalentSql('list_services', ['aws'])).toBeNull();
  });
});
