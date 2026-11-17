import { useCallback, useRef, useState } from 'react';
import { host } from './host';
import { Editor, type EditorHandle } from './panes/editor/Editor';
import { Explorer } from './panes/explorer/Explorer';
import { Results } from './panes/results/Results';
import { SettingsDialog } from './panes/settings/SettingsDialog';
import { EngineBanner } from './panes/statusbar/EngineBanner';
import { StatusBar } from './panes/statusbar/StatusBar';
import { useEngineStatus } from './state/useEngineStatus';
import { useQueryRun } from './state/useQueryRun';
import { Play } from './ui/icons';
import { Splitter } from './ui/Splitter';

const EDITOR_TEXT_KEY = 'workbench.editor.text';

const WELCOME_TEXT = `-- Ctrl+Enter (Cmd+Enter on macOS) runs the selection, or everything when nothing is selected.

SHOW PROVIDERS;

-- See what the registry offers, then install a provider:
-- REGISTRY LIST;
-- REGISTRY PULL github;
`;

function savedEditorText(): string {
  try {
    return window.localStorage.getItem(EDITOR_TEXT_KEY) ?? WELCOME_TEXT;
  } catch {
    return WELCOME_TEXT;
  }
}

const IS_MAC = /Mac/i.test(navigator.userAgent);
const RUN_SHORTCUT = IS_MAC ? 'Cmd+Enter' : 'Ctrl+Enter';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function App() {
  const status = useEngineStatus();
  const query = useQueryRun();
  const editor = useRef<EditorHandle>(null);

  const [explorerWidth, setExplorerWidth] = useState(280);
  const [editorHeight, setEditorHeight] = useState(240);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [explorerToken, setExplorerToken] = useState(0);
  const [initialText] = useState(savedEditorText);

  const engineRunning = status.state === 'running';
  const running = query.state.running;
  const { run: runQuery, stopWaiting } = query;

  const run = useCallback(
    (sql: string) => {
      if (running || sql.trim() === '') {
        return;
      }
      void runQuery(sql).then((summary) => {
        // Installing a provider changes what the explorer should show.
        if (summary && summary.completed > 0 && /\bregistry\s+pull\b/i.test(sql)) {
          setExplorerToken((token) => token + 1);
        }
      });
    },
    [running, runQuery],
  );

  const restart = useCallback(() => {
    setRestarting(true);
    void host
      .engineRestart()
      .catch(() => undefined)
      .finally(() => {
        setRestarting(false);
      });
  }, []);

  const saveText = useCallback((text: string) => {
    try {
      window.localStorage.setItem(EDITOR_TEXT_KEY, text);
    } catch {
      // Storage is a convenience. Losing it is not worth interrupting anyone.
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      <EngineBanner
        status={status}
        onRetry={restart}
        onOpenSettings={() => {
          setSettingsOpen(true);
        }}
      />

      <div className="flex min-h-0 flex-1">
        <div className="shrink-0" style={{ width: explorerWidth }}>
          <Explorer
            engineRunning={engineRunning}
            refreshToken={explorerToken}
            onInsert={(text) => editor.current?.insert(text)}
          />
        </div>
        <Splitter
          orientation="vertical"
          label="Resize explorer"
          onResize={(delta) => {
            setExplorerWidth((width) => clamp(width + delta, 160, 640));
          }}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-alt px-2">
            <button
              type="button"
              className="flex h-6 items-center gap-1 rounded bg-brand px-2 font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
              disabled={!engineRunning || running}
              title={`Run the selection, or everything when nothing is selected (${RUN_SHORTCUT})`}
              onClick={() => {
                run(editor.current?.runText() ?? '');
              }}
            >
              <Play />
              Run
            </button>
            <span className="text-ink-muted">{RUN_SHORTCUT}</span>
            <span className="flex-1" />
            {!engineRunning && (
              <span className="text-ink-muted">Statements can run once the engine is up.</span>
            )}
          </div>

          <div className="shrink-0" style={{ height: editorHeight }}>
            <Editor ref={editor} initialText={initialText} onRun={run} onChange={saveText} />
          </div>
          <Splitter
            orientation="horizontal"
            label="Resize editor"
            onResize={(delta) => {
              setEditorHeight((height) => clamp(height + delta, 80, 1200));
            }}
          />
          <div className="min-h-0 flex-1">
            <Results run={query.state} onStopWaiting={stopWaiting} />
          </div>
        </div>
      </div>

      <StatusBar
        status={status}
        restarting={restarting}
        onRestart={restart}
        onOpenSettings={() => {
          setSettingsOpen(true);
        }}
      />

      {settingsOpen && (
        <SettingsDialog
          status={status}
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}
