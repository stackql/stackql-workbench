// A `stackql exec` command for a statement, written for the shell the
// operator will paste it into. The shapes were tested in Windows
// PowerShell 5.1, PowerShell 7 and a POSIX shell. See docs/spike-pgwire.md.

export type Shell = 'powershell' | 'posix';

export interface CliInput {
  /** The full path of the stackql binary. */
  binary: string;
  /** The engine's data folder, so the command sees the same providers. */
  approot: string | null;
  /** The credentials file from settings, when one is set. */
  envFile: string | null;
  sql: string;
}

const powershellQuote = (text: string) => `'${text.replace(/'/g, "''")}'`;
const posixQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

function flags(input: CliInput, quote: (text: string) => string): string {
  return [
    ...(input.approot ? [`--approot ${quote(input.approot)}`] : []),
    ...(input.envFile ? [`--env.file ${quote(input.envFile)}`] : []),
  ].join(' ');
}

const join = (parts: string[]) => parts.filter((part) => part !== '').join(' ');

/**
 * PowerShell. A statement goes in single quotes, after `--` so one that
 * starts with a comment is not read as a flag.
 *
 * The two PowerShell generations pass a double quote to a program in
 * different ways, and no one spelling works in both. A statement with a
 * double quote in it is therefore written to a temporary file from a
 * here-string, which both pass through untouched.
 */
function powershell(input: CliInput, sql: string): string {
  const program = `& ${powershellQuote(input.binary)} exec`;
  const options = flags(input, powershellQuote);
  // A line starting with '@ would end the here-string early.
  const fitsHereString = !/^'@/m.test(sql);
  if (!sql.includes('"') || !fitsHereString) {
    return join([program, options, '--', powershellQuote(sql)]);
  }
  return [
    '$query = New-TemporaryFile',
    "[IO.File]::WriteAllText($query.FullName, @'",
    sql,
    "'@)",
    join([program, options, '-i $query.FullName']),
    'Remove-Item $query',
  ].join('\n');
}

function posix(input: CliInput, sql: string): string {
  return join([
    `${posixQuote(input.binary)} exec`,
    flags(input, posixQuote),
    '--',
    posixQuote(sql),
  ]);
}

/** The command for `shell`. The statement is passed on exactly as written. */
export function execCommand(shell: Shell, input: CliInput): string {
  const sql = input.sql.trim();
  return shell === 'powershell' ? powershell(input, sql) : posix(input, sql);
}
