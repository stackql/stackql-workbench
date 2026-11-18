// Statement templates for a resource or a method, built from what the
// engine says about the method's inputs and outputs. They are opened in
// the editor for the operator to fill in. Nothing here runs anything, and
// nothing here decides what a statement does.
//
// The shapes follow the engine's own guidance on its dialect.

import type { Method, MethodField } from '../host/types';
import type { NodePath } from './explorerTree';

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name as it is written in a statement: bare when plain, quoted when not. */
export function ident(name: string): string {
  return PLAIN.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** `provider.service.resource`, each part written as an identifier. */
export function tableName(path: NodePath): string {
  return [path.provider, path.service, path.resource]
    .filter((part): part is string => part !== undefined)
    .map(ident)
    .join('.');
}

const isInput = (field: MethodField) => field.paramType.startsWith('input');
const isRequired = (field: MethodField) => field.paramType === 'input_required';
const UNQUOTED = new Set(['integer', 'number', 'boolean', 'int', 'bigint', 'float', 'double']);

/** What stands in for a value the operator has to supply. */
function placeholder(field: MethodField): string {
  const mark = `<${field.name}>`;
  return UNQUOTED.has(field.type.toLowerCase()) ? mark : `'${mark}'`;
}

function whereClause(fields: MethodField[]): string {
  return fields
    .map(
      (field, index) =>
        `${index === 0 ? 'WHERE' : '  AND'} ${ident(field.name)} = ${placeholder(field)}`,
    )
    .join('\n');
}

/**
 * The SELECT method a statement on the resource is most likely to route
 * to: the one that needs the fewest parameters. Null when there is none.
 */
export function pickSelectMethod(methods: Method[]): Method | null {
  const selects = methods.filter((method) => method.sqlVerb.toUpperCase() === 'SELECT');
  selects.sort(
    (a, b) => a.requiredParams.length - b.requiredParams.length || a.name.localeCompare(b.name),
  );
  return selects[0] ?? null;
}

/**
 * A comment naming the SELECT methods that were not picked, with what each
 * needs, so the operator can see the other ways to read the resource.
 * Empty when there is no other.
 */
export function otherSelectMethods(methods: Method[], picked: Method): string {
  const others = methods
    .filter((method) => method.sqlVerb.toUpperCase() === 'SELECT' && method.name !== picked.name)
    .map((method) =>
      method.requiredParams.length > 0
        ? `${method.name} (${method.requiredParams.join(', ')})`
        : method.name,
    );
  return others.length > 0
    ? `-- Other SELECT methods, with what each requires: ${others.join('; ')}.`
    : '';
}

/**
 * A statement template for one method. `verb` is the SQL verb the engine
 * reports for it. Values to fill in are written as `<name>`. `note` is a
 * comment line to put under the first one.
 */
export function generateStatement(
  path: NodePath,
  verb: string,
  method: string,
  fields: MethodField[],
  note = '',
): string {
  const table = tableName(path);
  const inputs = fields.filter(isInput);
  const required = inputs.filter(isRequired);
  const optional = inputs.filter((field) => !isRequired(field));
  const outputs = fields.filter((field) => !isInput(field));
  const upper = verb.toUpperCase();
  const lines = (items: string[]) => items.map((item) => `  ${item}`).join(',\n');
  const where = required.length > 0 ? `\n${whereClause(required)}` : '';

  const body = (): string => {
    switch (upper) {
      case 'SELECT': {
        const columns = outputs.length > 0 ? lines(outputs.map((f) => ident(f.name))) : '  *';
        return `SELECT\n${columns}\nFROM ${table}${where};`;
      }
      case 'INSERT': {
        // With nothing required, list what can be set and let the operator trim.
        const set = required.length > 0 ? required : inputs;
        if (set.length === 0) {
          return `INSERT INTO ${table} (\n  <field>\n)\nSELECT\n  '<value>';`;
        }
        return `INSERT INTO ${table} (\n${lines(set.map((f) => ident(f.name)))}\n)\nSELECT\n${lines(set.map(placeholder))};`;
      }
      case 'UPDATE':
      case 'REPLACE': {
        const set =
          optional.length > 0
            ? lines(optional.map((f) => `${ident(f.name)} = ${placeholder(f)}`))
            : "  <field> = '<value>'";
        return `-- Keep only the fields to change in SET.\n${upper} ${table}\nSET\n${set}${where};`;
      }
      case 'DELETE':
        return `DELETE FROM ${table}${where};`;
      case 'EXEC': {
        const args =
          required.length > 0
            ? `\n${lines(required.map((f) => `@${ident(f.name)} = ${placeholder(f)}`))}`
            : '';
        return `EXEC ${table}.${ident(method)}${args};`;
      }
      default:
        return `-- There is no template for the verb ${upper}.`;
    }
  };

  const statement = body();
  const fill = /<[^>\s]+>/.test(statement) ? ' Fill in each <placeholder> before running.' : '';
  const first = `-- ${table}, method ${method} (${upper}).${fill}`;
  return `${note === '' ? first : `${first}\n${note}`}\n${statement}\n`;
}
