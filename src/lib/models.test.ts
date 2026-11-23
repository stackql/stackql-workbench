import { describe, expect, it } from 'vitest';
import type { BackendOption } from '../host/types';
import { canListModels, listsOnOpen, modelLabel, saveBlocker } from './models';

function option(overrides: Partial<BackendOption>): BackendOption {
  return {
    kind: 'gemini',
    defaultModel: 'gemini-default',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    keyOptional: false,
    keyStored: false,
    delegated: false,
    ...overrides,
  };
}

const copilot = option({
  kind: 'github_copilot',
  defaultModel: '',
  defaultBaseUrl: '',
  keyOptional: true,
  delegated: true,
});
const compatible = option({
  kind: 'openai_compatible',
  defaultModel: '',
  defaultBaseUrl: 'https://api.openai.com/v1',
  keyOptional: true,
});

describe('modelLabel', () => {
  it('shows the provider name with the id, and the id alone when they match', () => {
    expect(modelLabel({ id: 'gemini-x', name: 'Gemini X' })).toBe('Gemini X (gemini-x)');
    expect(modelLabel({ id: 'llama3', name: 'llama3' })).toBe('llama3');
  });
});

describe('listsOnOpen', () => {
  it('asks a provider straight away only when it needs nothing more', () => {
    expect(listsOnOpen(option({ keyStored: true }), '')).toBe(true);
    expect(listsOnOpen(option({ keyStored: false }), '')).toBe(false);
    // A server of the operator's own, which needs no key.
    expect(listsOnOpen(compatible, 'http://127.0.0.1:11434/v1')).toBe(true);
    // The default address of a compatible backend is a hosted one that needs a key.
    expect(listsOnOpen(compatible, '  ')).toBe(false);
    expect(listsOnOpen(copilot, '')).toBe(false);
    expect(listsOnOpen(undefined, '')).toBe(false);
  });
});

describe('canListModels', () => {
  it('needs a key where the backend needs one, typed or stored', () => {
    expect(canListModels(option({}), '')).toBe(false);
    expect(canListModels(option({}), 'typed-key')).toBe(true);
    expect(canListModels(option({ keyStored: true }), '')).toBe(true);
    expect(canListModels(compatible, '')).toBe(true);
    expect(canListModels(copilot, '')).toBe(false);
  });
});

describe('saveBlocker', () => {
  it('says a key is missing when the backend needs one and none is stored', () => {
    expect(saveBlocker(option({}), 'gemini-x', '')).toBe('Enter an API key to save.');
    expect(saveBlocker(option({}), '', 'typed-key')).toBeNull();
    expect(saveBlocker(option({ keyStored: true }), '', '')).toBeNull();
  });

  it('says a model is missing only where there is no default', () => {
    expect(saveBlocker(compatible, '', '')).toBe('Choose a model to save.');
    expect(saveBlocker(compatible, '  ', '')).toBe('Choose a model to save.');
    expect(saveBlocker(compatible, 'local-model', '')).toBeNull();
  });

  it('never stops a delegated agent or an empty choice', () => {
    expect(saveBlocker(copilot, '', '')).toBeNull();
    expect(saveBlocker(undefined, '', '')).toBeNull();
  });
});
