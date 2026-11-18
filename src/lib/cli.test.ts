import { describe, expect, it } from 'vitest';
import { execCommand, type CliInput } from './cli';

const windows: CliInput = {
  binary: 'C:\\Program Files\\StackQL\\stackql.exe',
  approot: 'C:\\Users\\me\\.stackql',
  envFile: null,
  sql: "SELECT login FROM github.orgs.orgs WHERE org = 'stackql';",
};

const mac: CliInput = {
  binary: '/usr/local/bin/stackql',
  approot: '/Users/me/Library/Application Support/io.stackql.workbench/engine',
  envFile: '/Users/me/.stackql.env',
  sql: "SELECT login FROM github.orgs.orgs WHERE org = 'stackql';",
};

describe('execCommand for PowerShell', () => {
  it('puts the statement in single quotes, with its own quotes doubled', () => {
    expect(execCommand('powershell', windows)).toBe(
      "& 'C:\\Program Files\\StackQL\\stackql.exe' exec --approot 'C:\\Users\\me\\.stackql' -- 'SELECT login FROM github.orgs.orgs WHERE org = ''stackql'';'",
    );
  });

  it('keeps a statement of several lines, comments included, as it is', () => {
    const sql = "-- repositories\nSELECT name\nFROM github.repos.repos\nWHERE org = 'stackql';";
    expect(execCommand('powershell', { ...windows, sql })).toBe(
      "& 'C:\\Program Files\\StackQL\\stackql.exe' exec --approot 'C:\\Users\\me\\.stackql' -- '-- repositories\nSELECT name\nFROM github.repos.repos\nWHERE org = ''stackql'';'",
    );
  });

  it('goes through a temporary file when the statement holds a double quote', () => {
    const sql = 'SELECT "name" FROM github.repos.repos WHERE org = \'stackql\';';
    expect(execCommand('powershell', { ...windows, sql })).toBe(
      [
        '$query = New-TemporaryFile',
        "[IO.File]::WriteAllText($query.FullName, @'",
        sql,
        "'@)",
        "& 'C:\\Program Files\\StackQL\\stackql.exe' exec --approot 'C:\\Users\\me\\.stackql' -i $query.FullName",
        'Remove-Item $query',
      ].join('\n'),
    );
  });

  it('does not use a here-string that the statement would end early', () => {
    const sql = 'SELECT "a"\n\'@ FROM x;';
    expect(execCommand('powershell', { ...windows, sql })).not.toContain('New-TemporaryFile');
  });

  it('names the credentials file when there is one, and leaves out what is not set', () => {
    expect(
      execCommand('powershell', {
        ...windows,
        envFile: "C:\\it's here\\.env",
        sql: 'SHOW PROVIDERS;',
      }),
    ).toBe(
      "& 'C:\\Program Files\\StackQL\\stackql.exe' exec --approot 'C:\\Users\\me\\.stackql' --env.file 'C:\\it''s here\\.env' -- 'SHOW PROVIDERS;'",
    );
    expect(execCommand('powershell', { ...windows, approot: null, sql: ' SHOW PROVIDERS; ' })).toBe(
      "& 'C:\\Program Files\\StackQL\\stackql.exe' exec -- 'SHOW PROVIDERS;'",
    );
  });
});

describe('execCommand for a POSIX shell', () => {
  it('puts every part in single quotes and closes them around a quote', () => {
    expect(execCommand('posix', mac)).toBe(
      "'/usr/local/bin/stackql' exec --approot '/Users/me/Library/Application Support/io.stackql.workbench/engine' --env.file '/Users/me/.stackql.env' -- 'SELECT login FROM github.orgs.orgs WHERE org = '\\''stackql'\\'';'",
    );
  });

  it('passes double quotes, dollars and backticks through untouched', () => {
    const sql = 'SELECT "name", \'$HOME\', `x` FROM t;';
    expect(execCommand('posix', { ...mac, approot: null, envFile: null, sql })).toBe(
      "'/usr/local/bin/stackql' exec -- 'SELECT \"name\", '\\''$HOME'\\'', `x` FROM t;'",
    );
  });
});
