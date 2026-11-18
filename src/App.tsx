import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { host } from './host';
import { copyText } from './host/clipboard';
import { chatTitle, type ToolItem } from './lib/chat';
import { execCommand } from './lib/cli';
import { EMPTY_CATALOG, sampleStatement, type Catalog } from './lib/completion';
import { commandForKey, type CommandId } from './lib/menu';
import { agentRun, type RunState } from './lib/results';
import { ActivityPane } from './panes/activity/ActivityPane';
import { ChatPane } from './panes/chat/ChatPane';
import { Editor } from './panes/editor/Editor';
import { HistoryList } from './panes/editor/HistoryList';
import { TabStrip } from './panes/editor/TabStrip';
import { Explorer, type ExplorerHandle } from './panes/explorer/Explorer';
import { Results } from './panes/results/Results';
import { ChatSettings } from './panes/settings/ChatSettings';
import { SettingsDialog } from './panes/settings/SettingsDialog';
import { MenuBar } from './panes/shell/MenuBar';
import { SideNav, type View } from './panes/shell/SideNav';
import { EngineBanner } from './panes/statusbar/EngineBanner';
import { StatusBar } from './panes/statusbar/StatusBar';
import { useAgent, type AgentResult } from './state/useAgent';
import { useEngineStatus } from './state/useEngineStatus';
import { useQueryRun } from './state/useQueryRun';
import { useTabs } from './state/useTabs';
import { IconButton, ICON_BUTTON_CLASS } from './ui/IconButton';
import { Check, History, Play, Terminal, Warning } from './ui/icons';
import { Popover } from './ui/Popover';
import { Splitter } from './ui/Splitter';

const WELCOME_TEXT = `-- Ctrl+Enter (Cmd+Enter on macOS) runs the selection, or everything when nothing is selected.

SHOW PROVIDERS;

-- See what the registry offers, then install a provider:
-- REGISTRY LIST;
-- REGISTRY PULL github;
`;

const IS_MAC = /Mac/i.test(navigator.userAgent);
const RUN_SHORTCUT = IS_MAC ? 'Cmd+Enter' : 'Ctrl+Enter';
const JUMP_SHORTCUT = IS_MAC ? 'Cmd+P' : 'Ctrl+P';
const EXPLORER_WIDTH_KEY = 'workbench.explorer.width';
const EXPLORER_WIDTH = { min: 160, max: 640, initial: 300 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function savedExplorerWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(EXPLORER_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0
      ? clamp(saved, EXPLORER_WIDTH.min, EXPLORER_WIDTH.max)
      : EXPLORER_WIDTH.initial;
  } catch {
    return EXPLORER_WIDTH.initial;
  }
}

/** Editing commands the webview carries out on whatever has the cursor. */
function editInPlace(action: 'undo' | 'redo' | 'cut' | 'copy' | 'selectAll') {
  // There is no replacement for this call that acts on the focused field.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  document.execCommand(action);
}

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
  const tabs = useTabs(WELCOME_TEXT);

  // Chat is where the app opens. The explorer and activity are a click away.
  const [view, setView] = useState<View>('chat');
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(savedExplorerWidth);
  const explorer = useRef<ExplorerHandle>(null);
  const [editorHeight, setEditorHeight] = useState(240);
  // Which part of settings is open, if any.
  const [settings, setSettings] = useState<'engine' | 'model' | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [explorerToken, setExplorerToken] = useState(0);
  // A result the assistant produced, shown in the grid until the operator runs something.
  const [agentResult, setAgentResult] = useState<RunState | null>(null);
  const [runsEnded, setRunsEnded] = useState(0);
  // What the explorer has loaded. The editor completes names from it.
  const catalog = useRef<Catalog>(EMPTY_CATALOG);
  const [providers, setProviders] = useState<string[]>([]);
  const [cliCopy, setCliCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

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
  const engineBusy = restarting || status.state === 'starting';
  const running = query.state.running;
  const { run: runQuery, stopWaiting } = query;
  const { config: agentConfig, send: agentSend, reset: agentReset } = agent;
  const modelReady = agentConfig?.inference != null;

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

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth));
    } catch {
      // The width is a convenience.
    }
  }, [explorerWidth]);

  const restart = useCallback(() => {
    setRestarting(true);
    void host
      .engineRestart()
      .catch(() => undefined)
      .finally(() => {
        setRestarting(false);
      });
  }, []);

  const { open: openTab, active: activeEditor } = tabs;

  // A statement from the assistant, the activity list or the explorer opens
  // in a tab of its own. Nothing runs until the operator runs it.
  const openInEditor = useCallback(
    (sql: string) => {
      const statement = sql.trim();
      setView('explorer');
      openTab(`${statement}${statement.endsWith(';') ? '' : ';'}\n`);
    },
    [openTab],
  );

  const getCatalog = useCallback(() => catalog.current, []);
  const keepCatalog = useCallback((next: Catalog) => {
    catalog.current = next;
    setProviders((current) =>
      current.length === next.providers.length &&
      current.every((name, index) => name === next.providers[index])
        ? current
        : next.providers,
    );
  }, []);
  const sample = useMemo(() => sampleStatement(providers), [providers]);

  // A stackql exec command for what Run would run, for the operator's shell.
  const copyAsCli = useCallback(() => {
    const sql = activeEditor()?.runText() ?? '';
    const binary = status.location;
    if (sql.trim() === '' || binary === null) {
      return;
    }
    void host
      .settingsGet()
      .then(
        (view) => view.settings.envFile,
        () => null,
      )
      .then((envFile) =>
        copyText(
          execCommand(IS_MAC ? 'posix' : 'powershell', {
            binary,
            approot: status.dataFolder,
            envFile,
            sql,
          }),
        ),
      )
      .then((ok) => {
        setCliCopy(ok ? 'copied' : 'failed');
        window.setTimeout(
          () => {
            setCliCopy('idle');
          },
          ok ? 1200 : 4000,
        );
      });
  }, [activeEditor, status.location, status.dataFolder]);

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
      setView('explorer');
    }
  }, []);

  // A message cannot go anywhere without a model. Open the place to set
  // one up, and keep what was typed.
  const sendChat = useCallback(
    (text: string) => {
      if (!modelReady) {
        setSettings('model');
        return false;
      }
      agentSend(text);
      return true;
    },
    [modelReady, agentSend],
  );

  const newChat = useCallback(() => {
    agentReset();
    setView('chat');
  }, [agentReset]);

  const runCommand = useCallback(
    (id: CommandId) => {
      switch (id) {
        case 'newChat':
          newChat();
          break;
        case 'newTab':
          setView('explorer');
          openTab();
          break;
        case 'showChat':
          setView('chat');
          break;
        case 'showExplorer':
          setView('explorer');
          break;
        case 'showActivity':
          setView('activity');
          break;
        case 'toggleSidebar':
          setNavCollapsed((collapsed) => !collapsed);
          break;
        case 'openSettings':
          setSettings('engine');
          break;
        case 'openModelSettings':
          setSettings('model');
          break;
        case 'restartEngine':
          restart();
          break;
        case 'refreshExplorer':
          setExplorerToken((token) => token + 1);
          setView('explorer');
          break;
        case 'goToResource':
          setView('explorer');
          explorer.current?.jump();
          break;
        case 'exit':
          void host.closeWindow().catch(() => undefined);
          break;
        case 'undo':
        case 'redo':
          // The editor keeps its own history, which the webview's does not see.
          if (activeEditor()?.hasFocus()) {
            activeEditor()?.[id]();
          } else {
            editInPlace(id);
          }
          break;
        case 'cut':
        case 'copy':
        case 'selectAll':
          editInPlace(id);
          break;
      }
    },
    [newChat, restart, openTab, activeEditor],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const id = commandForKey(event, IS_MAC);
      if (id !== null) {
        event.preventDefault();
        runCommand(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [runCommand]);

  const disabledCommands = useMemo(
    () => new Set<CommandId>(engineBusy ? ['restartEngine'] : []),
    [engineBusy],
  );

  return (
    <div className="flex h-full flex-col bg-surface-alt">
      <MenuBar isMac={IS_MAC} onCommand={runCommand} disabled={disabledCommands} />
      <EngineBanner
        status={status}
        onRetry={restart}
        onOpenSettings={() => {
          setSettings('engine');
        }}
      />

      <div className="flex min-h-0 flex-1">
        <SideNav
          view={view}
          collapsed={navCollapsed}
          chatTitle={chatTitle(agent.chat)}
          chatBusy={agent.chat.busy}
          onToggle={() => {
            setNavCollapsed((collapsed) => !collapsed);
          }}
          onNewChat={newChat}
          onView={setView}
          onSettings={() => {
            setSettings('engine');
          }}
        />

        {/* Every view stays mounted, so the editor keeps its text and its
            history and a running turn keeps its place while another view
            is on screen. */}
        <main className="m-2 min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-surface">
          <div className={view === 'chat' ? 'h-full' : 'hidden'} data-view="chat">
            <ChatPane
              config={agentConfig}
              chat={agent.chat}
              engineRunning={engineRunning}
              onSend={sendChat}
              onStop={agent.stop}
              onReset={newChat}
              onAnswer={agent.answer}
              onSafetyMode={agent.setSafetyMode}
              onOpenInEditor={openInEditor}
              onShowTable={showTable}
              onOpenModelSettings={() => {
                setSettings('model');
              }}
            />
          </div>

          <div className={view === 'explorer' ? 'flex h-full' : 'hidden'} data-view="explorer">
            <div className="shrink-0" style={{ width: explorerWidth }}>
              <Explorer
                ref={explorer}
                engineRunning={engineRunning}
                canRun={engineRunning && !running}
                refreshToken={explorerToken}
                jumpShortcut={JUMP_SHORTCUT}
                onInsert={(text) => activeEditor()?.insert(text)}
                onOpenStatement={openTab}
                onRunStatement={(sql, inTab) => {
                  if (inTab) {
                    openTab(`${sql}\n`);
                  }
                  run(sql);
                }}
                onCatalog={keepCatalog}
              />
            </div>
            <Splitter
              orientation="vertical"
              label="Resize explorer"
              onResize={(delta) => {
                setExplorerWidth((width) =>
                  clamp(width + delta, EXPLORER_WIDTH.min, EXPLORER_WIDTH.max),
                );
              }}
            />

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-alt pl-2">
                <button
                  type="button"
                  className="flex h-6 shrink-0 items-center gap-1 rounded bg-brand px-2 font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
                  disabled={!engineRunning || running}
                  title={`Run the selection, or everything when nothing is selected (${RUN_SHORTCUT})`}
                  onClick={() => {
                    run(activeEditor()?.runText() ?? '');
                  }}
                >
                  <Play />
                  Run
                </button>
                <TabStrip
                  tabs={tabs.tabs}
                  activeId={tabs.activeId}
                  onActivate={tabs.activate}
                  onClose={tabs.close}
                  onNew={() => {
                    openTab();
                  }}
                />
                {!engineRunning && (
                  <span className="shrink-0 text-ink-muted">
                    Statements can run once the engine is up.
                  </span>
                )}
                <span className="flex shrink-0 items-center gap-0.5 pr-1">
                  <Popover
                    label="Statement history"
                    align="end"
                    trigger={<History />}
                    triggerClassName={ICON_BUTTON_CLASS}
                  >
                    {(close) => (
                      <HistoryList
                        canRun={engineRunning && !running}
                        onOpen={(sql) => {
                          close();
                          openInEditor(sql);
                        }}
                        onRun={(sql) => {
                          close();
                          openInEditor(sql);
                          run(sql);
                        }}
                      />
                    )}
                  </Popover>
                  <IconButton
                    label={
                      cliCopy === 'failed'
                        ? 'Could not copy to the clipboard'
                        : 'Copy as CLI: a stackql exec command for this statement'
                    }
                    disabled={status.location === null}
                    onClick={copyAsCli}
                  >
                    {cliCopy === 'copied' ? (
                      <Check className="text-ok" />
                    ) : cliCopy === 'failed' ? (
                      <Warning className="text-warn" />
                    ) : (
                      <Terminal />
                    )}
                  </IconButton>
                </span>
              </div>

              {/* One editor per tab, all mounted, so each keeps its own
                  history and cursor while another is in front. */}
              <div className="shrink-0" style={{ height: editorHeight }}>
                {tabs.tabs.map((tab) => (
                  <div
                    key={tab.id}
                    role="tabpanel"
                    className={tab.id === tabs.activeId ? 'h-full' : 'hidden'}
                  >
                    <Editor
                      ref={(handle) => {
                        tabs.register(tab.id, handle);
                      }}
                      initialText={tabs.initialText(tab.id)}
                      catalog={getCatalog}
                      sample={sample}
                      onRun={run}
                      onChange={(text) => {
                        tabs.changed(tab.id, text);
                      }}
                    />
                  </div>
                ))}
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
          </div>

          <div className={view === 'activity' ? 'h-full' : 'hidden'} data-view="activity">
            <ActivityPane
              refreshToken={runsEnded + agent.turnsEnded}
              onOpenInEditor={openInEditor}
            />
          </div>
        </main>
      </div>

      <StatusBar status={status} restarting={restarting} onRestart={restart} />

      {settings !== null && (
        <SettingsDialog
          status={status}
          section={settings}
          onClose={() => {
            setSettings(null);
          }}
        >
          {agentConfig && (
            <ChatSettings
              config={agentConfig}
              onChanged={(next) => {
                agent.setConfig(next);
                // Opened to set a model up, and now there is one: back to
                // the conversation, where the message is still waiting.
                if (settings === 'model' && next.inference) {
                  setSettings(null);
                }
              }}
            />
          )}
        </SettingsDialog>
      )}
    </div>
  );
}
