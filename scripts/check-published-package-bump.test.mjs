import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
    checkPackageBump,
    createGitDeps,
    parseSourceDirs,
    loadTsconfig,
    main,
    npmIsPublished,
    parseJsonc,
    parsePublishedPackages,
    resolveBaseRef,
    resolveShippedScope,
} from './check-published-package-bump.mjs';

const tsconfig = { compilerOptions: { outDir: './dist', rootDir: './src' } };
const pkg = { dir: 'packages/http-client', name: '@scope/http-client' };

describe('parsePublishedPackages', () => {
    it('reads the deploy-service format', () => {
        assert.deepEqual(parsePublishedPackages('packages/http-client:@scope/http-client, packages/cli/:@scope/cli'), [
            { dir: 'packages/http-client', name: '@scope/http-client' },
            { dir: 'packages/cli', name: '@scope/cli' },
        ]);
    });

    it('accepts the repo root, as deploy-service does', () => {
        assert.deepEqual(parsePublishedPackages('.:@scope/pkg'), [{ dir: '.', name: '@scope/pkg' }]);
    });

    it('rejects entries without a name or with an escaping dir', () => {
        for (const value of ['packages/cli', ':@scope/cli', '../x:@scope/x', '/abs:@scope/x', 'packages/cli:']) {
            assert.throws(() => parsePublishedPackages(value), /dir:name/, value);
        }
    });
});

describe('parseSourceDirs', () => {
    it('groups source dirs by package dir', () => {
        assert.deepEqual(parseSourceDirs('packages/cli:src, packages/cli:./bin/,packages/http-client:lib'), new Map([
            ['packages/cli', ['src', 'bin']],
            ['packages/http-client', ['lib']],
        ]));
    });

    it('rejects a source dir that leaves the package', () => {
        assert.throws(() => parseSourceDirs('packages/cli:../other'), /inside the package/);
    });
});

describe('resolveBaseRef', () => {
    it('prefers the explicit input, then the PR base, then the merge group, then the push before', () => {
        assert.equal(resolveBaseRef({ baseRef: 'abc', prBase: 'def' }), 'abc');
        assert.equal(resolveBaseRef({ prBase: 'def', pushBefore: 'ghi' }), 'def');
        assert.equal(resolveBaseRef({ mergeGroupBase: 'mg', pushBefore: 'ghi' }), 'mg');
        assert.equal(resolveBaseRef({ pushBefore: 'ghi' }), 'ghi');
    });

    it('falls back to the previous commit for a new branch push', () => {
        assert.equal(resolveBaseRef({ pushBefore: '0000000000000000000000000000000000000000' }), 'HEAD~1');
        assert.equal(resolveBaseRef({}), 'HEAD~1');
    });
});

describe('resolveShippedScope', () => {
    it('ships pack files, package.json, and the rootDir behind a shipped outDir', () => {
        const inScope = resolveShippedScope({ packFiles: ['README.md'], files: ['dist', 'README.md'], tsconfig });
        assert.deepEqual(
            ['package.json', 'README.md', 'src/index.ts', 'test/a.test.ts', 'tsconfig.json', 'srcx'].filter(inScope),
            ['package.json', 'README.md', 'src/index.ts']
        );
    });

    it('does not ship rootDir when files omits the outDir', () => {
        const inScope = resolveShippedScope({ packFiles: ['README.md'], files: ['README.md'], tsconfig });
        assert.equal(inScope('src/index.ts'), false);
    });

    it('matches a files glob or file under the outDir', () => {
        for (const files of [['dist/**'], ['./dist/index.js'], ['**/*.js', '**/*.d.ts'], ['*.js']]) {
            assert.equal(resolveShippedScope({ packFiles: [], files, tsconfig })('src/index.ts'), true, files[0]);
        }
    });

    it('infers rootDir from a shared include root, else the whole package', () => {
        const scope = include =>
            resolveShippedScope({ packFiles: [], files: ['dist'], tsconfig: { compilerOptions: { outDir: 'dist' }, include } });
        assert.equal(scope(['src/**/*'])('src/a.ts'), true);
        assert.equal(scope(['src/**/*'])('test/a.ts'), false);
        assert.equal(scope(['src', 'lib'])('lib/a.ts'), true);
        assert.equal(scope(undefined)('other/a.ts'), true);
    });

    it('covers a nested outDir with a parent files entry', () => {
        const nested = { compilerOptions: { outDir: 'dist/esm', rootDir: 'src' } };
        for (const files of [['dist'], ['dist/**']]) {
            const inScope = resolveShippedScope({ packFiles: [], files, tsconfig: nested });
            assert.deepEqual(['src/a.ts', 'scripts/build.ts'].filter(inScope), ['src/a.ts'], files[0]);
        }
    });

    it('fails closed on unbuilt output with no tsconfig, as with bun build', () => {
        const inScope = resolveShippedScope({ packFiles: ['package.json'], files: ['dist'], tsconfig: null });
        assert.deepEqual(
            [
                'src/index.ts',
                'scripts/build.ts',
                'bunfig.toml',
                'test/index.test.ts',
                'src/__tests__/a.ts',
                'src/index.test.ts',
                'src/a.spec.ts',
                'fixtures/a.json',
                'test/fixtures/b.json',
            ].filter(inScope),
            ['src/index.ts', 'scripts/build.ts', 'bunfig.toml']
        );
    });

    it('fails closed when the outDir does not cover the unbuilt entry', () => {
        const inScope = resolveShippedScope({ packFiles: [], files: ['bin'], tsconfig });
        assert.deepEqual(['src/a.ts', 'cli/main.ts'].filter(inScope), ['src/a.ts', 'cli/main.ts']);
    });

    it('keeps rootDir when committed output sits under the outDir', () => {
        const inScope = resolveShippedScope({ packFiles: ['dist/types.d.ts'], files: ['dist'], tsconfig });
        assert.deepEqual(['src/a.ts', 'dist/types.d.ts', 'scripts/x.ts'].filter(inScope), ['src/a.ts', 'dist/types.d.ts']);
    });

    it('uses source_dirs instead of the fallback', () => {
        const inScope = resolveShippedScope({ packFiles: [], files: ['dist'], tsconfig: null, sourceDirs: ['src'] });
        assert.deepEqual(['src/index.ts', 'scripts/build.ts'].filter(inScope), ['src/index.ts']);
    });

    it('leaves built and literal entries to the pack list', () => {
        const inScope = resolveShippedScope({ packFiles: ['README.md', 'bin/cli.js'], files: ['README.md', 'bin', '*.md'], tsconfig: null });
        assert.deepEqual(['README.md', 'bin/cli.js', 'src/a.ts'].filter(inScope), ['README.md', 'bin/cli.js']);
    });

    it('treats a rootDir of . as the whole package', () => {
        const inScope = resolveShippedScope({
            packFiles: [],
            files: ['dist/'],
            tsconfig: { compilerOptions: { outDir: 'dist', rootDir: '.' } },
        });
        assert.equal(inScope('lib/a.ts'), true);
    });
});

describe('parseJsonc', () => {
    it('drops comments and trailing commas but keeps slashes inside strings', () => {
        assert.deepEqual(parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1,],\n}'), { a: 'http://x', b: [1] });
    });
});

describe('loadTsconfig', () => {
    it('inherits outDir and rootDir through relative extends, rebased onto the package', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'bump-tsconfig-'));
        await mkdir(path.join(root, 'packages/a'), { recursive: true });
        await writeFile(path.join(root, 'tsconfig.base.json'), '{ "compilerOptions": { "outDir": "./packages/a/dist", "rootDir": "./packages/a/src" } }');
        await writeFile(path.join(root, 'packages/a/tsconfig.json'), '{ "extends": "../../tsconfig.base", "include": ["src"] }');
        const packageDir = path.join(root, 'packages/a');
        assert.deepEqual(await loadTsconfig(packageDir, path.join(packageDir, 'tsconfig.json')), {
            compilerOptions: { outDir: 'dist', rootDir: 'src' },
            include: ['src'],
        });
        await rm(root, { recursive: true, force: true });
    });
});

describe('npmIsPublished', () => {
    const exec = result => async () => {
        if (result instanceof Error) {
            throw result;
        }
        return { stdout: result };
    };
    const failure = (stdout, stderr = '') => Object.assign(new Error('npm failed'), { stdout, stderr });

    it('reads a published version as published', async () => {
        assert.equal(await npmIsPublished('@scope/a', '1.0.0', exec('"1.0.0"\n')), true);
    });

    it('reads E404 as unpublished', async () => {
        assert.equal(await npmIsPublished('@scope/a', '1.0.0', exec(failure('{"error":{"code":"E404"}}'))), false);
    });

    it('fails closed on any other npm error', async () => {
        await assert.rejects(npmIsPublished('@scope/a', '1.0.0', exec(failure('{"error":{"code":"ETIMEDOUT"}}'))), /npm view/);
        await assert.rejects(npmIsPublished('@scope/a', '1.0.0', exec(failure('not json', 'boom'))), /boom/);
    });
});

describe('checkPackageBump', () => {
    const side = version => ({
        packageJson: { name: '@scope/http-client', version },
        files: ['dist', 'README.md'],
        tsconfig,
        packFiles: ['README.md', 'package.json'],
    });
    const deps = ({ head = side('1.2.3'), base = side('1.2.3'), changed = [], published = true } = {}) => ({
        readPackage: async which => (which === 'head' ? head : base),
        changedFiles: async () => changed,
        isPublished: async () => published,
    });

    it('fails when a shipped source file changed without a bump', async () => {
        assert.deepEqual(await checkPackageBump(pkg, deps({ changed: ['src/index.ts', 'test/a.test.ts'] })), {
            name: '@scope/http-client',
            status: 'changed',
            version: '1.2.3',
            files: ['src/index.ts'],
        });
    });

    it('fails when README.md changed without a bump', async () => {
        assert.equal((await checkPackageBump(pkg, deps({ changed: ['README.md'] }))).status, 'changed');
    });

    it('fails when a shipped file was deleted without a bump', async () => {
        const head = { ...side('1.2.3'), packFiles: ['package.json'] };
        assert.equal((await checkPackageBump(pkg, deps({ head, changed: ['README.md'] }))).status, 'changed');
    });

    it('passes when only unshipped files changed', async () => {
        const result = await checkPackageBump(pkg, deps({ changed: ['test/a.test.ts', 'tsconfig.json'] }));
        assert.deepEqual(result, { name: '@scope/http-client', status: 'unchanged', version: '1.2.3' });
    });

    it('passes when the version was bumped', async () => {
        const result = await checkPackageBump(pkg, deps({ head: side('1.2.4'), changed: ['src/index.ts'] }));
        assert.deepEqual(result, { name: '@scope/http-client', status: 'bumped', version: '1.2.4', baseVersion: '1.2.3' });
    });

    it('passes when the base version is not on npm yet', async () => {
        assert.equal((await checkPackageBump(pkg, deps({ changed: ['src/index.ts'], published: false }))).status, 'unreleased');
    });

    it('passes when the package is new in this change', async () => {
        assert.equal((await checkPackageBump(pkg, deps({ base: null }))).status, 'new');
    });

    it('rejects a dir with no package.json at head', async () => {
        await assert.rejects(checkPackageBump(pkg, deps({ head: null })), /does not exist/);
    });

    it('rejects a name that does not match package.json', async () => {
        await assert.rejects(checkPackageBump({ ...pkg, name: '@scope/typo' }, deps()), /is named @scope\/http-client/);
    });
});

describe('createGitDeps against a real repository', () => {
    let repo;
    let baseSha;
    const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const write = async (file, content) => {
        await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
        await writeFile(path.join(repo, file), content);
    };
    const packageJson = version =>
        JSON.stringify({ name: '@scope/http-client', version, files: ['dist', 'README.md'] });
    const check = async () => {
        const { deps, cleanup } = await createGitDeps({ repoRoot: repo, base: baseSha });
        try {
            return await checkPackageBump(pkg, { ...deps, isPublished: async () => true });
        } finally {
            await cleanup();
        }
    };

    before(async () => {
        repo = await mkdtemp(path.join(tmpdir(), 'bump-test-'));
        run('init', '-q', '-b', 'main');
        run('config', 'user.email', 'test@example.com');
        run('config', 'user.name', 'test');
        await write('packages/http-client/package.json', packageJson('1.0.0'));
        await write('packages/http-client/README.md', 'readme\n');
        await write('packages/http-client/tsconfig.json', '{ // jsonc\n "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },\n}\n');
        await write('packages/http-client/src/index.ts', 'export {};\n');
        await write('packages/http-client/test/index.test.ts', '\n');
        await write('.gitignore', 'dist/\n');
        run('add', '.');
        run('commit', '-q', '-m', 'base');
        baseSha = run('rev-parse', 'HEAD');
    });

    after(async () => {
        await rm(repo, { recursive: true, force: true });
    });

    it('ignores a test-only change', async () => {
        run('checkout', '-q', '-b', 'tests', baseSha);
        await write('packages/http-client/test/index.test.ts', 'changed\n');
        run('commit', '-q', '-am', 'tests');
        assert.equal((await check()).status, 'unchanged');
    });

    it('flags a source change without a bump', async () => {
        run('checkout', '-q', '-b', 'source', baseSha);
        await write('packages/http-client/src/index.ts', 'export const a = 1;\n');
        run('commit', '-q', '-am', 'source');
        assert.deepEqual((await check()).files, ['src/index.ts']);
    });

    it('flags a deleted README without a bump', async () => {
        run('checkout', '-q', '-b', 'delete', baseSha);
        run('rm', '-q', 'packages/http-client/README.md');
        run('commit', '-q', '-m', 'delete');
        assert.deepEqual((await check()).files, ['README.md']);
    });

    it('accepts a source change with a bump', async () => {
        run('checkout', '-q', '-b', 'bump', baseSha);
        await write('packages/http-client/src/index.ts', 'export const a = 1;\n');
        await write('packages/http-client/package.json', packageJson('1.0.1'));
        run('commit', '-q', '-am', 'bump');
        assert.equal((await check()).status, 'bumped');
    });

    it('compares against the merge-base, not the moving base tip', async () => {
        run('checkout', '-q', '-b', 'feature', baseSha);
        await write('packages/http-client/test/index.test.ts', 'feature\n');
        run('commit', '-q', '-am', 'feature');
        run('checkout', '-q', 'main');
        await write('packages/http-client/src/index.ts', 'export const onMain = 1;\n');
        run('commit', '-q', '-am', 'main moved');
        const mainTip = run('rev-parse', 'HEAD');
        run('checkout', '-q', 'feature');
        const { deps, cleanup } = await createGitDeps({ repoRoot: repo, base: mainTip });
        try {
            assert.equal((await checkPackageBump(pkg, { ...deps, isPublished: async () => true })).status, 'unchanged');
        } finally {
            await cleanup();
        }
        assert.equal(run('worktree', 'list').split('\n').length, 1, 'base worktree removed');
    });

    const runMain = async env => {
        const lines = [];
        const log = console.log;
        const error = console.error;
        console.log = console.error = line => lines.push(line);
        try {
            const code = await main(['--cwd', repo], { PUBLISHED_PACKAGES: 'packages/http-client:@scope/http-client', ...env });
            return { code, output: lines.join('\n') };
        } finally {
            console.log = log;
            console.error = error;
        }
    };

    it('uses the first parent of the PR merge ref, not a stale base sha', async () => {
        run('checkout', '-q', '-b', 'pr', baseSha);
        await write('packages/http-client/test/index.test.ts', 'pr\n');
        run('commit', '-q', '-am', 'pr');
        const prHead = run('rev-parse', 'HEAD');
        run('checkout', '-q', '--detach', 'main');
        run('merge', '-q', '--no-ff', '-m', 'merge ref', prHead);
        const { code, output } = await runMain({ PR_BASE_SHA: baseSha, PR_HEAD_SHA: prHead });
        assert.match(output, /base HEAD\^1/);
        assert.match(output, /no shipped file changed/);
        assert.equal(code, 0);
    });

    it('falls back to the previous commit when the push before sha is gone', async () => {
        const { output } = await runMain({ PUSH_BEFORE_SHA: 'deadbeef'.repeat(5) });
        assert.match(output, /base HEAD~1/);
    });
});

describe('a bun build package with no tsconfig', () => {
    it('flags a src edit and ignores a test edit', async () => {
        const repo = await mkdtemp(path.join(tmpdir(), 'bump-bun-'));
        const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
        const write = async (file, content) => {
            await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
            await writeFile(path.join(repo, file), content);
        };
        run('init', '-q', '-b', 'main');
        run('config', 'user.email', 'test@example.com');
        run('config', 'user.name', 'test');
        await write('.gitignore', 'dist/\n');
        await write(
            'packages/cli/package.json',
            JSON.stringify({
                name: '@scope/cli',
                version: '1.0.0',
                bin: { cli: './dist/cli.js' },
                files: ['dist'],
                scripts: { build: 'bun build src/cli.ts --outfile dist/cli.js' },
            })
        );
        await write('packages/cli/src/cli.ts', '\n');
        await write('packages/cli/test/cli.test.ts', '\n');
        run('add', '.');
        run('commit', '-q', '-m', 'base');
        const base = run('rev-parse', 'HEAD');
        await write('packages/cli/test/cli.test.ts', 'x\n');
        run('commit', '-q', '-am', 'test only');
        const testOnly = run('rev-parse', 'HEAD');
        await write('packages/cli/src/cli.ts', 'x\n');
        run('commit', '-q', '-am', 'src');
        const check = async from => {
            const { deps, cleanup } = await createGitDeps({ repoRoot: repo, base: from });
            try {
                return await checkPackageBump({ dir: 'packages/cli', name: '@scope/cli' }, { ...deps, isPublished: async () => true });
            } finally {
                await cleanup();
            }
        };
        try {
            assert.deepEqual((await check(testOnly)).files, ['src/cli.ts']);
            run('checkout', '-q', testOnly);
            assert.equal((await check(base)).status, 'unchanged');
        } finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});

describe('a root package', () => {
    it('diffs the whole repo and ignores unshipped files', async () => {
        const repo = await mkdtemp(path.join(tmpdir(), 'bump-root-'));
        const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
        run('init', '-q', '-b', 'main');
        run('config', 'user.email', 'test@example.com');
        run('config', 'user.name', 'test');
        await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: '@scope/root', version: '1.0.0', files: ['index.js'] }));
        await writeFile(path.join(repo, 'index.js'), '\n');
        await writeFile(path.join(repo, 'notes.md'), '\n');
        run('add', '.');
        run('commit', '-q', '-m', 'base');
        const base = run('rev-parse', 'HEAD');
        await writeFile(path.join(repo, 'notes.md'), 'x\n');
        await writeFile(path.join(repo, 'index.js'), 'x\n');
        run('commit', '-q', '-am', 'change');
        const { deps, cleanup } = await createGitDeps({ repoRoot: repo, base });
        try {
            const result = await checkPackageBump({ dir: '.', name: '@scope/root' }, { ...deps, isPublished: async () => true });
            assert.deepEqual(result.files, ['index.js']);
        } finally {
            await cleanup();
            await rm(repo, { recursive: true, force: true });
        }
    });
});
