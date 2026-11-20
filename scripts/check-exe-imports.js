// Lists the libraries a Windows executable asks the system for, and fails
// when one of them is a runtime the executable should carry inside it.
//
//   node scripts/check-exe-imports.js <path to the .exe> [x64 | arm64]
//
// With a processor named, it also fails when the executable is built for
// another one. The MSI comes for x64 and for arm64, and a build on the wrong
// toolchain would otherwise pass for the right one.
//
// The executable is shipped on its own, beside stackql.exe. It must not need
// a C runtime, or any other library, that has to be installed or copied next
// to it. That includes the Universal C runtime: Windows 10 and later have
// it, but it is a runtime all the same, and the build links it in. This
// reads the import tables of the file, both the ordinary one and the one for
// libraries loaded on first use, so it reports what the loader will really
// be asked for and not what happens to be spelled in the file.
//
// The page renderer, WebView2, is not found this way. The executable does
// not link to it: it finds a runtime when it starts. See README.md, "What the
// installers take".

import fs from 'node:fs';
import process from 'node:process';

/**
 * Libraries the executable must not lean on: the C runtime in its several
 * forms, and the WebView2 loader. Everything else it imports is Windows.
 */
const RUNTIME_LIBRARIES = [
  /^api-ms-win-crt-/i,
  /^ucrtbase/i,
  /^vcruntime/i,
  /^msvcp/i,
  /^msvcr/i,
  /^vcomp/i,
  /^concrt/i,
  /^webview2loader/i,
];

/** The processors a PE file can name, by the names the builds go by. */
const PROCESSORS = new Map([
  [0x8664, 'x64'],
  [0xaa64, 'arm64'],
  [0x014c, 'x86'],
]);

/**
 * The processor a PE file is built for.
 *
 * @param {Buffer} file The whole executable.
 * @returns {string}
 */
export function builtFor(file) {
  const pe = file.readUInt32LE(0x3c);
  if (file.toString('latin1', pe, pe + 4) !== 'PE\0\0') {
    throw new Error('Not a Windows executable.');
  }
  const machine = file.readUInt16LE(pe + 4);
  return PROCESSORS.get(machine) ?? `machine 0x${machine.toString(16)}`;
}

/**
 * The names in the import tables of a PE file, in the order they appear.
 *
 * @param {Buffer} file The whole executable.
 * @returns {string[]}
 */
export function importedLibraries(file) {
  const pe = file.readUInt32LE(0x3c);
  if (file.toString('latin1', pe, pe + 4) !== 'PE\0\0') {
    throw new Error('Not a Windows executable.');
  }
  const coff = pe + 4;
  const sectionCount = file.readUInt16LE(coff + 2);
  const optional = coff + 20;
  const optionalSize = file.readUInt16LE(coff + 16);
  const magic = file.readUInt16LE(optional);
  // Where the table of directories starts depends on whether it is 64-bit.
  const directories = optional + (magic === 0x20b ? 112 : 96);

  /** @type {{ virtualSize: number, virtualAddress: number, rawSize: number, rawOffset: number }[]} */
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const at = optional + optionalSize + index * 40;
    sections.push({
      virtualSize: file.readUInt32LE(at + 8),
      virtualAddress: file.readUInt32LE(at + 12),
      rawSize: file.readUInt32LE(at + 16),
      rawOffset: file.readUInt32LE(at + 20),
    });
  }

  /**
   * Where an address in the loaded image is in the file.
   *
   * @param {number} rva
   * @returns {number | null}
   */
  const offsetOf = (rva) => {
    for (const section of sections) {
      const size = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
        return rva - section.virtualAddress + section.rawOffset;
      }
    }
    return null;
  };

  /**
   * The text that starts at an address and runs to the next zero byte.
   *
   * @param {number} rva
   * @returns {string | null}
   */
  const textAt = (rva) => {
    const start = offsetOf(rva);
    if (start === null) {
      return null;
    }
    let end = start;
    while (end < file.length && file[end] !== 0) {
      end += 1;
    }
    return file.toString('latin1', start, end);
  };

  /** @type {string[]} */
  const names = [];
  // The second directory is the import table and the fourteenth the table
  // of libraries loaded on first use. Each is a list of entries of a fixed
  // size, ended by an empty one, with the library's name at a known place.
  const tables = [
    { directory: 1, entrySize: 20, nameAt: 12 },
    { directory: 13, entrySize: 32, nameAt: 4 },
  ];
  for (const table of tables) {
    const rva = file.readUInt32LE(directories + table.directory * 8);
    const start = rva === 0 ? null : offsetOf(rva);
    if (start === null) {
      continue;
    }
    for (let at = start; at + table.entrySize <= file.length; at += table.entrySize) {
      const nameRva = file.readUInt32LE(at + table.nameAt);
      if (nameRva === 0) {
        break;
      }
      const name = textAt(nameRva);
      if (name) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * The imported libraries that are a runtime and not Windows itself.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function runtimeLibraries(names) {
  return names.filter((name) => RUNTIME_LIBRARIES.some((pattern) => pattern.test(name)));
}

/**
 * @param {string[]} items
 * @returns {string}
 */
const list = (items) => `${items.map((name) => `  ${name}`).join('\n')}\n`;

const target = process.argv[2];
const expected = process.argv[3];
if (target) {
  const file = fs.readFileSync(target);
  const processor = builtFor(file);
  process.stdout.write(`${target} is built for ${processor}.\n`);
  if (expected && expected !== processor) {
    process.stderr.write(`It should be built for ${expected}.\n`);
    process.exit(1);
  }
  const names = importedLibraries(file);
  const sorted = [...new Set(names.map((name) => name.toLowerCase()))].sort();
  process.stdout.write(`${target} asks the system for ${sorted.length} libraries:\n`);
  process.stdout.write(list(sorted));
  const runtime = runtimeLibraries(sorted);
  if (runtime.length > 0) {
    process.stderr.write('\nThese are a runtime the executable should carry inside it:\n');
    process.stderr.write(list(runtime));
    process.exit(1);
  }
  process.stdout.write('\nNone of them is a runtime. All are Windows itself.\n');
}
