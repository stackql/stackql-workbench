// The explorer tree: node shapes, how children are loaded, and what "copy
// name" copies. Kept free of React and of Tauri so it can be tested.

import type { Field, Method, MethodField, Provider, Resource, Service } from '../host/types';

export type NodeKind =
  | 'provider'
  | 'service'
  | 'resource'
  | 'fieldsGroup'
  | 'methodsGroup'
  | 'field'
  | 'method'
  | 'inputsGroup'
  | 'outputsGroup'
  | 'param';

export interface NodePath {
  provider: string;
  service?: string;
  resource?: string;
  method?: string;
}

export interface TreeNode {
  /** Unique within the tree. */
  id: string;
  kind: NodeKind;
  label: string;
  /** Secondary text shown dimmed after the label: a version, a type, a verb. */
  detail: string;
  /** Tooltip. */
  title: string;
  /** What the copy action puts on the clipboard. Null when there is nothing sensible. */
  copyText: string | null;
  expandable: boolean;
  path: NodePath;
  /** Children already in hand, for a group whose members arrived with its parent. */
  children?: TreeNode[];
  /** For a method: its SQL verb, in capitals. */
  verb?: string;
}

/** The slice of the host API the tree needs. */
export interface ExplorerApi {
  providers(): Promise<Provider[]>;
  services(provider: string): Promise<Service[]>;
  resources(provider: string, service: string): Promise<Resource[]>;
  methods(provider: string, service: string, resource: string): Promise<Method[]>;
  fields(provider: string, service: string, resource: string): Promise<Field[]>;
  methodFields(
    provider: string,
    service: string,
    resource: string,
    method: string,
  ): Promise<MethodField[]>;
}

/** The dotted name of a provider, service, resource or method. */
export function qualifiedName(path: NodePath): string {
  return [path.provider, path.service, path.resource, path.method]
    .filter((part): part is string => part !== undefined)
    .join('.');
}

/**
 * What a row shows on hover: the whole name first, because the row may be
 * cut short, then what the engine says about it.
 */
export function hoverText(node: TreeNode): string {
  const named =
    node.kind === 'field' || node.kind === 'param'
      ? [node.label, node.detail].filter(Boolean).join(' ')
      : [node.verb, node.copyText ?? node.label, node.kind === 'provider' ? node.detail : '']
          .filter(Boolean)
          .join(' ');
  const about = node.kind === 'provider' ? '' : node.title;
  return about !== '' && about !== named && about !== node.copyText ? `${named}\n${about}` : named;
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export function providerNodes(providers: Provider[]): TreeNode[] {
  return [...providers].sort(byName).map((provider) => ({
    id: `p:${provider.name}`,
    kind: 'provider',
    label: provider.name,
    detail: provider.version,
    title: `Provider ${provider.name} ${provider.version}`.trim(),
    copyText: provider.name,
    expandable: true,
    path: { provider: provider.name },
  }));
}

export function serviceNodes(provider: string, services: Service[]): TreeNode[] {
  return [...services].sort(byName).map((service) => {
    const path = { provider, service: service.name };
    // A title that only repeats the name, such as "ec2 API", says nothing.
    const title = service.title.trim().toLowerCase();
    const name = service.name.toLowerCase();
    const repeats = title === name || title === `${name} api`;
    return {
      id: `s:${qualifiedName(path)}`,
      kind: 'service',
      label: service.name,
      detail: repeats ? '' : service.title,
      title: service.description || service.title || qualifiedName(path),
      copyText: qualifiedName(path),
      expandable: true,
      path,
    };
  });
}

export function resourceNodes(
  provider: string,
  service: string,
  resources: Resource[],
): TreeNode[] {
  return [...resources].sort(byName).map((resource) => {
    const path = { provider, service, resource: resource.name };
    return {
      id: `r:${qualifiedName(path)}`,
      kind: 'resource',
      label: resource.name,
      detail: '',
      title: resource.description || qualifiedName(path),
      copyText: qualifiedName(path),
      expandable: true,
      path,
    };
  });
}

/** A resource opens into two groups, so fields and methods load separately. */
export function resourceGroupNodes(path: NodePath): TreeNode[] {
  const name = qualifiedName(path);
  return [
    {
      id: `fg:${name}`,
      kind: 'fieldsGroup',
      label: 'Fields',
      detail: '',
      title: `Columns of ${name}`,
      copyText: null,
      expandable: true,
      path,
    },
    {
      id: `mg:${name}`,
      kind: 'methodsGroup',
      label: 'Methods',
      detail: '',
      title: `Methods of ${name}`,
      copyText: null,
      expandable: true,
      path,
    },
  ];
}

export function fieldNodes(path: NodePath, fields: Field[]): TreeNode[] {
  const name = qualifiedName(path);
  // Keep the engine's order. It is the order of the columns.
  return fields.map((field) => ({
    id: `f:${name}:${field.name}`,
    kind: 'field',
    label: field.name,
    detail: field.type,
    title: field.description || `${name}.${field.name}`,
    // A column name is what a statement needs, not a dotted path.
    copyText: field.name,
    expandable: false,
    path,
  }));
}

export function methodNodes(path: NodePath, methods: Method[]): TreeNode[] {
  return [...methods].sort(byName).map((method) => {
    const methodPath = { ...path, method: method.name };
    const params = method.requiredParams.length
      ? `Required: ${method.requiredParams.join(', ')}`
      : 'No required parameters';
    return {
      id: `m:${qualifiedName(methodPath)}`,
      kind: 'method',
      label: method.name,
      // The verb is drawn as a pill before the name, not as trailing text.
      detail: '',
      verb: method.sqlVerb.toUpperCase(),
      title: [method.description, params].filter(Boolean).join('\n'),
      copyText: qualifiedName(methodPath),
      expandable: true,
      path: methodPath,
    };
  });
}

const PARAM_ORDER: Record<string, number> = { input_required: 0, input_optional: 1, output: 2 };
const PARAM_LABEL: Record<string, string> = {
  input_required: 'required',
  input_optional: 'optional',
  output: 'output',
};

/**
 * Whether a field is something a statement supplies. The engine marks those
 * `input_required` or `input_optional`. What it returns is marked `output`
 * by most providers and `response` by the built-in one, so anything that
 * is not an input counts as an output.
 */
const isInput = (field: MethodField) => field.paramType.startsWith('input');
const isOutput = (field: MethodField) => !isInput(field);

/**
 * The nodes for a method's fields: required inputs, optional inputs, then
 * outputs, each kind in the engine's order. An output shows only its type,
 * because it sits in the Outputs group.
 */
export function paramNodes(path: NodePath, fields: MethodField[]): TreeNode[] {
  const name = qualifiedName(path);
  const rank = (field: MethodField) => PARAM_ORDER[field.paramType] ?? 2;
  return fields
    .map((field, position) => ({ field, position }))
    .sort((a, b) => rank(a.field) - rank(b.field) || a.position - b.position)
    .map(({ field }) => {
      const role = PARAM_LABEL[field.paramType] ?? field.paramType;
      return {
        id: `mp:${name}:${field.paramType}:${field.name}`,
        kind: 'param' as const,
        label: field.name,
        detail: [isOutput(field) ? '' : role, field.type].filter(Boolean).join(' '),
        title: field.description || `${field.name} (${role})`,
        copyText: field.name,
        expandable: false,
        path,
      };
    });
}

/**
 * A method opens into two groups, Inputs and Outputs, so what a statement
 * must supply is kept apart from what it returns. Both start collapsed. The
 * fields arrive in one answer from the engine, so each group carries its
 * members and opening it needs no second request.
 */
export function methodGroupNodes(path: NodePath, fields: MethodField[]): TreeNode[] {
  const name = qualifiedName(path);
  const inputs = fields.filter(isInput);
  const outputs = fields.filter(isOutput);
  const required = inputs.filter((field) => field.paramType === 'input_required').length;
  return [
    {
      id: `ig:${name}`,
      kind: 'inputsGroup',
      label: 'Inputs',
      detail: inputs.length === 0 ? 'none' : `${inputs.length}, ${required} required`,
      title: `What ${name} takes: WHERE clause parameters and request fields`,
      copyText: null,
      expandable: inputs.length > 0,
      path,
      children: paramNodes(path, inputs),
    },
    {
      id: `og:${name}`,
      kind: 'outputsGroup',
      label: 'Outputs',
      detail: outputs.length === 0 ? 'none' : String(outputs.length),
      title: `What ${name} returns: the columns a statement can select`,
      copyText: null,
      expandable: outputs.length > 0,
      path,
      children: paramNodes(path, outputs),
    },
  ];
}

/** Loads the children of a node. `null` loads the roots. */
export async function loadChildren(node: TreeNode | null, api: ExplorerApi): Promise<TreeNode[]> {
  if (node === null) {
    return providerNodes(await api.providers());
  }
  const { provider, service, resource, method } = node.path;
  switch (node.kind) {
    case 'provider':
      return serviceNodes(provider, await api.services(provider));
    case 'service':
      if (service === undefined) {
        return [];
      }
      return resourceNodes(provider, service, await api.resources(provider, service));
    case 'resource':
      return resourceGroupNodes(node.path);
    case 'fieldsGroup':
      if (service === undefined || resource === undefined) {
        return [];
      }
      return fieldNodes(node.path, await api.fields(provider, service, resource));
    case 'methodsGroup':
      if (service === undefined || resource === undefined) {
        return [];
      }
      return methodNodes(node.path, await api.methods(provider, service, resource));
    case 'method':
      if (service === undefined || resource === undefined || method === undefined) {
        return [];
      }
      return methodGroupNodes(
        node.path,
        await api.methodFields(provider, service, resource, method),
      );
    case 'inputsGroup':
    case 'outputsGroup':
      return node.children ?? [];
    case 'field':
    case 'param':
      return [];
  }
}

export type ChildState =
  | { status: 'loading' }
  | { status: 'loaded'; nodes: TreeNode[] }
  | { status: 'error'; message: string };

export interface VisibleRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  /** Set on the row of an expanded node whose children are loading or failed. */
  state: ChildState | undefined;
  /** Under a filter: this node's own name matched. */
  matched?: boolean;
}

/** Flattens the expanded part of the tree into the rows to draw, top to bottom. */
export function visibleRows(
  roots: TreeNode[],
  expanded: ReadonlySet<string>,
  children: ReadonlyMap<string, ChildState>,
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      const isExpanded = expanded.has(node.id);
      const state = isExpanded ? children.get(node.id) : undefined;
      rows.push({ node, depth, expanded: isExpanded, state });
      if (state?.status === 'loaded') {
        walk(state.nodes, depth + 1);
      }
    }
  };
  walk(roots, 0);
  return rows;
}

/** The kinds of node a filter looks at. Groups, fields and parameters are not searched. */
const SEARCHED: ReadonlySet<NodeKind> = new Set(['provider', 'service', 'resource', 'method']);

/**
 * The rows to draw under a filter. A node is shown when its own name holds
 * the text, or when something loaded beneath it does. A node with a match
 * beneath it is drawn open, so matches keep their parents in view. A node
 * that matched by its own name shows its children only when the operator
 * opened it.
 *
 * Only what has been loaded is looked at. Nothing is fetched here.
 */
export function filterRows(
  roots: TreeNode[],
  expanded: ReadonlySet<string>,
  children: ReadonlyMap<string, ChildState>,
  query: string,
): VisibleRow[] {
  const text = query.trim().toLowerCase();
  if (text === '') {
    return visibleRows(roots, expanded, children);
  }
  const visit = (node: TreeNode, depth: number): VisibleRow[] => {
    const state = children.get(node.id);
    const kids = state?.status === 'loaded' ? state.nodes : [];
    const below = kids.flatMap((kid) => visit(kid, depth + 1));
    const matched = SEARCHED.has(node.kind) && node.label.toLowerCase().includes(text);
    if (!matched && below.length === 0) {
      return [];
    }
    const opened = expanded.has(node.id);
    const row: VisibleRow = {
      node,
      depth,
      expanded: below.length > 0 || opened,
      state: below.length > 0 || opened ? state : undefined,
      matched,
    };
    if (below.length > 0) {
      return [row, ...below];
    }
    // Matched by name, nothing matching beneath: opened by hand, it shows
    // everything it has.
    if (opened && state?.status === 'loaded') {
      const all: VisibleRow[] = [];
      const walk = (nodes: TreeNode[], at: number) => {
        for (const kid of nodes) {
          const kidState = expanded.has(kid.id) ? children.get(kid.id) : undefined;
          all.push({ node: kid, depth: at, expanded: expanded.has(kid.id), state: kidState });
          if (kidState?.status === 'loaded') {
            walk(kidState.nodes, at + 1);
          }
        }
      };
      walk(kids, depth + 1);
      return [row, ...all];
    }
    return [row];
  };
  return roots.flatMap((root) => visit(root, 0));
}

/** The services whose resources have not been loaded, across loaded providers. */
export function unopenedServices(
  roots: TreeNode[],
  children: ReadonlyMap<string, ChildState>,
): TreeNode[] {
  return roots.flatMap((root) => {
    const state = children.get(root.id);
    const services = state?.status === 'loaded' ? state.nodes : [];
    return services.filter((service) => !children.has(service.id));
  });
}

/**
 * Reads `provider`, `provider.service` or `provider.service.resource` as
 * typed into the jump box. A part may be in double quotes. Null when the
 * text is not one to three names.
 */
export function parseJump(text: string): NodePath | null {
  const parts = text
    .trim()
    .replace(/;$/, '')
    .split('.')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'));
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => part === '')) {
    return null;
  }
  const [provider, service, resource] = parts;
  if (provider === undefined) {
    return null;
  }
  return {
    provider,
    ...(service !== undefined ? { service } : {}),
    ...(resource !== undefined ? { resource } : {}),
  };
}

/**
 * Compares two provider versions of the form `v26.08.00444`. Negative when
 * `a` is older, positive when newer, zero when the same. Null when either
 * is not of that form, in which case nothing is claimed about them.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) {
    return null;
  }
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
