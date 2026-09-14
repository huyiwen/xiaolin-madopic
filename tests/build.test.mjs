import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build, resolveCommit } from '../scripts/build.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(resolve(tmpdir(), 'madopic-build-'));

try {
    const deployedCommit = 'abc1234' + '0'.repeat(33);
    await build({ outputDirectory: directory, env: { VERCEL_GIT_COMMIT_SHA: deployedCommit } });
    let html = await readFile(resolve(directory, 'index.html'), 'utf8');
    assert.ok(html.includes(`href="https://github.com/huyiwen/xiaolin-madopic/commit/${deployedCommit}"`));
    assert.ok(html.includes('<span>abc1234</span>'));
    assert.ok(html.includes(`title="查看当前版本提交：${deployedCommit}"`));
    assert.ok(!html.includes('本地开发'));
    for (const asset of ['style.css', 'script.js', 'documents.js']) {
        assert.ok(html.includes(`${asset}?v=${deployedCommit}`), 'deployed assets must share the build version');
        assert.equal(await readFile(resolve(directory, asset), 'utf8'), await readFile(resolve(root, asset), 'utf8'));
    }
    for (const file of ['favicon.svg', 'manifest.json', 'robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt', 'index.md']) {
        assert.deepEqual(await readFile(resolve(directory, file)), await readFile(resolve(root, file)));
    }
    const outputFiles = await readdir(directory);
    assert.equal(outputFiles.length, 11, 'only public site assets should be deployed');

    // 本地构建绑定 HEAD，重复构建和回滚均覆盖上一次注入的版本。
    const localCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    await build({ outputDirectory: directory, env: {} });
    html = await readFile(resolve(directory, 'index.html'), 'utf8');
    assert.ok(html.includes(`/commit/${localCommit}`));
    assert.ok(html.includes(`<span>${localCommit.slice(0, 7)}</span>`));
    assert.ok(!html.includes(deployedCommit));
    assert.throws(() => resolveCommit({ VERCEL_GIT_COMMIT_SHA: 'invalid"<commit>' }), /有效的/);

    const config = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf8'));
    assert.equal(config.buildCommand, 'npm run build');
    assert.equal(config.outputDirectory, 'dist');
} finally {
    await rm(directory, { recursive: true, force: true });
}
