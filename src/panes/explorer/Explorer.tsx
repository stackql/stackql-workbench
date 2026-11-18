import {
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { host, toHostError, type ProviderIcon } from '../../host';
import { copyText } from '../../host/clipboard';
import { EMPTY_CATALOG, catalogFrom, type Catalog } from '../../lib/completion';
import {
  compareVersions,
  filterRows,
  hoverText,
  loadChildren,
  parseJump,
  qualifiedName,
  unopenedServices,
  type ChildState,
  type NodeKind,
  type TreeNode,
  type VisibleRow,
} from '../../lib/explorerTree';
import {
  generateStatement,
  ident,
  otherSelectMethods,
  pickSelectMethod,
  tableName,
} from '../../lib/generateSql';
import { ContextMenu, type MenuItem } from '../../ui/ContextMenu';
import { IconButton } from '../../ui/IconButton';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Close,
  Copy,
  GoTo,
  More,
  Plus,
  Refresh,
  Search,
  Spinner,
} from '../../ui/icons';
import { AddProviderDialog } from './AddProviderDialog';
import { JumpBox } from './JumpBox';

const KIND_BADGE: Record<NodeKind, { text: string; className: string; label: string }> = {
  provider: { text: 'P', className: 'bg-brand text-on-brand', label: 'Provider' },
  service: { text: 'S', className: 'bg-brand-light text-on-brand', label: 'Service' },
  resource: { text: 'R', className: 'border border-accent text-accent', label: 'Resource' },
  fieldsGroup: {
    text: 'F',
    className: 'text-ink-muted',
    label: 'Fields: the columns of the resource',
  },
  methodsGroup: {
    text: 'M',
    className: 'text-ink-muted',
    label: 'Methods: what can be done to the resource',
  },
  field: { text: '', className: '', label: 'Field' },
  method: { text: 'fn', className: 'text-ink-muted', label: 'Method' },
  inputsGroup: {
    text: 'in',
    className: 'text-ink-muted',
    label: 'Inputs: what a statement supplies',
  },
  outputsGroup: {
    text: 'out',
    className: 'text-ink-muted',
    label: 'Outputs: the columns a statement can select',
  },
  param: { text: '', className: '', label: 'Parameter' },
};

/** Under a filter, more rows than this are not drawn. */
const MAX_FILTERED_ROWS = 400;
/** How many services are read at once when a filter is taken to every service. */
const BULK_WORKERS = 4;

export interface ExplorerHandle {
  /** Opens the box for going straight to a resource. */
  jump: () => void;
  /** Opens the list of what the registry offers. */
  addProvider: () => void;
}

interface ExplorerProps {
  ref?: Ref<ExplorerHandle>;
  /** Whether the engine can answer metadata statements right now. */
  engineRunning: boolean;
  /** Whether a statement can be run right now. */
  canRun: boolean;
  /** Changing this value reloads the tree from the top. */
  refreshToken: number;
  /** How the jump shortcut is written, for example Ctrl+P. */
  jumpShortcut: string;
  /** Called when the operator asks for a name to be put in the editor. */
  onInsert: (text: string) => void;
  /** Opens a statement in a new editor tab. Nothing runs. */
  onOpenStatement: (sql: string) => void;
  /** Runs a statement on the operator's channel, in a new tab when asked. */
  onRunStatement: (sql: string, inTab: boolean) => void;
  /** Told what has been loaded, each time that changes. */
  onCatalog?: (catalog: Catalog) => void;
}

interface OpenMenu {
  node: TreeNode;
  x: number;
  y: number;
}

/** A lazy tree of providers, services, resources, methods and fields. */
export function Explorer({
  ref,
  engineRunning,
  canRun,
  refreshToken,
  jumpShortcut,
  onInsert,
  onOpenStatement,
  onRunStatement,
  onCatalog,
}: ExplorerProps) {
  const [roots, setRoots] = useState<ChildState>({ status: 'loading' });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [children, setChildren] = useState<ReadonlyMap<string, ChildState>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [icons, setIcons] = useState<Record<string, ProviderIcon>>({});
  // The newest version of each provider in the registry, when it could be asked.
  const [latest, setLatest] = useState<ReadonlyMap<string, string>>(new Map());
  const [manualRefresh, setManualRefresh] = useState(0);
  const [filter, setFilter] = useState('');
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Guards against a slow response from before a refresh landing after it.
  const generation = useRef(0);
  // What has been loaded, readable from a task that outlives a render.
  const store = useRef(new Map<string, ChildState>());
  const inFlight = useRef(new Map<string, Promise<TreeNode[]>>());
  const bulkRun = useRef(0);
  const scrollTo = useRef<string | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const filterBox = useRef<HTMLInputElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      jump: () => {
        setJumpOpen(true);
      },
      addProvider: () => {
        setAdding(true);
      },
    }),
    [],
  );

  useEffect(() => {
    generation.current += 1;
    bulkRun.current += 1;
    const mine = generation.current;
    if (!engineRunning) {
      return;
    }
    void (async () => {
      store.current = new Map();
      inFlight.current = new Map();
      setRoots({ status: 'loading' });
      setExpanded(new Set());
      setChildren(new Map());
      setBulk(null);
      try {
        const nodes = await loadChildren(null, host.explorer);
        if (generation.current !== mine) {
          return;
        }
        setRoots({ status: 'loaded', nodes });
        // Icons and registry versions arrive after the tree, so a slow or
        // failed lookup never holds the tree up.
        const names = nodes.map((node) => node.path.provider);
        host.providerIcons(names).then(
          (found) => {
            if (generation.current === mine) {
              setIcons(found);
            }
          },
          () => undefined,
        );
        host.explorer.registry().then(
          (offered) => {
            if (generation.current === mine) {
              setLatest(new Map(offered.map((provider) => [provider.name, provider.version])));
            }
          },
          () => undefined,
        );
      } catch (error) {
        if (generation.current === mine) {
          setRoots({ status: 'error', message: toHostError(error).message });
        }
      }
    })();
  }, [engineRunning, refreshToken, manualRefresh]);

  useEffect(() => {
    onCatalog?.(roots.status === 'loaded' ? catalogFrom(roots.nodes, children) : EMPTY_CATALOG);
  }, [roots, children, onCatalog]);

  /** The children of a node, from what is loaded or from the engine. */
  const ensure = useCallback((node: TreeNode): Promise<TreeNode[]> => {
    const known = store.current.get(node.id);
    if (known?.status === 'loaded') {
      return Promise.resolve(known.nodes);
    }
    const running = inFlight.current.get(node.id);
    if (running) {
      return running;
    }
    const mine = generation.current;
    const settle = (state: ChildState) => {
      if (generation.current === mine) {
        store.current.set(node.id, state);
        setChildren(new Map(store.current));
      }
    };
    settle({ status: 'loading' });
    const task = loadChildren(node, host.explorer)
      .then(
        (nodes) => {
          settle({ status: 'loaded', nodes });
          return nodes;
        },
        (error: unknown) => {
          settle({ status: 'error', message: toHostError(error).message });
          throw error;
        },
      )
      .finally(() => {
        if (inFlight.current.get(node.id) === task) {
          inFlight.current.delete(node.id);
        }
      });
    inFlight.current.set(node.id, task);
    return task;
  }, []);

  const toggle = useCallback(
    (node: TreeNode) => {
      setSelected(node.id);
      if (!node.expandable) {
        return;
      }
      if (expanded.has(node.id)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(node.id);
          return next;
        });
        return;
      }
      setExpanded((current) => new Set(current).add(node.id));
      ensure(node).catch(() => undefined);
    },
    [expanded, ensure],
  );

  const copy = useCallback((node: TreeNode) => {
    if (node.copyText === null) {
      return;
    }
    void copyText(node.copyText).then((ok) => {
      if (ok) {
        setCopied(node.id);
        window.setTimeout(() => {
          setCopied((current) => (current === node.id ? null : current));
        }, 1200);
      }
    });
  }, []);

  const stopBulk = useCallback(() => {
    bulkRun.current += 1;
    setBulk(null);
  }, []);

  const changeFilter = useCallback(
    (text: string) => {
      setFilter(text);
      if (text.trim() === '') {
        stopBulk();
        return;
      }
      // One statement for each provider, once: its services.
      if (roots.status === 'loaded') {
        for (const root of roots.nodes) {
          if (!store.current.has(root.id)) {
            ensure(root).catch(() => undefined);
          }
        }
      }
    },
    [roots, ensure, stopBulk],
  );

  /** Reads the resources of every service not opened yet. Asked for with Enter. */
  const searchEverywhere = useCallback(() => {
    if (roots.status !== 'loaded') {
      return;
    }
    const providers = roots.nodes;
    bulkRun.current += 1;
    const run = bulkRun.current;
    void (async () => {
      await Promise.all(providers.map((root) => ensure(root).catch(() => [])));
      const todo = unopenedServices(providers, store.current);
      if (todo.length === 0 || bulkRun.current !== run) {
        return;
      }
      let done = 0;
      setBulk({ done, total: todo.length });
      const worker = async () => {
        for (;;) {
          const next = todo.shift();
          if (next === undefined || bulkRun.current !== run) {
            return;
          }
          await ensure(next).catch(() => undefined);
          done += 1;
          if (bulkRun.current === run) {
            setBulk((current) => (current ? { ...current, done } : current));
          }
        }
      };
      await Promise.all(Array.from({ length: BULK_WORKERS }, worker));
      if (bulkRun.current === run) {
        setBulk(null);
      }
    })();
  }, [roots, ensure]);

  /** Goes to a node named in the jump box. Resolves to a message when it cannot. */
  const jump = useCallback(
    async (text: string): Promise<string | null> => {
      const path = parseJump(text);
      if (path === null) {
        return 'Enter one to three names separated by dots.';
      }
      if (roots.status !== 'loaded') {
        return 'The providers have not loaded yet.';
      }
      const named = (nodes: TreeNode[], name: string) =>
        nodes.find((node) => node.label.toLowerCase() === name.toLowerCase());
      const provider = named(roots.nodes, path.provider);
      if (!provider) {
        return `No installed provider is named ${path.provider}.`;
      }
      const open: string[] = [];
      let target = provider;
      try {
        if (path.service !== undefined) {
          const service = named(await ensure(provider), path.service);
          if (!service) {
            return `${provider.label} has no service named ${path.service}.`;
          }
          open.push(provider.id);
          target = service;
          if (path.resource !== undefined) {
            const resource = named(await ensure(service), path.resource);
            if (!resource) {
              return `${qualifiedName(service.path)} has no resource named ${path.resource}.`;
            }
            open.push(service.id);
            target = resource;
          }
        }
      } catch (error) {
        return toHostError(error).message;
      }
      stopBulk();
      setFilter('');
      setExpanded((current) => new Set([...current, ...open]));
      setSelected(target.id);
      scrollTo.current = target.id;
      return null;
    },
    [roots, ensure, stopBulk],
  );

  const query = useDeferredValue(filter);
  const filtering = query.trim() !== '';
  const rows = useMemo(
    () => (roots.status === 'loaded' ? filterRows(roots.nodes, expanded, children, query) : []),
    [roots, expanded, children, query],
  );
  const shown =
    filtering && rows.length > MAX_FILTERED_ROWS ? rows.slice(0, MAX_FILTERED_ROWS) : rows;
  const unread = useMemo(
    () => (roots.status === 'loaded' ? unopenedServices(roots.nodes, children).length : 0),
    [roots, children],
  );

  // Bring the node a jump chose into view once its row is drawn.
  useEffect(() => {
    const id = scrollTo.current;
    if (id === null) {
      return;
    }
    const row = tree.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`);
    if (row) {
      scrollTo.current = null;
      row.scrollIntoView({ block: 'nearest' });
      row.focus();
    }
  }, [shown, selected]);

  /** A statement template for a method, opened in a new tab. */
  const generate = useCallback(
    (node: TreeNode, verb: string, method: string, note = '') => {
      const { provider, service, resource } = node.path;
      if (service === undefined || resource === undefined) {
        return;
      }
      setNotice(null);
      host.explorer.methodFields(provider, service, resource, method).then(
        (fields) => {
          onOpenStatement(generateStatement(node.path, verb, method, fields, note));
        },
        (error: unknown) => {
          setNotice(toHostError(error).message);
        },
      );
    },
    [onOpenStatement],
  );

  const generateSelect = useCallback(
    (node: TreeNode) => {
      const { provider, service, resource } = node.path;
      if (service === undefined || resource === undefined) {
        return;
      }
      setNotice(null);
      host.explorer.methods(provider, service, resource).then(
        (methods) => {
          const method = pickSelectMethod(methods);
          if (method === null) {
            setNotice(`${qualifiedName(node.path)} has no SELECT method.`);
          } else {
            generate(node, 'SELECT', method.name, otherSelectMethods(methods, method));
          }
        },
        (error: unknown) => {
          setNotice(toHostError(error).message);
        },
      );
    },
    [generate],
  );

  /** The newer version the registry has for a provider, if it has one. */
  const newerVersion = useCallback(
    (node: TreeNode): string | null => {
      if (node.kind !== 'provider') {
        return null;
      }
      const offered = latest.get(node.label);
      return offered !== undefined && (compareVersions(node.detail, offered) ?? 0) < 0
        ? offered
        : null;
    },
    [latest],
  );

  const actionsFor = useCallback(
    (node: TreeNode): MenuItem[] => {
      const copyItem = (label: string): MenuItem[] =>
        node.copyText === null
          ? []
          : [
              {
                label,
                onSelect: () => {
                  copy(node);
                },
              },
            ];
      switch (node.kind) {
        case 'provider': {
          const newer = newerVersion(node);
          return [
            ...(newer === null
              ? []
              : [
                  {
                    label: `Update to ${newer}`,
                    disabled: !canRun,
                    onSelect: () => {
                      onRunStatement(`REGISTRY PULL ${ident(node.label)};`, false);
                    },
                  },
                ]),
            ...copyItem('Copy name'),
          ];
        }
        case 'service':
          return copyItem('Copy qualified name');
        case 'resource':
          return [
            {
              label: 'Generate SELECT',
              onSelect: () => {
                generateSelect(node);
              },
            },
            ...copyItem('Copy qualified name'),
            {
              label: 'DESCRIBE EXTENDED',
              disabled: !canRun,
              onSelect: () => {
                onRunStatement(`DESCRIBE EXTENDED ${tableName(node.path)};`, true);
              },
            },
          ];
        case 'method': {
          const { method } = node.path;
          const verb = node.verb ?? '';
          return [
            ...(method === undefined || verb === ''
              ? []
              : [
                  {
                    label: `Generate ${verb} statement`,
                    onSelect: () => {
                      generate(node, verb, method);
                    },
                  },
                ]),
            ...copyItem('Copy qualified name'),
          ];
        }
        case 'field':
        case 'param':
          return [
            {
              label: 'Insert into editor',
              onSelect: () => {
                onInsert(node.label);
              },
            },
            ...copyItem('Copy name'),
          ];
        default:
          return [];
      }
    },
    [canRun, copy, generate, generateSelect, newerVersion, onInsert, onRunStatement],
  );

  const openMenu = useCallback(
    (node: TreeNode, x: number, y: number) => {
      setSelected(node.id);
      setMenu(actionsFor(node).length > 0 ? { node, x, y } : null);
    },
    [actionsFor],
  );
  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);
  const closeJump = useCallback(() => {
    setJumpOpen(false);
  }, []);
  const closeAdding = useCallback(() => {
    setAdding(false);
  }, []);

  const installed = useMemo(
    () => new Set(roots.status === 'loaded' ? roots.nodes.map((node) => node.label) : []),
    [roots],
  );

  // The host leaves the provider built into the engine out of the list,
  // so an engine with nothing installed gives an empty tree.
  const noProviders = roots.status === 'loaded' && roots.nodes.length === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-surface-alt">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-2">
        <span className="text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
          Explorer
        </span>
        <span className="flex items-center gap-0.5">
          <IconButton
            label={`Go to resource (${jumpShortcut})`}
            disabled={roots.status !== 'loaded' || noProviders}
            onClick={() => {
              setJumpOpen(true);
            }}
          >
            <GoTo />
          </IconButton>
          <IconButton
            label="Add provider"
            disabled={!engineRunning}
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus />
          </IconButton>
          <IconButton
            label="Reload providers"
            disabled={!engineRunning}
            onClick={() => {
              setManualRefresh((n) => n + 1);
            }}
          >
            <Refresh />
          </IconButton>
        </span>
      </div>

      <div className="shrink-0 border-b border-line px-2 py-1">
        <div className="flex h-6 items-center gap-1 rounded border border-line bg-surface px-1.5 focus-within:border-accent">
          <Search className="shrink-0 text-ink-muted" />
          <input
            ref={filterBox}
            type="text"
            spellCheck={false}
            aria-label="Filter the tree"
            title="Matches provider, service, resource and method names, where they have been loaded"
            className="selectable h-full min-w-0 flex-1 bg-transparent outline-none"
            placeholder="Filter"
            disabled={roots.status !== 'loaded' || noProviders}
            value={filter}
            onChange={(event) => {
              changeFilter(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                changeFilter('');
              } else if (event.key === 'Enter' && filter.trim() !== '') {
                event.preventDefault();
                searchEverywhere();
              }
            }}
          />
          {filter !== '' && (
            <button
              type="button"
              title="Clear the filter (Esc)"
              aria-label="Clear the filter"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-surface-sunken hover:text-ink"
              onClick={() => {
                changeFilter('');
                filterBox.current?.focus();
              }}
            >
              <Close />
            </button>
          )}
        </div>
        {filter.trim() !== '' && (bulk !== null || unread > 0) && (
          <p className="mt-1 text-[11px] text-ink-muted" role="status">
            {bulk !== null
              ? `Reading resources: ${bulk.done} of ${bulk.total} services. Esc stops.`
              : `Resources are searched in opened services. Enter reads the other ${unread}.`}
          </p>
        )}
      </div>

      {notice !== null && (
        <p
          className="selectable flex shrink-0 items-start gap-1 border-b border-line px-2 py-1 text-danger"
          role="status"
        >
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <IconButton
            label="Dismiss"
            onClick={() => {
              setNotice(null);
            }}
          >
            <Close />
          </IconButton>
        </p>
      )}

      <div
        ref={tree}
        className="min-h-0 flex-1 overflow-auto py-1"
        role="tree"
        aria-label="Providers"
      >
        {!engineRunning ? (
          <p className="px-3 py-2 text-ink-muted">
            The engine is not running. Providers appear here once it is.
          </p>
        ) : roots.status === 'loading' ? (
          <p className="flex items-center gap-2 px-3 py-2 text-ink-muted">
            <Spinner /> Loading providers
          </p>
        ) : roots.status === 'error' ? (
          <p className="selectable px-3 py-2 text-danger">{roots.message}</p>
        ) : (
          <>
            {shown.map((row) => (
              <TreeRow
                key={row.node.id}
                row={row}
                icon={row.node.kind === 'provider' ? icons[row.node.path.provider] : undefined}
                newer={newerVersion(row.node)}
                highlight={filtering && row.matched === true ? query.trim() : ''}
                selected={selected === row.node.id}
                copied={copied === row.node.id}
                hasActions={actionsFor(row.node).length > 0}
                onToggle={toggle}
                onCopy={copy}
                onInsert={onInsert}
                onMenu={openMenu}
              />
            ))}
            {filtering && rows.length > shown.length && (
              <p className="px-3 py-2 text-ink-muted">
                Showing the first {shown.length} of {rows.length} rows. Type more to narrow the
                list.
              </p>
            )}
            {filtering && rows.length === 0 && (
              <p className="px-3 py-2 text-ink-muted">Nothing that has been loaded matches.</p>
            )}
            {noProviders && (
              <div className="px-3 py-2 text-ink-muted">
                <p>No providers are installed yet.</p>
                <button
                  type="button"
                  className="mt-2 flex h-6 items-center gap-1 rounded bg-brand px-2 font-semibold text-on-brand hover:bg-brand-dark"
                  onClick={() => {
                    setAdding(true);
                  }}
                >
                  <Plus />
                  Add provider
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {jumpOpen && <JumpBox onJump={jump} onClose={closeJump} />}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.node.label}`}
          items={actionsFor(menu.node)}
          onClose={closeMenu}
        />
      )}
      {adding && (
        <AddProviderDialog
          installed={installed}
          canRun={canRun}
          onInstall={(provider) => {
            onRunStatement(`REGISTRY PULL ${ident(provider)};`, false);
          }}
          onClose={closeAdding}
        />
      )}
    </div>
  );
}

/** The label, with the part a filter matched picked out. */
function Label({ text, highlight }: { text: string; highlight: string }): ReactNode {
  const at = highlight === '' ? -1 : text.toLowerCase().indexOf(highlight.toLowerCase());
  if (at < 0) {
    return text;
  }
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] font-bold text-ink">
        {text.slice(at, at + highlight.length)}
      </mark>
      {text.slice(at + highlight.length)}
    </>
  );
}

interface TreeRowProps {
  row: VisibleRow;
  /** The provider's own icon, when one could be resolved. */
  icon: ProviderIcon | undefined;
  /** For a provider: the newer version in the registry, if there is one. */
  newer: string | null;
  /** The filter text this row's name matched, or empty. */
  highlight: string;
  selected: boolean;
  copied: boolean;
  hasActions: boolean;
  onToggle: (node: TreeNode) => void;
  onCopy: (node: TreeNode) => void;
  onInsert: (text: string) => void;
  onMenu: (node: TreeNode, x: number, y: number) => void;
}

function TreeRow({
  row,
  icon,
  newer,
  highlight,
  selected,
  copied,
  hasActions,
  onToggle,
  onCopy,
  onInsert,
  onMenu,
}: TreeRowProps) {
  const { node, depth, expanded, state } = row;
  const badge = KIND_BADGE[node.kind];
  const indent = 6 + depth * 14;
  const hover = hoverText(node);
  const rowButton =
    'flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-line hover:text-ink';

  return (
    <>
      <div
        role="treeitem"
        data-node={node.id}
        aria-level={depth + 1}
        aria-expanded={node.expandable ? expanded : undefined}
        aria-selected={selected}
        tabIndex={0}
        title={icon ? `${icon.displayName}\n${hover}` : hover}
        className={`group relative flex h-[22px] cursor-default items-center gap-1 pr-1 hover:bg-surface-sunken ${
          selected ? 'bg-surface-sunken shadow-[inset_2px_0_0_var(--color-accent)]' : ''
        }`}
        style={{ paddingLeft: indent }}
        onClick={() => {
          onToggle(node);
        }}
        onDoubleClick={() => {
          if (!node.expandable && node.copyText !== null) {
            onInsert(node.copyText);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(node, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle(node);
          } else if (event.key === 'ArrowRight' && node.expandable && !expanded) {
            onToggle(node);
          } else if (event.key === 'ArrowLeft' && expanded) {
            onToggle(node);
          } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            onMenu(node, box.left + indent + 20, box.bottom);
          }
        }}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-muted">
          {node.expandable ? (
            state?.status === 'loading' ? (
              <Spinner />
            ) : expanded ? (
              <ChevronDown />
            ) : (
              <ChevronRight />
            )
          ) : null}
        </span>
        {icon ? (
          <img
            src={icon.dataUrl}
            alt=""
            width={16}
            height={16}
            draggable={false}
            className={`h-4 w-4 shrink-0 object-contain ${icon.invertOnDark ? 'wb-invert-on-dark' : ''}`}
          />
        ) : (
          badge.text !== '' && (
            <span
              title={badge.label}
              aria-label={badge.label}
              className={`flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm px-0.5 text-[9px] font-bold ${badge.className}`}
            >
              {badge.text}
            </span>
          )
        )}
        {node.verb !== undefined && node.verb !== '' && (
          <span
            title={`SQL verb: ${node.verb}`}
            className={`flex h-4 w-[46px] shrink-0 items-center justify-center rounded-sm border text-[9px] font-bold tracking-wide ${
              node.verb === 'SELECT' ? 'border-accent text-accent' : 'border-warn text-warn'
            }`}
          >
            {node.verb}
          </span>
        )}
        <span className="min-w-0 truncate font-mono text-[12px]">
          <Label text={node.label} highlight={highlight} />
        </span>
        {node.detail !== '' && (
          <span className="min-w-0 shrink-[99] truncate text-[11px] text-ink-muted">
            {node.detail}
          </span>
        )}
        {newer !== null && (
          <span
            title={`The registry has ${newer}. Installed: ${node.detail}`}
            className="shrink-0 rounded-sm border border-accent px-1 text-[9px] font-bold tracking-wide text-accent"
          >
            UPDATE
          </span>
        )}
        {/* Drawn over the end of the row, so they take no room from the name. */}
        {(node.copyText !== null || hasActions) && (
          <span
            className={`absolute top-0 right-1 h-full items-center gap-0.5 bg-surface-sunken pl-1 ${
              copied ? 'flex' : 'hidden group-focus-within:flex group-hover:flex'
            }`}
          >
            {node.copyText !== null && (
              <button
                type="button"
                title={`Copy ${node.copyText}`}
                aria-label={`Copy ${node.copyText}`}
                className={rowButton}
                onClick={(event) => {
                  event.stopPropagation();
                  onCopy(node);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                }}
              >
                {copied ? <Check className="text-ok" /> : <Copy />}
              </button>
            )}
            {hasActions && (
              <button
                type="button"
                title="More actions"
                aria-label={`More actions for ${node.label}`}
                aria-haspopup="menu"
                className={rowButton}
                onClick={(event) => {
                  event.stopPropagation();
                  const box = event.currentTarget.getBoundingClientRect();
                  onMenu(node, box.left, box.bottom);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                }}
              >
                <More />
              </button>
            )}
          </span>
        )}
      </div>
      {state?.status === 'error' && (
        <p className="selectable py-0.5 pr-2 text-danger" style={{ paddingLeft: indent + 20 }}>
          {state.message}
        </p>
      )}
      {state?.status === 'loaded' && state.nodes.length === 0 && (
        <p className="py-0.5 pr-2 text-ink-muted italic" style={{ paddingLeft: indent + 20 }}>
          Nothing here
        </p>
      )}
    </>
  );
}
