// A statement the operator could run to get what a metadata tool returned.
//
// The engine does not say which statement it ran for these tools, so this
// is shown as "Equivalent SQL", never as what ran. The forms are the ones
// the engine itself builds for each tool. A call with an argument this
// file does not know is given no equivalent, since the argument could
// change the statement.

const IDENTIFIER = /^[A-Za-z0-9_]+$/;
const VERSION = /^[A-Za-z0-9_.-]+$/;

/** Arguments that shape the tool's output and not the statement. */
const NEUTRAL = new Set(['format', 'row_limit']);

function record(args: unknown): Record<string, unknown> | null {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null;
}

/** True when the call has no argument beyond the named ones. Empty values do not count. */
function onlyHas(args: Record<string, unknown>, allowed: string[]): boolean {
  return Object.entries(args).every(
    ([key, value]) =>
      allowed.includes(key) ||
      NEUTRAL.has(key) ||
      value === null ||
      value === '' ||
      value === false,
  );
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : null;
}

/** The equivalent statement for a tool call, or null when there is none to give. */
export function equivalentSql(tool: string, rawArgs: unknown): string | null {
  const args = record(rawArgs) ?? {};
  const provider = identifier(args.provider);
  const service = identifier(args.service);
  const resource = identifier(args.resource);

  switch (tool) {
    case 'list_providers':
      return onlyHas(args, []) ? 'SHOW PROVIDERS;' : null;
    case 'list_services':
      return provider && onlyHas(args, ['provider']) ? `SHOW SERVICES IN ${provider};` : null;
    case 'list_resources':
      return provider && service && onlyHas(args, ['provider', 'service'])
        ? `SHOW RESOURCES IN ${provider}.${service};`
        : null;
    case 'list_methods':
      return provider && service && resource && onlyHas(args, ['provider', 'service', 'resource'])
        ? `SHOW METHODS IN ${provider}.${service}.${resource};`
        : null;
    case 'list_registry':
      if (!onlyHas(args, ['provider'])) {
        return null;
      }
      if (args.provider === undefined || args.provider === null || args.provider === '') {
        return 'REGISTRY LIST;';
      }
      return provider ? `REGISTRY LIST ${provider};` : null;
    case 'pull_provider': {
      if (!provider || !onlyHas(args, ['provider', 'version'])) {
        return null;
      }
      if (args.version === undefined || args.version === null || args.version === '') {
        return `REGISTRY PULL ${provider};`;
      }
      return typeof args.version === 'string' && VERSION.test(args.version)
        ? `REGISTRY PULL ${provider} ${args.version};`
        : null;
    }
    default:
      return null;
  }
}
