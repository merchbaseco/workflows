import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
    checkPackageBump,
    createGitDeps,
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

    it('rejects entries without a name or with an escaping dir', () => {
        for (const value of ['packages/cli', ':@scope/cli', '../x:@scope/x', '/abs:@scope/x', '.:@scope/x']) {
            assert.throws(() => parsePublishedPackages(value), /dir:name/, value);
        }
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

describe('checkPackageBump', () => {
    const side = version => ({
        packageJson: { version },
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
});
