// The settings controls, driven in the page: the reason a model backend
// cannot be saved yet, the model list from the provider, and Browse on a
// path. The host is replaced with stubs, so nothing reaches a provider or
// opens a dialog.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, BackendOption } from '../../host/types';

const listModels = vi.fn();
const pickPath = vi.fn();
const saveConfig = vi.fn();

vi.mock('../../host', () => ({
  host: {
    agent: {
      listModels: (...args: unknown[]) => listModels(...args) as unknown,
      saveConfig: (...args: unknown[]) => saveConfig(...args) as unknown,
      clearConfig: vi.fn(),
      delegateInfo: vi.fn(),
    },
    pickPath: (...args: unknown[]) => pickPath(...args) as unknown,
  },
  toHostError: (value: unknown) => ({
    kind: 'internal',
    message: value instanceof Error ? value.message : String(value),
  }),
}));

const { ChatSettings } = await import('./ChatSettings');
const { PathInput } = await import('./PathInput');

// React reads this to know the test drives updates with act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function backend(overrides: Partial<BackendOption>): BackendOption {
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

function config(overrides: Partial<AgentConfig>, geminiKey = false): AgentConfig {
  return {
    inference: null,
    safetyMode: 'safe',
    keychainAvailable: true,
    backends: [
      backend({ keyStored: geminiKey }),
      backend({
        kind: 'openai_compatible',
        defaultModel: '',
        defaultBaseUrl: 'https://api.openai.com/v1',
        keyOptional: true,
      }),
    ],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listModels.mockReset();
  pickPath.mockReset();
  saveConfig.mockReset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  );
  if (!found) {
    throw new Error(`no button ${name}`);
  }
  return found;
}

/** Sets a field the way typing does, so React sees the change. */
function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  );
}

describe('ChatSettings', () => {
  it('says why a backend cannot be saved, and saves once the key is there', () => {
    act(() => {
      root.render(<ChatSettings config={config({})} onChanged={vi.fn()} />);
    });
    const kind = container.querySelector('select');
    if (!kind) {
      throw new Error('no backend select');
    }
    act(() => {
      type(kind, 'gemini');
    });
    expect(container.textContent).toContain('Enter an API key to save.');
    expect(button('Save model backend').disabled).toBe(true);
    // Nothing to ask the provider with yet.
    expect(listModels).not.toHaveBeenCalled();
    expect(button('List models').disabled).toBe(true);

    const key = container.querySelector<HTMLInputElement>('input[type=password]');
    if (!key) {
      throw new Error('no key field');
    }
    act(() => {
      type(key, 'typed-key');
    });
    expect(container.textContent).not.toContain('Enter an API key to save.');
    expect(button('Save model backend').disabled).toBe(false);
    expect(button('List models').disabled).toBe(false);
  });

  it('asks for a model where a server has no default', () => {
    act(() => {
      root.render(<ChatSettings config={config({})} onChanged={vi.fn()} />);
    });
    const kind = container.querySelector('select');
    if (!kind) {
      throw new Error('no backend select');
    }
    act(() => {
      type(kind, 'openai_compatible');
    });
    expect(container.textContent).toContain('Choose a model to save.');
    expect(button('Save model backend').disabled).toBe(true);
  });

  it('lists the models straight away when a key is stored, and saves the one chosen', async () => {
    listModels.mockResolvedValue([
      { id: 'gemini-default', name: 'Gemini Default' },
      { id: 'gemini-small', name: 'Gemini Small' },
    ]);
    saveConfig.mockImplementation(() => new Promise(() => undefined));
    const opened = config(
      {
        inference: {
          kind: 'gemini',
          model: '',
          baseUrl: null,
          program: null,
          subagents: false,
        },
      },
      true,
    );
    await act(async () => {
      root.render(<ChatSettings config={opened} onChanged={vi.fn()} />);
      await Promise.resolve();
    });
    expect(listModels).toHaveBeenCalledWith('gemini', null, null);

    const models = [...container.querySelectorAll('select')].at(-1);
    if (!models) {
      throw new Error('no model select');
    }
    const options = [...models.options].map((o) => o.textContent);
    expect(options).toEqual([
      'Default (gemini-default)',
      'Gemini Default (gemini-default)',
      'Gemini Small (gemini-small)',
    ]);
    expect(container.textContent).toContain('2 models listed.');
    expect(button('Save model backend').disabled).toBe(false);

    act(() => {
      type(models, 'gemini-small');
    });
    act(() => {
      button('Save model backend').click();
    });
    expect(saveConfig).toHaveBeenCalledWith(
      { kind: 'gemini', model: 'gemini-small', baseUrl: null, program: null, subagents: false },
      null,
    );
  });

  it('shows what the provider said when the list cannot be read', async () => {
    listModels.mockRejectedValue(new Error('The inference provider rejected the API key.'));
    const opened = config(
      {
        inference: {
          kind: 'gemini',
          model: 'gemini-small',
          baseUrl: null,
          program: null,
          subagents: false,
        },
      },
      true,
    );
    await act(async () => {
      root.render(<ChatSettings config={opened} onChanged={vi.fn()} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('The inference provider rejected the API key.');
    // The model stays a field the operator can type in.
    const typed = [...container.querySelectorAll<HTMLInputElement>('input[type=text]')].map(
      (i) => i.value,
    );
    expect(typed).toContain('gemini-small');
  });
});

describe('PathInput', () => {
  it('opens the dialog where the path in use is, and fills in the choice', async () => {
    pickPath.mockResolvedValue('C:\\tools\\stackql.exe');
    const onChange = vi.fn();
    act(() => {
      root.render(
        <PathInput
          id="engine"
          purpose="engine"
          label="the stackql location"
          placeholder="Path"
          fallback={'C:\\Program Files\\StackQL\\stackql.exe'}
          value=""
          onChange={onChange}
        />,
      );
    });
    await act(async () => {
      button('Browse for the stackql location').click();
      await Promise.resolve();
    });
    expect(pickPath).toHaveBeenCalledWith('engine', 'C:\\Program Files\\StackQL\\stackql.exe');
    expect(onChange).toHaveBeenCalledWith('C:\\tools\\stackql.exe');
  });

  it('leaves the field alone when the dialog is dismissed', async () => {
    pickPath.mockResolvedValue(null);
    const onChange = vi.fn();
    act(() => {
      root.render(
        <PathInput
          id="data"
          purpose="dataFolder"
          label="the engine data folder"
          placeholder="Folder"
          value={'D:\\stackql-data'}
          onChange={onChange}
        />,
      );
    });
    await act(async () => {
      button('Browse for the engine data folder').click();
      await Promise.resolve();
    });
    // What the field holds wins over the fallback.
    expect(pickPath).toHaveBeenCalledWith('dataFolder', 'D:\\stackql-data');
    expect(onChange).not.toHaveBeenCalled();
  });
});
