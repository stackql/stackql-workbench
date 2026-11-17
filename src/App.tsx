import { useCallback, useRef, useState } from 'react';
import { host } from './host';
import type { ToolItem } from './lib/chat';
import { agentRun, type RunState } from './lib/results';
import { ActivityPane } from './panes/activity/ActivityPane';
import { ChatPane } from './panes/chat/ChatPane';
import { Editor, type EditorHandle } from './panes/editor/Editor';
import { Explorer } from './panes/explorer/Explorer';
import { Results } from './panes/results/Results';
import { ChatSettings } from './panes/settings/ChatSettings';
import { SettingsDialog } from './panes/settings/SettingsDialog';
import { EngineBanner } from './panes/statusbar/EngineBanner';
import { StatusBar } from './panes/statusbar/StatusBar';
import { useAgent, type AgentResult } from './state/useAgent';
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

type SidePane = 'chat' | 'activity';

function resultRun(result: {
  callId: string;
  tool: string;
  sql: string | null;
  table: AgentResult['table'];
  engineNotes: string[];
  elapsedMs: number;
}): RunState {
  return agentRun(
    `agent-${result.callId}`,
    result.sql ?? result.tool,
    result.table.columns,
    result.table.rows,
    result.elapsedMs,
    result.engineNotes,
  );
}

export function App() {
  const status = useEngineStatus();
  const query = useQueryRun();
  const editor = useRef<EditorHandle>(null);

  const [explorerWidth, setExplorerWidth] = useState(280);
  const [editorHeight, setEditorHeight] = useState(240);
  const [sideWidth, setSideWidth] = useState(420);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [explorerToken, setExplorerToken] = useState(0);
  const [initialText] = useState(savedEditorText);
  // Null means "follow the configuration": chat when it is set up.
  const [sidePaneChoice, setSidePaneChoice] = useState<SidePane | 'none' | null>(null);
  // A result the assistant produced, shown in the grid until the operator runs something.
  const [agentResult, setAgentResult] = useState<RunState | null>(null);
  const [runsEnded, setRunsEnded] = useState(0);

  const showAgentResult = useCallback((result: AgentResult) => {
    // Results with no columns have nothing to put in a grid.
    if (result.table.columns.length > 0) {
      setAgentResult(resultRun(result));
    }
    // Installing a provider changes what the explorer should show.
    if (result.tool === 'pull_provider') {
      setExplorerToken((token) => token + 1);
    }
  }, []);
  const agent = useAgent(showAgentResult);

  const engineRunning = status.state === 'running';
  const running = query.state.running;
  const { run: runQuery, stopWaiting } = query;
  const chatAvailable = agent.config?.inference != null;
  const sidePane: SidePane | null =
    sidePaneChoice === 'none'
      ? null
      : sidePaneChoice === 'chat' && !chatAvailable
        ? null
        : (sidePaneChoice ?? (chatAvailable ? 'chat' : null));

  const run = useCallback(
    (sql: string) => {
      if (running || sql.trim() === '') {
        return;
      }
      setAgentResult(null);
      void runQuery(sql).then((summary) => {
        setRunsEnded((count) => count + 1);
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

  // Statements from the assistant or from the activity list go into the
  // editor as text. Nothing runs until the operator runs it.
  const openInEditor = useCallback((sql: string) => {
    const statement = sql.trim();
    editor.current?.insert(`\n${statement}${statement.endsWith(';') ? '' : ';'}\n`);
  }, []);

  const showTable = useCallback((item: ToolItem) => {
    if (item.table) {
      setAgentResult(
        resultRun({
          callId: item.callId,
          tool: item.tool,
          sql: item.sql,
          table: item.table,
          engineNotes: item.engineNotes,
          elapsedMs: item.elapsedMs ?? 0,
        }),
      );
    }
  }, []);

  const toggleSidePane = useCallback(
    (pane: SidePane) => {
      setSidePaneChoice(sidePane === pane ? 'none' : pane);
    },
    [sidePane],
  );

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
            <Results run={agentResult ?? query.state} onStopWaiting={stopWaiting} />
          </div>
        </div>

        {sidePane !== null && (
          <>
            <Splitter
              orientation="vertical"
              label="Resize side pane"
              onResize={(delta) => {
                setSideWidth((width) => clamp(width - delta, 280, 900));
              }}
            />
            <div className="shrink-0" style={{ width: sideWidth }}>
              {sidePane === 'chat' && agent.config ? (
                <ChatPane
                  config={agent.config}
                  chat={agent.chat}
                  engineRunning={engineRunning}
                  onSend={agent.send}
                  onStop={agent.stop}
                  onReset={agent.reset}
                  onAnswer={agent.answer}
                  onSafetyMode={agent.setSafetyMode}
                  onOpenInEditor={openInEditor}
                  onShowTable={showTable}
                />
              ) : (
                <ActivityPane
                  refreshToken={runsEnded + agent.turnsEnded}
                  onOpenInEditor={openInEditor}
                />
              )}
            </div>
          </>
        )}
      </div>

      <StatusBar
        status={status}
        restarting={restarting}
        onRestart={restart}
        onOpenSettings={() => {
          setSettingsOpen(true);
        }}
        sidePane={sidePane}
        chatAvailable={chatAvailable}
        onToggleSidePane={toggleSidePane}
      />

      {settingsOpen && (
        <SettingsDialog
          status={status}
          onClose={() => {
            setSettingsOpen(false);
          }}
        >
          {agent.config && (
            <ChatSettings
              config={agent.config}
              onChanged={(next) => {
                agent.setConfig(next);
                // A newly configured chat should be visible.
                if (next.inference) {
                  setSidePaneChoice('chat');
                }
              }}
            />
          )}
        </SettingsDialog>
      )}
    </div>
  );
}
