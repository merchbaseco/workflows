#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ZERO_SHA = /^0+$/;

export const parsePublishedPackages = value =>
    value
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(entry => {
            const separator = entry.indexOf(':');
            const dir = separator === -1 ? '' : path.posix.normalize(entry.slice(0, separator)).replace(/\/$/, '');
            const name = separator === -1 ? '' : entry.slice(separator + 1);
            if (!dir || !name || dir === '.' || path.posix.isAbsolute(dir) || dir.split('/').includes('..')) {
                throw new Error(`published_packages entries must be dir:name with a relative dir, got ${entry}.`);
            }
            return { dir, name };
        });

export const resolveBaseRef = ({ baseRef, prBase, mergeGroupBase, pushBefore }) => {
    for (const candidate of [baseRef, prBase, mergeGroupBase, pushBefore]) {
        if (candidate && !ZERO_SHA.test(candidate)) {
            return candidate;
        }
    }
    return 'HEAD~1';
};

const stripDotSlash = entry => entry.replace(/^\.\//, '').replace(/\/+$/, '');

// npm pack only lists build output that exists, and CI has not built it. When "files"
// ships the tsconfig outDir, the rootDir that compiles into it is shipped source.
export const resolveShippedScope = ({ packFiles, files = [], tsconfig }) => {
    const exact = new Set(['package.json', ...packFiles]);
    const prefixes = [];
    const outDir = stripDotSlash(tsconfig?.compilerOptions?.outDir ?? '');
    const rootDir = stripDotSlash(tsconfig?.compilerOptions?.rootDir ?? '');
    if (outDir && rootDir && files.some(entry => stripDotSlash(entry) === outDir)) {
        prefixes.push(rootDir === '.' ? '' : `${rootDir}/`);
    }
    return file => exact.has(file) || prefixes.some(prefix => file.startsWith(prefix));
};

export const checkPackageBump = async ({ dir, name }, deps) => {
    const head = await deps.readPackage('head', dir);
    const base = await deps.readPackage('base', dir);
    if (!base) {
        return { name, status: 'new', version: head?.packageJson.version };
    }
    const changed = await deps.changedFiles(dir);
    const inHeadScope = head ? resolveShippedScope(head) : () => false;
    const inBaseScope = resolveShippedScope(base);
    const shippedChanged = changed.filter(file => inHeadScope(file) || inBaseScope(file));
    const baseVersion = base.packageJson.version;
    const headVersion = head?.packageJson.version;

    if (shippedChanged.length === 0) {
        return { name, status: 'unchanged', version: headVersion };
    }
    if (!head || headVersion !== baseVersion) {
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
            return `${result.name}: bumped ${result.baseVersion} -> ${result.version ?? 'removed'}.`;
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
    let tsconfig = null;
    try {
        tsconfig = parseJsonc(await readFile(path.join(packageDir, 'tsconfig.json'), 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw new Error(`${dir}/tsconfig.json: ${error.message}`);
        }
    }
    const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: packageDir,
        maxBuffer: 64 * 1024 * 1024,
    });
    const packFiles = JSON.parse(stdout)[0].files.map(file => file.path);
    return { packageJson, files: packageJson.files ?? [], tsconfig, packFiles };
};

export const npmIsPublished = async (name, version) => {
    let stdout;
    try {
        ({ stdout } = await execFileAsync('npm', ['view', `${name}@${version}`, 'version', '--json']));
    } catch (error) {
        if (JSON.parse(error.stdout || '{}').error?.code === 'E404') {
            return false;
        }
        throw new Error(`npm view ${name}@${version} failed: ${error.stderr || error.message}`);
    }
    return stdout.trim() !== '';
};

export const createGitDeps = async ({ repoRoot, base }) => {
    const mergeBase = (await git(repoRoot, ['merge-base', base, 'HEAD'])).trim();
    const baseRoot = await mkdtemp(path.join(tmpdir(), 'bump-base-'));
    await git(repoRoot, ['worktree', 'add', '--detach', baseRoot, mergeBase]);
    const roots = { head: repoRoot, base: baseRoot };
    return {
        mergeBase,
        deps: {
            readPackage: (side, dir) => readPackageAt(roots[side], dir),
            changedFiles: async dir => {
                const prefix = `${dir}/`;
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
        options: { packages: { type: 'string' }, base: { type: 'string' }, cwd: { type: 'string' } },
    });
    const packages = parsePublishedPackages(values.packages ?? env.PUBLISHED_PACKAGES ?? '');
    if (packages.length === 0) {
        throw new Error('published_packages is empty.');
    }
    const repoRoot = path.resolve(values.cwd ?? '.');
    const base = values.base || resolveBaseRef({
        baseRef: env.BASE_REF,
        prBase: env.PR_BASE_SHA,
        mergeGroupBase: env.MERGE_GROUP_BASE_SHA,
        pushBefore: env.PUSH_BEFORE_SHA,
    });
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
