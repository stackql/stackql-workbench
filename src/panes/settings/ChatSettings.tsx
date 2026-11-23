import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  host,
  toHostError,
  type AgentConfig,
  type BackendKind,
  type BackendOption,
  type DelegateInfo,
  type ModelOption,
} from '../../host';
import { canListModels, listsOnOpen, modelLabel, saveBlocker } from '../../lib/models';
import { PathInput } from './PathInput';

const LABELS: Record<BackendKind, string> = {
  github_copilot: 'GitHub Copilot (the Copilot CLI and its sign-in)',
  gemini: 'Gemini (API key)',
  anthropic: 'Anthropic (API key)',
  openai_compatible: 'OpenAI-compatible (API key or local server)',
};

const NOTES: Record<BackendKind, string> = {
  github_copilot:
    'Uses the GitHub Copilot CLI installed on this machine, with the sign-in it already has. This app never sees that sign-in, and requests count against your Copilot plan. The CLI is given the engine tools and nothing else: no shell and no files. It cannot show the engine approval prompt, so a statement that needs approval is refused instead of asked about.',
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
 * Which model the chat uses. A key goes to the OS keychain when saved and
 * is never shown again. With no backend chosen, sending a message brings
 * the operator here.
 */
export function ChatSettings({ config, onChanged }: ChatSettingsProps) {
  const [kind, setKind] = useState<BackendKind | ''>(config.inference?.kind ?? '');
  const [model, setModel] = useState(config.inference?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(config.inference?.baseUrl ?? '');
  const [program, setProgram] = useState(config.inference?.program ?? '');
  const [subagents, setSubagents] = useState(config.inference?.subagents ?? false);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // What the agent said about itself, once asked.
  const [info, setInfo] = useState<DelegateInfo | null>(null);
  const [asking, setAsking] = useState(false);
  // The models an API key backend's provider listed, once asked.
  const [initial] = useState(() => {
    const opening = config.backends.find((b) => b.kind === config.inference?.kind);
    const url = config.inference?.baseUrl ?? '';
    return { option: opening, baseUrl: url, list: listsOnOpen(opening, url) };
  });
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [listing, setListing] = useState(initial.list);
  const [listError, setListError] = useState<string | null>(null);
  // Only the answer to the latest request is used, so an answer for a
  // backend the operator has moved away from is dropped.
  const latest = useRef(0);
  const kindId = useId();
  const modelId = useId();
  const urlId = useId();
  const keyId = useId();
  const programId = useId();

  const option: BackendOption | undefined = config.backends.find((b) => b.kind === kind);
  const delegated = option?.delegated ?? false;
  const keyStored = option?.keyStored ?? false;
  const blocker = saveBlocker(option, model, apiKey);

  const fetchModels = useCallback((forKind: BackendKind, url: string, key: string) => {
    latest.current += 1;
    const request = latest.current;
    host.agent.listModels(forKind, url.trim() || null, key.trim() || null).then(
      (list) => {
        if (latest.current === request) {
          setModels(list);
          setListError(null);
          setListing(false);
        }
      },
      (reason: unknown) => {
        if (latest.current === request) {
          setModels(null);
          setListError(toHostError(reason).message);
          setListing(false);
        }
      },
    );
  }, []);

  // Opened on a backend whose provider can be asked straight away.
  useEffect(() => {
    if (initial.list && initial.option) {
      fetchModels(initial.option.kind, initial.baseUrl, '');
    }
  }, [initial, fetchModels]);

  const startListing = (forKind: BackendKind, url: string, key: string) => {
    setListing(true);
    setListError(null);
    fetchModels(forKind, url, key);
  };

  // Drops a list, and any answer still on its way, when what it was asked
  // for has changed.
  const forgetModels = () => {
    latest.current += 1;
    setModels(null);
    setListing(false);
    setListError(null);
  };

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
        {
          kind,
          model: model.trim(),
          baseUrl: delegated ? null : baseUrl.trim() || null,
          program: delegated ? program.trim() || null : null,
          subagents,
        },
        delegated ? null : apiKey.trim() || null,
      ),
    );
  };

  const remove = () => {
    setKind('');
    setModel('');
    setBaseUrl('');
    setProgram('');
    setInfo(null);
    forgetModels();
    finish(host.agent.clearConfig());
  };

  // Starts the agent and asks what it offers. No prompt is sent, so this
  // uses none of the operator's plan.
  const ask = () => {
    setAsking(true);
    setError(null);
    host.agent.delegateInfo(program.trim() || null).then(
      (answer) => {
        setInfo(answer);
        setAsking(false);
      },
      (reason: unknown) => {
        setInfo(null);
        setError(toHostError(reason).message);
        setAsking(false);
      },
    );
  };

  const input =
    'selectable h-7 w-full rounded border border-line bg-surface px-2 font-mono text-[12px]';
  const plain =
    'h-7 rounded border border-line bg-surface px-3 hover:bg-surface-sunken disabled:opacity-50';

  return (
    <div className="mt-5 border-t border-line pt-3">
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
        Model backend
      </h2>
      <p className="mb-2 text-ink-muted">
        Chat needs a model. The explorer and the query editor work without one.
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
          const next = event.target.value as BackendKind | '';
          setKind(next);
          setModel('');
          setBaseUrl('');
          setProgram('');
          setApiKey('');
          setInfo(null);
          setError(null);
          setSaved(false);
          forgetModels();
          const nextOption = config.backends.find((b) => b.kind === next);
          if (nextOption && listsOnOpen(nextOption, '')) {
            startListing(nextOption.kind, '', '');
          }
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

          {delegated ? (
            <>
              <label htmlFor={programId} className="block font-semibold">
                Copilot CLI location
              </label>
              <p className="mb-1 text-ink-muted">
                Optional. Leave empty to find copilot on PATH. If it is not signed in, run copilot
                login in a terminal first.
              </p>
              <div className="mb-2">
                <PathInput
                  id={programId}
                  purpose="agent"
                  label="the Copilot CLI"
                  placeholder="Found on PATH"
                  value={program}
                  onChange={(value) => {
                    setProgram(value);
                    setInfo(null);
                  }}
                />
              </div>

              <label htmlFor={modelId} className="block font-semibold">
                Model
              </label>
              <p className="mb-1 text-ink-muted">
                Leave empty to use the model the Copilot CLI is set to. Each model shows what one
                request costs against your plan.
              </p>
              <div className="mb-1 flex items-center gap-2">
                {info ? (
                  <select
                    id={modelId}
                    className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-1"
                    value={model}
                    onChange={(event) => {
                      setModel(event.target.value);
                    }}
                  >
                    <option value="">
                      {`The CLI's own choice${info.currentModel ? ` (now ${info.currentModel})` : ''}`}
                    </option>
                    {/* Keep a saved model the CLI no longer lists visible. */}
                    {model !== '' && !info.models.some((m) => m.id === model) && (
                      <option value={model}>{`${model} (not in the list)`}</option>
                    )}
                    {info.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.usage ? `${m.name} - ${m.usage}` : m.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={modelId}
                    type="text"
                    spellCheck={false}
                    className={`${input} min-w-0 flex-1`}
                    placeholder="The CLI's own choice"
                    value={model}
                    onChange={(event) => {
                      setModel(event.target.value);
                    }}
                  />
                )}
                <button
                  type="button"
                  className={`${plain} shrink-0`}
                  disabled={asking}
                  onClick={ask}
                >
                  {asking ? 'Asking the CLI' : info ? 'Ask again' : 'List models'}
                </button>
              </div>
              {info && (
                <p className="selectable text-[12px] text-ok">
                  GitHub Copilot CLI {info.version} answered and is signed in. {info.models.length}{' '}
                  models.
                </p>
              )}

              <label className="mt-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={subagents}
                  onChange={(event) => {
                    setSubagents(event.target.checked);
                  }}
                />
                <span>
                  <span className="font-semibold">
                    Split independent lookups across subagents (experimental)
                  </span>
                  <span className="block text-ink-muted">
                    For a request that spans several providers, services or resources, the agent may
                    hand each part to a subagent and run them at the same time. A subagent gets the
                    engine tools and nothing else, on the same engine and safety mode. In testing, a
                    small model also reached for subagents when it was stuck, which made a turn
                    slower and no better, so this is off unless you turn it on. A turn is stopped if
                    a subagent starts subagents of its own, or if more than 12 are started.
                  </span>
                </span>
              </label>
            </>
          ) : (
            <>
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
                  // Another server can offer other models.
                  forgetModels();
                }}
              />

              <label htmlFor={keyId} className="block font-semibold">
                API key
              </label>
              <p className="mb-1 text-ink-muted">
                Stored in the operating system keychain, not in a settings file. It is never shown
                again and the model never sees it.
              </p>
              <input
                id={keyId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                className={`${input} mb-2`}
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

              <label htmlFor={modelId} className="block font-semibold">
                Model
              </label>
              <p className="mb-1 text-ink-muted">
                {option.defaultModel
                  ? `Leave it on the default to use ${option.defaultModel}. List models asks the provider which models your key can use.`
                  : 'List models asks the server which models it offers.'}
              </p>
              <div className="mb-1 flex items-center gap-2">
                {models ? (
                  <select
                    id={modelId}
                    className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-1"
                    value={model}
                    onChange={(event) => {
                      setModel(event.target.value);
                    }}
                  >
                    <option value="">
                      {option.defaultModel ? `Default (${option.defaultModel})` : 'Choose a model'}
                    </option>
                    {/* Keep a saved model the provider does not list visible. */}
                    {model !== '' && !models.some((m) => m.id === model) && (
                      <option value={model}>{`${model} (not in the list)`}</option>
                    )}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {modelLabel(m)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={modelId}
                    type="text"
                    spellCheck={false}
                    className={`${input} min-w-0 flex-1`}
                    placeholder={option.defaultModel || 'The model your server provides'}
                    value={model}
                    onChange={(event) => {
                      setModel(event.target.value);
                    }}
                  />
                )}
                <button
                  type="button"
                  className={`${plain} shrink-0`}
                  disabled={listing || !canListModels(option, apiKey)}
                  title={canListModels(option, apiKey) ? '' : 'Enter an API key first.'}
                  onClick={() => {
                    startListing(option.kind, baseUrl, apiKey);
                  }}
                >
                  {listing ? 'Listing' : models ? 'List again' : 'List models'}
                </button>
              </div>
              {models && (
                <p className="selectable text-[12px] text-ink-muted">
                  {models.length === 1 ? '1 model listed.' : `${models.length} models listed.`}
                </p>
              )}
              {listError && (
                <p className="selectable text-[12px] break-words text-danger">{listError}</p>
              )}
            </>
          )}
        </>
      )}

      {error && (
        <p className="selectable mt-2 break-words whitespace-pre-wrap text-danger">{error}</p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        {saved && !error ? (
          <span className="mr-auto text-ok">Saved.</span>
        ) : (
          blocker && <span className="mr-auto text-[12px] text-ink-muted">{blocker}</span>
        )}
        {config.inference && (
          <button
            type="button"
            className={plain}
            disabled={busy}
            title="Removes the backend and the API key stored for it."
            onClick={remove}
          >
            Remove model backend
          </button>
        )}
        <button
          type="button"
          className="h-7 rounded bg-brand px-3 text-on-brand hover:bg-brand-dark disabled:opacity-50"
          disabled={busy || kind === '' || blocker !== null}
          onClick={save}
        >
          {busy ? 'Saving' : 'Save model backend'}
        </button>
      </div>
    </div>
  );
}
