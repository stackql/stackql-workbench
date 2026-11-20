// Checks that a release tag is the version the app carries.
//
//   node scripts/check-release-tag.js <tag>
//
// A release is made from a tag, and its files are built from the commit the
// tag names. The app's own version is in src-tauri/tauri.conf.json, with a
// copy in src-tauri/Cargo.toml and one in package.json. The tag for version
// 1.2.3 is v1.2.3. This fails when the tag is anything else, or when the
// three files disagree, so a release never holds an app that calls itself by
// another version.

import fs from 'node:fs';
import process from 'node:process';

/**
 * The tag a version is released under.
 *
 * @param {string} version
 * @returns {string}
 */
export function tagFor(version) {
  return `v${version}`;
}

/**
 * The version in a Cargo.toml: the first `version = "..."` line, which is
 * the one of the package.
 *
 * @param {string} toml
 * @returns {string | null}
 */
export function cargoVersion(toml) {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(toml);
  return match ? match[1] : null;
}

/**
 * What is wrong with a tag, given the versions the three files hold. An
 * empty list means nothing is.
 *
 * @param {string} tag
 * @param {{ tauri: string | null, cargo: string | null, npm: string | null }} versions
 * @returns {string[]}
 */
export function problems(tag, versions) {
  /** @type {string[]} */
  const found = [];
  if (!versions.tauri) {
    return ['src-tauri/tauri.conf.json holds no version.'];
  }
  if (versions.cargo !== versions.tauri) {
    found.push(
      `src-tauri/Cargo.toml says ${versions.cargo ?? 'nothing'} and src-tauri/tauri.conf.json says ${versions.tauri}.`,
    );
  }
  if (versions.npm !== versions.tauri) {
    found.push(
      `package.json says ${versions.npm ?? 'nothing'} and src-tauri/tauri.conf.json says ${versions.tauri}.`,
    );
  }
  if (tag !== tagFor(versions.tauri)) {
    found.push(
      `The tag is ${tag} and the app is version ${versions.tauri}. Release it as ${tagFor(versions.tauri)}, or set the version first.`,
    );
  }
  return found;
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function jsonVersion(path) {
  /** @type {unknown} */
  const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
    return typeof parsed.version === 'string' ? parsed.version : null;
  }
  return null;
}

const tag = process.argv[2];
if (tag) {
  const versions = {
    tauri: jsonVersion('src-tauri/tauri.conf.json'),
    cargo: cargoVersion(fs.readFileSync('src-tauri/Cargo.toml', 'utf8')),
    npm: jsonVersion('package.json'),
  };
  const found = problems(tag, versions);
  if (found.length > 0) {
    process.stderr.write(`${found.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`${tag} is the version the app carries, ${versions.tauri ?? ''}.\n`);
}
