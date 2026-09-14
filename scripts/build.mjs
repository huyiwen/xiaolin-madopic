import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'https://github.com/huyiwen/xiaolin-madopic';
const publicAssets = [
    'style.css', 'script.js', 'documents.js', 'favicon.svg', 'manifest.json',
    'robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt', 'index.md'
];

export function resolveCommit(env = process.env) {
    // Vercel 的构建环境不一定包含 .git；使用本次部署的提交，而非远端分支最新提交。
    const commit = (env.VERCEL_GIT_COMMIT_SHA || execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root, encoding: 'utf8'
    })).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
        throw new Error('无法确定构建的 Git commit，请提供有效的 VERCEL_GIT_COMMIT_SHA 或从 Git 仓库构建。');
    }
    return commit.toLowerCase();
}

export async function build({ outputDirectory = resolve(root, 'dist'), env = process.env } = {}) {
    const commit = resolveCommit(env);
    const shortCommit = commit.slice(0, 7);
    const source = await readFile(resolve(root, 'index.html'), 'utf8');
    const marker = /<!-- build:commit -->[\s\S]*?<!-- \/build:commit -->/;
    if (!marker.test(source)) throw new Error('页面缺少 commit 链接的构建标记。');
    const html = source.replace(marker, `<a href="${repository}/commit/${commit}" target="_blank" rel="noopener noreferrer" class="github-link" id="commitLink" title="查看当前版本提交：${commit}" aria-label="查看当前版本提交 ${shortCommit}">
                    <span>${shortCommit}</span>
                </a>`)
        // 每次部署自动刷新本地脚本、样式缓存。
        .replace(/((?:src|href)="(?:script\.js|documents\.js|style\.css))\?v=[^"]+/g, `$1?v=${commit}`);
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all(publicAssets.map(file => copyFile(resolve(root, file), resolve(outputDirectory, file))));
    await writeFile(resolve(outputDirectory, 'index.html'), html);
    return { commit, shortCommit, outputDirectory };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await build();
    console.log(`Built Madopic ${result.shortCommit} → ${result.outputDirectory}`);
}
