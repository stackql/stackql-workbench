import { useId, useState } from 'react';
import {
  host,
  toHostError,
  type AgentConfig,
  type BackendKind,
  type BackendOption,
} from '../../host';

const LABELS: Record<BackendKind, string> = {
  gemini: 'Gemini (API key)',
  anthropic: 'Anthropic (API key)',
  openai_compatible: 'OpenAI-compatible (API key or local server)',
};

const NOTES: Record<BackendKind, string> = {
  gemini:
    'Uses the Gemini API with a key from Google AI Studio. The default model is available on the free tier.',
  anthropic:
    'Uses the Anthropic API. With models that support it, a request the model declines is retried once on a fallback model chosen by Anthropic.',
  openai_compatible:
    'Uses the Chat Completions format, which local inference servers also speak. Set the address of your server, for example http://127.0.0.1:11434/v1, and the model it serves. Some of the newest hosted models take tool calls only through a different API and will not work here.',
};

interface ChatSettingsProps {
  config: AgentConfig;
  onChanged: (config: AgentConfig) => void;
}

/**
 * Which model the chat uses. The key goes to the OS keychain when saved and
 * is never shown again. With no backend chosen the chat pane stays hidden.
 */
export function ChatSettings({ config, onChanged }: ChatSettingsProps) {
  const [kind, setKind] = useState<BackendKind | ''>(config.inference?.kind ?? '');
  const [model, setModel] = useState(config.inference?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(config.inference?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const kindId = useId();
  const modelId = useId();
  const urlId = useId();
  const keyId = useId();

  const option: BackendOption | undefined = config.backends.find((b) => b.kind === kind);
  const sameBackend = config.inference?.kind === kind;
  const keyStored = sameBackend && config.hasKey;
  const needsKey =
    option !== undefined && !option.keyOptional && !keyStored && apiKey.trim() === '';
  const needsModel = option !== undefined && option.defaultModel === '' && model.trim() === '';

  const finish = (work: Promise<AgentConfig>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    work.then(
      (next) => {
        onChanged(next);
        setApiKey('');
        setSaved(true);
        setBusy(false);
      },
      (reason: unknown) => {
        setError(toHostError(reason).message);
        setBusy(false);
      },
    );
  };

  const save = () => {
    if (kind === '') {
      return;
    }
    finish(
      host.agent.saveConfig(
        { kind, model: model.trim(), baseUrl: baseUrl.trim() || null },
        apiKey.trim() || null,
      ),
    );
  };

  const remove = () => {
    setKind('');
    setModel('');
    setBaseUrl('');
    finish(host.agent.clearConfig());
  };

  const input =
    'selectable h-7 w-full rounded border border-line bg-surface px-2 font-mono text-[12px]';

  return (
    <div className="mt-5 border-t border-line pt-3">
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
        Chat
      </h2>
      <p className="mb-2 text-ink-muted">
        Chat is optional. Without a backend the chat pane is hidden and everything else works as
        before.
      </p>

      {!config.keychainAvailable && (
        <p className="selectable mb-2 text-warn">
          The OS keychain could not be opened, so a key entered here is kept in memory and is gone
          when the app closes.
        </p>
      )}

      <label htmlFor={kindId} className="block font-semibold">
        Backend
      </label>
      <select
        id={kindId}
        className="mb-1 h-7 w-full rounded border border-line bg-surface px-1"
        value={kind}
        onChange={(event) => {
          setKind(event.target.value as BackendKind | '');
          setModel('');
          setBaseUrl('');
          setApiKey('');
          setSaved(false);
        }}
      >
        <option value="">None</option>
        {config.backends.map((b) => (
          <option key={b.kind} value={b.kind}>
            {LABELS[b.kind]}
          </option>
        ))}
      </select>

      {option && kind !== '' && (
        <>
          <p className="mb-2 text-ink-muted">{NOTES[kind]}</p>

          <label htmlFor={modelId} className="block font-semibold">
            Model
          </label>
          <input
            id={modelId}
            type="text"
            spellCheck={false}
            className={`${input} mb-2`}
            placeholder={option.defaultModel || 'The model your server provides'}
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
            }}
          />

          <label htmlFor={urlId} className="block font-semibold">
            Address
          </label>
          <input
            id={urlId}
            type="text"
            spellCheck={false}
            className={`${input} mb-2`}
            placeholder={option.defaultBaseUrl}
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
            }}
          />

          <label htmlFor={keyId} className="block font-semibold">
            API key
          </label>
          <p className="mb-1 text-ink-muted">
            Stored in the operating system keychain, not in a settings file. It is never shown again
            and the model never sees it.
          </p>
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={input}
            placeholder={
              keyStored
                ? 'A key is stored. Enter a new one to replace it.'
                : option.keyOptional
                  ? 'Optional for a local server'
                  : 'Paste your API key'
            }
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
            }}
          />
        </>
      )}

      {error && <p className="selectable mt-2 text-danger">{error}</p>}

      <div className="mt-3 flex items-center justify-end gap-2">
        {saved && !error && <span className="mr-auto text-ok">Saved.</span>}
        {config.inference && (
          <button
            type="button"
            className="h-7 rounded border border-line bg-surface px-3 hover:bg-surface-sunken disabled:opacity-50"
            disabled={busy}
            onClick={remove}
          >
            Remove chat backend
          </button>
        )}
        <button
          type="button"
          className="h-7 rounded bg-brand px-3 text-on-brand hover:bg-brand-dark disabled:opacity-50"
          disabled={busy || kind === '' || needsKey || needsModel}
          title={
            needsKey ? 'Enter an API key first.' : needsModel ? 'Enter the model name first.' : ''
          }
          onClick={save}
        >
          {busy ? 'Saving' : 'Save chat settings'}
        </button>
      </div>
    </div>
  );
}
