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
    return {
      id: `s:${qualifiedName(path)}`,
      kind: 'service',
      label: service.name,
      detail: service.title !== service.name ? service.title : '',
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
      detail: method.sqlVerb,
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

/** Inputs first, required before optional, then outputs. */
export function paramNodes(path: NodePath, fields: MethodField[]): TreeNode[] {
  const name = qualifiedName(path);
  const rank = (field: MethodField) => PARAM_ORDER[field.paramType] ?? 3;
  return fields
    .map((field, position) => ({ field, position }))
    .sort((a, b) => rank(a.field) - rank(b.field) || a.position - b.position)
    .map(({ field }) => {
      const role = PARAM_LABEL[field.paramType] ?? field.paramType;
      return {
        id: `mp:${name}:${field.paramType}:${field.name}`,
        kind: 'param' as const,
        label: field.name,
        detail: [role, field.type].filter(Boolean).join(' '),
        title: field.description || `${field.name} (${role})`,
        copyText: field.name,
        expandable: false,
        path,
      };
    });
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
      return paramNodes(node.path, await api.methodFields(provider, service, resource, method));
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
