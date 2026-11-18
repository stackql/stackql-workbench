import { describe, expect, it } from 'vitest';
import type { LibraryEntry } from '../host/types';
import {
  FALLBACK_SUGGESTIONS,
  METADATA_SUGGESTION,
  chatSuggestions,
  editorText,
  filterEntries,
  groupEntries,
  librarySuggestions,
  missingProviders,
  placeholders,
  usable,
  entryUseCase,
} from './library';

const entry = (id: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  title: id,
  description: '',
  providers: [id.split('/')[0] ?? ''],
  services: [],
  tags: [],
  keywords: [],
  intentKeywords: [],
  mutation: false,
  verb: 'select',
  status: 'stable',
  requiredParams: [],
  ...over,
});

const repos = entry('github/repos/org-repos-list', {
  title: 'GitHub repositories in an organization',
  description: 'Lists all repositories in a GitHub organization.',
  tags: ['github', 'repos', 'inventory'],
  keywords: ['repo list', 'stale repos'],
  intentKeywords: ['list repos in my github org'],
  requiredParams: ['org'],
});
const buckets = entry('aws/s3/buckets-list', {
  title: 'S3 buckets',
  tags: ['aws', 's3', 'storage', 'inventory'],
  intentKeywords: ['list my s3 buckets'],
});
const mfa = entry('aws/iam/users-console-no-mfa', {
  title: 'Console users without MFA',
  tags: ['aws', 'iam', 'security', 'cspm', 'mfa'],
  intentKeywords: ['which iam users have no mfa'],
});
const create = entry('aws/ec2/instance-create', {
  title: 'Create an instance',
  providers: ['awscc'],
  tags: ['aws', 'ec2', 'compute', 'provisioning', 'mutation'],
  mutation: true,
  verb: 'mutation',
  status: 'draft',
  intentKeywords: ['launch an ec2 instance'],
});
const trend = entry('github/repos/commit-activity-trend', {
  title: 'Commit activity',
  tags: ['github', 'repos', 'analytics', 'activity'],
  intentKeywords: ['how active is this repository'],
  requiredParams: ['owner', 'repo'],
});
const stars = entry('github/activity/repo-stargazers', {
  title: 'Stargazers',
  tags: ['github', 'activity', 'community', 'stars'],
});
const all = [repos, buckets, mfa, create, trend, stars];

describe('entryUseCase', () => {
  it('takes the first tag that names a use case', () => {
    expect(entryUseCase(repos).key).toBe('inventory');
    expect(entryUseCase(mfa).key).toBe('security');
    expect(entryUseCase(trend).key).toBe('analytics');
    expect(entryUseCase(create)).toEqual({ key: 'lifecycle', label: 'Lifecycle and operations' });
  });

  it('files an entry with no such tag under Other', () => {
    expect(entryUseCase(stars)).toEqual({ key: 'other', label: 'Other' });
  });
});

describe('usable', () => {
  it('needs every provider an entry names', () => {
    expect(usable(repos, new Set(['github']))).toBe(true);
    expect(usable(repos, new Set(['aws']))).toBe(false);
    expect(usable(entry('x/y/z', { providers: ['aws', 'github'] }), new Set(['aws']))).toBe(false);
    expect(usable(entry('x/y/z', { providers: [] }), new Set(['aws']))).toBe(false);
    expect(missingProviders(create, new Set(['aws']))).toEqual(['awscc']);
  });
});

describe('filterEntries', () => {
  const installed = new Set(['github']);

  it('keeps the entries for installed providers by default', () => {
    const shown = filterEntries(all, { search: '', installed, installedOnly: true });
    expect(shown.map((item) => item.id)).toEqual([
      'github/repos/org-repos-list',
      'github/repos/commit-activity-trend',
      'github/activity/repo-stargazers',
    ]);
  });

  it('shows everything when asked', () => {
    expect(filterEntries(all, { search: '', installed, installedOnly: false })).toHaveLength(6);
  });

  it('finds an entry by any of its words, whatever their case', () => {
    const find = (search: string) =>
      filterEntries(all, { search, installed, installedOnly: false }).map((item) => item.id);
    expect(find('STALE')).toEqual(['github/repos/org-repos-list']);
    expect(find('mfa')).toEqual(['aws/iam/users-console-no-mfa']);
    expect(find('aws inventory')).toEqual(['aws/s3/buckets-list']);
    expect(find('list repos in my github org')).toEqual(['github/repos/org-repos-list']);
    expect(find('nothing-like-this')).toEqual([]);
  });
});

describe('groupEntries', () => {
  it('lists the use cases in a fixed order, and each group by provider then title', () => {
    const groups = groupEntries(all);
    expect(groups.map((group) => group.useCase.label)).toEqual([
      'Security',
      'Analytics',
      'Inventory',
      'Lifecycle and operations',
      'Other',
    ]);
    const inventory = groups.find((group) => group.useCase.key === 'inventory');
    expect(inventory?.entries.map((item) => item.id)).toEqual([
      'aws/s3/buckets-list',
      'github/repos/org-repos-list',
    ]);
  });

  it('has no group for a use case with no entries', () => {
    expect(groupEntries([])).toEqual([]);
    expect(groupEntries([stars]).map((group) => group.useCase.key)).toEqual(['other']);
  });
});

describe('placeholders', () => {
  it('lists each name once, in order', () => {
    expect(
      placeholders(
        "SELECT name FROM github.repos.repos WHERE org = '{{org}}' AND type = '{{ repo_type }}' AND x = '{{org}}'",
      ),
    ).toEqual(['org', 'repo_type']);
    expect(placeholders('SELECT 1')).toEqual([]);
  });
});

describe('editorText', () => {
  it('says where the statement came from and what to fill in', () => {
    expect(
      editorText(repos, "SELECT name\nFROM github.repos.repos\nWHERE org = '{{org}}';\n"),
    ).toBe(
      [
        '-- GitHub repositories in an organization (query library: github/repos/org-repos-list)',
        '-- Replace each {{name}} before running: org.',
        'SELECT name',
        'FROM github.repos.repos',
        "WHERE org = '{{org}}';",
        '',
      ].join('\n'),
    );
  });

  it('leaves the second line out when nothing needs filling in', () => {
    expect(editorText(buckets, 'SELECT name FROM aws.s3.buckets;').split('\n')).toEqual([
      '-- S3 buckets (query library: aws/s3/buckets-list)',
      'SELECT name FROM aws.s3.buckets;',
      '',
    ]);
  });
});

describe('librarySuggestions', () => {
  it('offers stable, read-only entries for installed providers', () => {
    expect(librarySuggestions(all, new Set(['github']), 2)).toEqual([
      'List repos in my github org',
      'How active is this repository',
    ]);
  });

  it('puts entries that need nothing filled in first, and varies the provider', () => {
    expect(librarySuggestions(all, new Set(['github', 'aws', 'awscc']), 2)).toEqual([
      'List my s3 buckets',
      'List repos in my github org',
    ]);
  });

  it('never offers a draft, a mutation or an entry with nothing to ask', () => {
    const offered = librarySuggestions(all, new Set(['github', 'aws', 'awscc']), 10);
    expect(offered).not.toContain('Launch an ec2 instance');
    expect(offered).toHaveLength(4);
  });
});

describe('chatSuggestions', () => {
  it('keeps one question about metadata and takes the rest from the library', () => {
    expect(chatSuggestions(all, new Set(['github']))).toEqual([
      METADATA_SUGGESTION,
      'List repos in my github org',
      'How active is this repository',
    ]);
  });

  it('falls back when the library has nothing for what is installed', () => {
    expect(chatSuggestions(all, new Set(['homebrew']))).toEqual(FALLBACK_SUGGESTIONS);
    expect(chatSuggestions([], new Set(['github']))).toEqual(FALLBACK_SUGGESTIONS);
  });
});
