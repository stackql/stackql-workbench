import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { host, toHostError, type ProviderIcon } from '../../host';
import { copyText } from '../../host/clipboard';
import {
  loadChildren,
  visibleRows,
  type ChildState,
  type NodeKind,
  type TreeNode,
  type VisibleRow,
} from '../../lib/explorerTree';
import { IconButton } from '../../ui/IconButton';
import { Check, ChevronDown, ChevronRight, Copy, Refresh, Spinner } from '../../ui/icons';

const KIND_BADGE: Record<NodeKind, { text: string; className: string; label: string }> = {
  provider: { text: 'P', className: 'bg-brand text-on-brand', label: 'Provider' },
  service: { text: 'S', className: 'bg-brand-light text-on-brand', label: 'Service' },
  resource: { text: 'R', className: 'border border-accent text-accent', label: 'Resource' },
  fieldsGroup: { text: 'F', className: 'text-ink-muted', label: 'Fields' },
  methodsGroup: { text: 'M', className: 'text-ink-muted', label: 'Methods' },
  field: { text: '', className: '', label: 'Field' },
  method: { text: 'fn', className: 'text-ink-muted', label: 'Method' },
  param: { text: '', className: '', label: 'Parameter' },
};

interface ExplorerProps {
  /** Whether the engine can answer metadata statements right now. */
  engineRunning: boolean;
  /** Changing this value reloads the tree from the top. */
  refreshToken: number;
  /** Called when the operator asks for a name to be put in the editor. */
  onInsert: (text: string) => void;
}

/** A lazy tree of providers, services, resources, methods and fields. */
export function Explorer({ engineRunning, refreshToken, onInsert }: ExplorerProps) {
  const [roots, setRoots] = useState<ChildState>({ status: 'loading' });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [children, setChildren] = useState<ReadonlyMap<string, ChildState>>(new Map());
  const [copied, setCopied] = useState<string | null>(null);
  const [icons, setIcons] = useState<Record<string, ProviderIcon>>({});
  const [manualRefresh, setManualRefresh] = useState(0);
  // Guards against a slow response from before a refresh landing after it.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    if (!engineRunning) {
      return;
    }
    void (async () => {
      setRoots({ status: 'loading' });
      setExpanded(new Set());
      setChildren(new Map());
      try {
        const nodes = await loadChildren(null, host.explorer);
        if (generation.current !== mine) {
          return;
        }
        setRoots({ status: 'loaded', nodes });
        // Icons arrive after the tree, so a slow or failed lookup never
        // holds the tree up. Until then, and for any provider without an
        // icon, the letter badge is shown.
        const names = nodes.map((node) => node.path.provider);
        host.providerIcons(names).then(
          (found) => {
            if (generation.current === mine) {
              setIcons(found);
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

  const toggle = useCallback(
    (node: TreeNode) => {
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
      const known = children.get(node.id);
      if (known?.status === 'loaded' || known?.status === 'loading') {
        return;
      }
      const mine = generation.current;
      const settle = (state: ChildState) => {
        if (generation.current === mine) {
          setChildren((current) => new Map(current).set(node.id, state));
        }
      };
      settle({ status: 'loading' });
      loadChildren(node, host.explorer).then(
        (nodes) => {
          settle({ status: 'loaded', nodes });
        },
        (error: unknown) => {
          settle({ status: 'error', message: toHostError(error).message });
        },
      );
    },
    [children, expanded],
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

  const rows = useMemo(
    () => (roots.status === 'loaded' ? visibleRows(roots.nodes, expanded, children) : []),
    [roots, expanded, children],
  );

  const onlyBuiltIn =
    roots.status === 'loaded' && roots.nodes.every((node) => node.label === 'stackql_preview');

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-alt">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-2">
        <span className="text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
          Explorer
        </span>
        <IconButton
          label="Reload providers"
          disabled={!engineRunning}
          onClick={() => {
            setManualRefresh((n) => n + 1);
          }}
        >
          <Refresh />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1" role="tree" aria-label="Providers">
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
            {rows.map((row) => (
              <TreeRow
                key={row.node.id}
                row={row}
                icon={row.node.kind === 'provider' ? icons[row.node.path.provider] : undefined}
                copied={copied === row.node.id}
                onToggle={toggle}
                onCopy={copy}
                onInsert={onInsert}
              />
            ))}
            {onlyBuiltIn && (
              <p className="mt-2 border-t border-line px-3 py-2 text-ink-muted">
                No providers are installed yet. Run{' '}
                <code className="selectable font-mono text-ink">REGISTRY LIST;</code> in the editor
                to see what is available, then{' '}
                <code className="selectable font-mono text-ink">REGISTRY PULL github;</code> to
                install one.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface TreeRowProps {
  row: VisibleRow;
  /** The provider's own icon, when one could be resolved. */
  icon: ProviderIcon | undefined;
  copied: boolean;
  onToggle: (node: TreeNode) => void;
  onCopy: (node: TreeNode) => void;
  onInsert: (text: string) => void;
}

function TreeRow({ row, icon, copied, onToggle, onCopy, onInsert }: TreeRowProps) {
  const { node, depth, expanded, state } = row;
  const badge = KIND_BADGE[node.kind];
  const indent = 6 + depth * 14;

  return (
    <>
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={node.expandable ? expanded : undefined}
        aria-selected={false}
        tabIndex={0}
        title={
          icon
            ? `${icon.displayName}
${node.title}`
            : node.title
        }
        className="group flex h-[22px] cursor-default items-center gap-1 pr-1 hover:bg-surface-sunken"
        style={{ paddingLeft: indent }}
        onClick={() => {
          onToggle(node);
        }}
        onDoubleClick={() => {
          if (!node.expandable && node.copyText !== null) {
            onInsert(node.copyText);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle(node);
          } else if (event.key === 'ArrowRight' && node.expandable && !expanded) {
            onToggle(node);
          } else if (event.key === 'ArrowLeft' && expanded) {
            onToggle(node);
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
              aria-label={badge.label}
              className={`flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm px-0.5 text-[9px] font-bold ${badge.className}`}
            >
              {badge.text}
            </span>
          )
        )}
        <span className="truncate">{node.label}</span>
        {node.detail !== '' && (
          <span className="truncate text-[11px] text-ink-muted">{node.detail}</span>
        )}
        <span className="flex-1" />
        {node.copyText !== null && (
          <button
            type="button"
            title={`Copy ${node.copyText}`}
            aria-label={`Copy ${node.copyText}`}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-line hover:text-ink ${
              copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
            }`}
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
