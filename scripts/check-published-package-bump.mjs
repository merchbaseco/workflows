#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ZERO_SHA = /^0+$/;

const parseDirEntries = (value, label, valueName) =>
    value
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(entry => {
            const separator = entry.indexOf(':');
            const rawDir = separator === -1 ? '' : entry.slice(0, separator);
            const dir = rawDir && path.posix.normalize(rawDir).replace(/\/$/, '');
            const rest = separator === -1 ? '' : entry.slice(separator + 1);
            if (!dir || !rest || path.posix.isAbsolute(dir) || dir.split('/').includes('..')) {
                throw new Error(`${label} entries must be dir:${valueName} with a relative dir, got ${entry}.`);
            }
            return { dir, rest };
        });

export const parsePublishedPackages = value =>
    parseDirEntries(value, 'published_packages', 'name').map(({ dir, rest }) => ({ dir, name: rest }));

// "dir:src,dir:bin" names the source behind a package's unbuilt output, relative to dir.
export const parseSourceDirs = value => {
    const byDir = new Map();
    for (const { dir, rest } of parseDirEntries(value, 'source_dirs', 'path')) {
        const sourceDir = stripDotSlash(rest);
        if (path.posix.isAbsolute(sourceDir) || sourceDir.split('/').includes('..')) {
            throw new Error(`source_dirs paths must stay inside the package, got ${dir}:${rest}.`);
        }
        byDir.set(dir, [...(byDir.get(dir) ?? []), sourceDir]);
    }
    return byDir;
};

export const resolveBaseRef = ({ baseRef, prBase, mergeGroupBase, pushBefore }) => {
    for (const candidate of [baseRef, prBase, mergeGroupBase, pushBefore]) {
        if (candidate && !ZERO_SHA.test(candidate)) {
            return candidate;
        }
    }
    return 'HEAD~1';
};

const stripDotSlash = entry => path.posix.normalize(entry).replace(/^\.\//, '').replace(/\/+$/, '');

// Without rootDir, tsc uses the common root of its inputs. A shared first include
// segment ("src/**/*") stands in for it. Otherwise the whole package counts as source.
const inferRootDir = include => {
    const roots = new Set((include ?? []).map(entry => stripDotSlash(entry).split('/')[0]));
    const [root] = roots;
    return roots.size === 1 && root && !root.includes('*') ? root : '.';
};

const GLOB_CHARS = /[*?[\]{}!]/;
const NOT_SHIPPED = /(^|\/)(test|tests|__tests__|__mocks__|fixtures|__fixtures__)\/|\.(test|spec)\.[^/]+$/;

// "**" spans directories, "*" and "?" stay inside one. Brackets, braces, and
// negation return null so callers can take the conservative branch.
const globToRegExp = glob => {
    if (/[[\]{}!]/.test(glob)) {
        return null;
    }
    const tokens = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' };
    const source = glob
        .split(/(\*\*\/?|\*|\?)/)
        .map(part => tokens[part] ?? part.replace(/[.+^$()|\\]/g, '\\$&'))
        .join('');
    return new RegExp(`^${source}(?:/.*)?$`);
};

// An entry with nothing behind it in the pack list is build output CI has not built.
const isUnbuilt = (entry, packFiles) => {
    if (!GLOB_CHARS.test(entry)) {
        return !packFiles.some(file => file === entry || file.startsWith(`${entry}/`));
    }
    const pattern = globToRegExp(entry);
    return !pattern || !packFiles.some(file => pattern.test(file));
};

const coversOutDir = (entry, outDir) => {
    if (!outDir || outDir === '.') {
        return false;
    }
    if (!GLOB_CHARS.test(entry)) {
        return entry === outDir || entry.startsWith(`${outDir}/`) || outDir.startsWith(`${entry}/`);
    }
    const pattern = globToRegExp(entry);
    return !pattern || pattern.test(`${outDir}/index.js`) || pattern.test(`${outDir}/index.d.ts`);
};

const prefixFor = dir => (dir === '.' ? '' : `${dir}/`);

// npm pack only lists build output that exists, and CI has not built it. Each unbuilt
// "files" entry maps to the source behind it: sourceDirs when the caller names them,
// the tsconfig rootDir when its outDir covers the entry, else the whole package
// minus tests and fixtures, so an unknown build fails closed.
export const resolveShippedScope = ({ packFiles, files = [], tsconfig, sourceDirs = [] }) => {
    const exact = new Set(['package.json', ...packFiles]);
    const prefixes = new Set();
    const outDir = stripDotSlash(tsconfig?.compilerOptions?.outDir ?? '');
    for (const entry of files.map(stripDotSlash).filter(entry => isUnbuilt(entry, packFiles))) {
        if (sourceDirs.length > 0) {
            sourceDirs.forEach(sourceDir => prefixes.add(prefixFor(sourceDir)));
        } else if (coversOutDir(entry, outDir)) {
            prefixes.add(prefixFor(stripDotSlash(tsconfig.compilerOptions.rootDir ?? inferRootDir(tsconfig.include))));
        } else {
            prefixes.add('');
        }
    }
    return file =>
        exact.has(file) ||
        [...prefixes].some(prefix => file.startsWith(prefix) && !NOT_SHIPPED.test(file.slice(prefix.length)));
};

export const checkPackageBump = async ({ dir, name, sourceDirs = [] }, deps) => {
    const head = await deps.readPackage('head', dir);
    if (!head) {
        throw new Error(`${dir}/package.json does not exist. Update published_packages.`);
    }
    if (head.packageJson.name !== name) {
        throw new Error(`${dir}/package.json is named ${head.packageJson.name}, but published_packages says ${name}.`);
    }
    const base = await deps.readPackage('base', dir);
    if (!base) {
        return { name, status: 'new', version: head?.packageJson.version };
    }
    const changed = await deps.changedFiles(dir);
    const inHeadScope = resolveShippedScope({ ...head, sourceDirs });
    const inBaseScope = resolveShippedScope({ ...base, sourceDirs });
    const shippedChanged = changed.filter(file => inHeadScope(file) || inBaseScope(file));
    const baseVersion = base.packageJson.version;
    const headVersion = head.packageJson.version;

    if (shippedChanged.length === 0) {
        return { name, status: 'unchanged', version: headVersion };
    }
    if (headVersion !== baseVersion) {
        return { name, status: 'bumped', version: headVersion, baseVersion };
    }
    if (!(await deps.isPublished(name, baseVersion))) {
        return { name, status: 'unreleased', version: baseVersion };
    }
    return { name, status: 'changed', version: baseVersion, files: shippedChanged };
};

const describe = result => {
    switch (result.status) {
        case 'new':
            return `${result.name}: not in the base commit.`;
        case 'unchanged':
            return `${result.name}@${result.version}: no shipped file changed.`;
        case 'bumped':
            return `${result.name}: bumped ${result.baseVersion} -> ${result.version}.`;
        case 'unreleased':
            return `${result.name}@${result.version}: not on npm yet, so the next publish carries this change.`;
        default:
            return `${result.name}@${result.version}: shipped files changed without a version bump.`;
    }
};

const git = async (cwd, args) => (await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;

// tsconfig.json is JSONC. Drop comments outside strings and trailing commas.
export const parseJsonc = text =>
    JSON.parse(
        text
            .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '')
            .replace(/,(\s*[}\]])/g, '$1')
    );

// Follows relative "extends" and rebases outDir, rootDir, and include onto the package dir.
export const loadTsconfig = async (packageDir, file, seen = new Set()) => {
    let config;
    try {
        config = parseJsonc(await readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' && seen.size === 0) {
            return null;
        }
        throw new Error(`${path.relative(packageDir, file) || file}: ${error.message}`);
    }
    seen.add(file);
    const rebase = value => path.relative(packageDir, path.resolve(path.dirname(file), value)) || '.';
    const own = {
        compilerOptions: Object.fromEntries(
            ['outDir', 'rootDir']
                .filter(key => typeof config.compilerOptions?.[key] === 'string')
                .map(key => [key, rebase(config.compilerOptions[key])])
        ),
        include: Array.isArray(config.include) ? config.include.map(rebase) : undefined,
    };
    const parents = [config.extends ?? []]
        .flat()
        .filter(entry => entry.startsWith('.'))
        .map(entry => path.resolve(path.dirname(file), entry.endsWith('.json') ? entry : `${entry}.json`))
        .filter(parent => !seen.has(parent));
    let merged = { compilerOptions: {} };
    for (const parent of parents) {
        const inherited = await loadTsconfig(packageDir, parent, seen);
        merged = {
            compilerOptions: { ...merged.compilerOptions, ...inherited.compilerOptions },
            include: inherited.include ?? merged.include,
        };
    }
    return {
        compilerOptions: { ...merged.compilerOptions, ...own.compilerOptions },
        include: own.include ?? merged.include,
    };
};

const readPackageAt = async (root, dir) => {
    const packageDir = path.join(root, dir);
    let packageJson;
    try {
        packageJson = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    const tsconfig = await loadTsconfig(packageDir, path.join(packageDir, 'tsconfig.json'));
    const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: packageDir,
        maxBuffer: 64 * 1024 * 1024,
    });
    const packFiles = JSON.parse(stdout)[0].files.map(file => file.path);
    return { packageJson, files: packageJson.files ?? [], tsconfig, packFiles };
};

const errorCode = stdout => {
    try {
        return JSON.parse(stdout || '{}').error?.code;
    } catch {
        return undefined;
    }
};

export const npmIsPublished = async (name, version, exec = execFileAsync) => {
    let stdout;
    try {
        ({ stdout } = await exec('npm', ['view', `${name}@${version}`, 'version', '--json']));
    } catch (error) {
        if (errorCode(error.stdout) === 'E404') {
            return false;
        }
        throw new Error(`npm view ${name}@${version} failed: ${error.stderr || error.message}`);
    }
    return stdout.trim() !== '';
};

const commitExists = async (repoRoot, ref) =>
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(
        () => true,
        () => false
    );

// actions/checkout builds a PR's merge ref on the current base tip, which can be newer
// than pull_request.base.sha, so the merge's first parent is the exact base. A push
// whose before commit is gone (force-push) falls back to the previous commit.
const resolveCheckedOutBase = async (repoRoot, env) => {
    if (!env.BASE_REF && env.PR_BASE_SHA && env.PR_HEAD_SHA) {
        const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ');
        if (parents.length === 3 && parents[2] === env.PR_HEAD_SHA) {
            return 'HEAD^1';
        }
    }
    const base = resolveBaseRef({
        baseRef: env.BASE_REF,
        prBase: env.PR_BASE_SHA,
        mergeGroupBase: env.MERGE_GROUP_BASE_SHA,
        pushBefore: env.PUSH_BEFORE_SHA,
    });
    if (base === env.PUSH_BEFORE_SHA && !(await commitExists(repoRoot, base))) {
        return 'HEAD~1';
    }
    return base;
};

export const createGitDeps = async ({ repoRoot, base }) => {
    const mergeBase = (await git(repoRoot, ['merge-base', base, 'HEAD'])).trim();
    const baseRoot = await mkdtemp(path.join(tmpdir(), 'bump-base-'));
    await git(repoRoot, ['worktree', 'add', '--detach', baseRoot, mergeBase]).catch(async error => {
        await rm(baseRoot, { recursive: true, force: true });
        throw error;
    });
    const roots = { head: repoRoot, base: baseRoot };
    return {
        mergeBase,
        deps: {
            readPackage: (side, dir) => readPackageAt(roots[side], dir),
            changedFiles: async dir => {
                const prefix = dir === '.' ? '' : `${dir}/`;
                const output = await git(repoRoot, ['diff', '--name-only', '--no-renames', '-z', mergeBase, 'HEAD', '--', dir]);
                return output
                    .split('\0')
                    .filter(file => file.startsWith(prefix))
                    .map(file => file.slice(prefix.length));
            },
            isPublished: npmIsPublished,
        },
        cleanup: async () => {
            await git(repoRoot, ['worktree', 'remove', '--force', baseRoot]).catch(() => rm(baseRoot, { recursive: true, force: true }));
        },
    };
};

export const main = async (argv = process.argv.slice(2), env = process.env) => {
    const { values } = parseArgs({
        args: argv,
        options: {
            packages: { type: 'string' },
            'source-dirs': { type: 'string' },
            base: { type: 'string' },
            cwd: { type: 'string' },
        },
    });
    const sourceDirs = parseSourceDirs(values['source-dirs'] ?? env.SOURCE_DIRS ?? '');
    const packages = parsePublishedPackages(values.packages ?? env.PUBLISHED_PACKAGES ?? '').map(pkg => ({
        ...pkg,
        sourceDirs: sourceDirs.get(pkg.dir) ?? [],
    }));
    const unknown = [...sourceDirs.keys()].filter(dir => !packages.some(pkg => pkg.dir === dir));
    if (unknown.length > 0) {
        throw new Error(`source_dirs names dirs that are not in published_packages: ${unknown.join(', ')}.`);
    }
    if (packages.length === 0) {
        throw new Error('published_packages is empty.');
    }
    const repoRoot = path.resolve(values.cwd ?? '.');
    const base = values.base || (await resolveCheckedOutBase(repoRoot, env));
    const { mergeBase, deps, cleanup } = await createGitDeps({ repoRoot, base });
    console.log(`Comparing HEAD against merge-base ${mergeBase} (base ${base}).`);
    let results;
    try {
        results = [];
        for (const pkg of packages) {
            results.push(await checkPackageBump(pkg, deps));
        }
    } finally {
        await cleanup();
    }
    for (const result of results) {
        (result.status === 'changed' ? console.error : console.log)(describe(result));
        for (const file of result.files ?? []) {
            console.error(`  - ${file}`);
        }
    }
    if (results.some(result => result.status === 'changed')) {
        console.error('Bump the version of each package above (and its changelog) in this change.');
        return 1;
    }
    console.log('Published-package version bump check passed.');
    return 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main().catch(error => {
        console.error(`check-published-package-bump: ${error.message}`);
        return 1;
    });
}
