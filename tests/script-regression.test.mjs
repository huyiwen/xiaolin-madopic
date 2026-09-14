import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { Marked } from 'marked';
import katex from 'katex';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'script.js'), 'utf8');

function createElement(overrides = {}) {
  const attributes = new Map();
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    scrollHeight: 0,
    scrollTop: 0,
    dataset: {},
    style: {
      setProperty() {},
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    addEventListener() {},
    removeEventListener() {},
    append() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    focus() {},
    click() {},
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() {
      const width = Number.parseFloat(this.style.width) || 640;
      const height = Number.parseFloat(this.style.height) || 600;
      return { width, height, top: 0, left: 0, bottom: height, right: width };
    },
    cloneNode() { return createElement(); },
    ...overrides,
  };
}

const elements = new Map();
const getElement = (id) => {
  if (!elements.has(id)) elements.set(id, createElement({ id }));
  return elements.get(id);
};

const documentStub = {
  readyState: 'loading',
  body: createElement(),
  documentElement: createElement(),
  addEventListener() {},
  querySelector() { return createElement(); },
  querySelectorAll() { return []; },
  getElementById: getElement,
  createElement() { return createElement(); },
};

const windowStub = {
  location: {
    href: 'https://madopic.test/',
    origin: 'https://madopic.test',
    search: '',
  },
  devicePixelRatio: 1,
  addEventListener() {},
};

const context = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  document: documentStub,
  window: windowStub,
  localStorage: { getItem() { return null; }, setItem() {} },
  marked: { parse(markdown) { return markdown; } },
  getComputedStyle() {
    return {
      padding: '0px',
      paddingTop: '0px',
      paddingBottom: '0px',
      background: '',
      backdropFilter: 'none',
      webkitBackdropFilter: 'none',
    };
  },
  requestAnimationFrame(callback) { callback(); },
  cancelAnimationFrame() {},
  setTimeout,
  clearTimeout,
  URL,
  URLSearchParams,
  Map,
  Set,
  WeakMap,
  Promise,
  Math,
  Date,
  JSON,
  RegExp,
  String,
  Number,
  Array,
  Object,
  Error,
  TypeError,
  encodeURIComponent,
  decodeURIComponent,
});

vm.runInContext(source, context, { filename: 'script.js' });
const run = (code) => vm.runInContext(code, context);

assert.equal(
  run('backgroundPresets.gradient1'),
  'linear-gradient(135deg, #A755F7 0%, #7275F2 50%, #6C23AA 100%)',
  'the default purple gradient must preserve the reference image color progression',
);

assert.equal(
  run('mathRenderer.preprocessMath("$F = ma$")'),
  '$F = ma$',
  'existing inline math must remain inline',
);

assert.equal(
  run('mathRenderer.preprocessMath("```js\\nconst π = 3;\\n```")'),
  '```js\nconst π = 3;\n```',
  'fenced code must not be rewritten by math shortcuts',
);

assert.equal(
  run('mathRenderer.preprocessMath("公式 F = ma")'),
  '公式 $F=ma$',
  'plain-text formula shortcuts must remain supported',
);

// Exercise the real Markdown parser: underscores and TeX line breaks must reach
// KaTeX intact, instead of becoming emphasis, escapes, or HTML line breaks.
const stubMarked = context.marked;
context.marked = new Marked({ breaks: true, gfm: true });
run('setupMarkdownMath();');
const parseMathMarkdown = markdown => run(`prepareMarkdownHTML(${JSON.stringify(markdown)})`);
const complexSubscript = String.raw`$(o_t)_a = \sum_{b=1}^{d_k}(q_t)_b(u_t)_c$`;
const alignedMath = String.raw`$$\begin{aligned}
1 & 1\\
2 & 2\\
\end{aligned}$$`;
for (const formula of [
  String.raw`$(o_t)_a$`,
  complexSubscript,
  alignedMath,
  String.raw`\((o_t)_a = \sum_{b=1}^{d_k}(q_t)_b(u_t)_c\)`,
  String.raw`\[\begin{aligned}
x_1 &= \frac{a_b}{c_d}\\
y_2 &= \sqrt{x_1}
\end{aligned}\]`,
  String.raw`$$\begin{pmatrix}a_1 & b_2\\c_3 & d_4\end{pmatrix}$$`,
  String.raw`$\text{cost: \$5} + x_{i_{j}}$`,
  String.raw`\(E=mc^2 + π\)`,
  String.raw`$x < y \;\&\; z > 0$`,
]) {
  const html = parseMathMarkdown(formula);
  const escaped = run(`escapeHtml(${JSON.stringify(formula)})`);
  assert.ok(html.includes(`class="math-source">${escaped}</`), `formula must remain one intact text node: ${formula}`);
  assert.doesNotMatch(html, /<(?:em|br|strong)\b/, 'Markdown must not reinterpret TeX syntax');
  const math = run(`readMathExpression(${JSON.stringify(formula)})`);
  const delimiterLength = formula.startsWith('$$') || formula.startsWith('\\') ? 2 : 1;
  assert.doesNotThrow(() => katex.renderToString(formula.slice(delimiterLength, -delimiterLength), {
    displayMode: math.display, throwOnError: true, strict: false, trust: false,
  }));
}
assert.match(parseMathMarkdown(`**加粗** 和 *斜体*，${complexSubscript}。`), /<strong>加粗<\/strong> 和 <em>斜体<\/em>/);
assert.match(parseMathMarkdown(`前文\n${alignedMath}\n后文`), /<\/p>\s*<div class="math-source">[\s\S]*<\/div>\s*<p>后文/);
assert.match(parseMathMarkdown(`> ${alignedMath.replaceAll('\n', '\n> ')}`), /<blockquote>\s*<div class="math-source">/);
assert.match(parseMathMarkdown(`- ${complexSubscript}`), /<li><span class="math-source">/);
for (const code of [
  `\`${complexSubscript}\``,
  `\`\`${complexSubscript}\`\``,
  `\`\`\`latex\n${alignedMath}\n\`\`\``,
  `~~~latex\n${alignedMath}\n~~~`,
  `    ${complexSubscript}`,
]) {
  assert.doesNotMatch(parseMathMarkdown(code), /class="math-source"/, 'literal code must not render math');
}
assert.doesNotMatch(parseMathMarkdown(String.raw`价格 \$5 和 \$10`), /class="math-source"/, 'escaped dollars must remain literal');
assert.match(parseMathMarkdown('$<img src=x onerror=alert(1)>$'), /&lt;img src=x onerror=alert\(1\)&gt;/, 'formula source must be escaped as text');
assert.doesNotMatch(parseMathMarkdown('$<img src=x onerror=alert(1)>$'), /<img\b/);
assert.match(parseMathMarkdown('未结束的 $x'), /未结束的 \$x/, 'unfinished input must remain visible');
context.marked = stubMarked;

const pageBreak = '<!--madopic-new-page-->';
const splitPages = (markdown) => Array.from(run(`splitMarkdownPages(${JSON.stringify(markdown)})`));
assert.deepEqual(splitPages(`# 第一页\n${pageBreak}\n# 第二页`), ['# 第一页', '# 第二页']);
assert.deepEqual(splitPages(`第一页\r\n  ${pageBreak} \r\n第二页`), ['第一页', '第二页']);
assert.deepEqual(splitPages(`${pageBreak}\n第一页\n${pageBreak}\n\n${pageBreak}\n第二页\n${pageBreak}`), ['第一页', '第二页']);
assert.deepEqual(splitPages(`${pageBreak}\n${pageBreak}`), [''], 'empty pages should not create blank posters');
for (const literal of [
  `\`\`\`html\n${pageBreak}\n\`\`\``,
  `~~~html\n${pageBreak}\n~~~`,
  `\`\`\`\`markdown\n\`\`\`\n${pageBreak}\n\`\`\`\n\`\`\`\``,
  `\`\`\`html\n${pageBreak}`,
  `示例：\`${pageBreak}\``,
  `    ${pageBreak}`,
]) {
  assert.deepEqual(splitPages(literal), [literal], 'literal code examples must not trigger pagination');
}
assert.deepEqual(
  splitPages(`~~~html\n${pageBreak}\n~~~\n${pageBreak}\n第二页`),
  [`~~~html\n${pageBreak}\n~~~`, '第二页'],
  'pagination must resume after the end of a fenced code block',
);

await run(`markdownInput.value = ${JSON.stringify(`# 第一页\n${pageBreak}\n# 第二页\n${pageBreak}\n# 第三页`)}; setMode('xhs');`);
assert.equal(run('posterContent.innerHTML'), '# 第一页', 'XHS should initially render only the first page');
assert.equal(run('pageIndicator.textContent'), '第 1 / 3 页');
assert.equal(run('pageControls.hidden'), false);
assert.equal(run('prevPageButton.disabled'), true);
assert.equal(run('nextPageButton.disabled'), false);

await run('changePreviewPage(1)');
assert.equal(run('posterContent.innerHTML'), '# 第二页');
await run('updatePreview()');
assert.equal(run('currentPreviewPage'), 1, 'updates must keep the selected page');
await run('changePreviewPage(1)');
await run('changePreviewPage(1)');
assert.equal(run('posterContent.innerHTML'), '# 第三页');
assert.equal(run('nextPageButton.disabled'), true, 'navigation must stop at the last page');

await run(`markdownInput.value = ${JSON.stringify(`# 第一页\n${pageBreak}\n# 第二页`)}; updatePreview();`);
assert.equal(run('pageIndicator.textContent'), '第 2 / 2 页', 'deleting a page must clamp the selected page');
assert.equal(run('posterContent.innerHTML'), '# 第二页');
await run('setMode("free")');
assert.equal(run('pageControls.hidden'), true);
assert.match(run('posterContent.innerHTML'), /第一页[\s\S]*第二页/, 'free mode must render all content');
await run('setMode("pyq")');
assert.equal(run('pageControls.hidden'), true);
assert.match(run('posterContent.innerHTML'), /第一页[\s\S]*第二页/, 'PYQ mode must render all content');
await run('setMode("xhs")');
assert.equal(run('posterContent.innerHTML'), '# 第一页', 'returning to XHS must reset to the first page');
await run(`markdownInput.value = ''; updatePreview();`);
assert.equal(run('pageIndicator.textContent'), '第 1 / 1 页');
assert.equal(run('nextPageButton.disabled'), true);
assert.match(run('posterContent.innerHTML'), /开始创作吧/);
await run(`markdownInput.value = '# 第一页'; updatePreview();`);
assert.equal(run('posterContent.innerHTML'), '# 第一页', 'restoring content after clear must render it again');

// A slow diagram on the previous page must not start rendering charts on the new page.
run(`
  globalThis.originalRenderDiagrams = diagramRenderer.renderDiagrams;
  globalThis.originalRenderECharts = echartsRenderer.renderECharts;
  globalThis.chartRenderCount = 0;
  diagramRenderer.renderDiagrams = () => new Promise(resolve => { globalThis.finishOldDiagram = resolve; });
  echartsRenderer.renderECharts = async () => { chartRenderCount++; };
  markdownInput.value = ${JSON.stringify(`慢速第一页\n${pageBreak}\n快速第二页`)};
  globalThis.oldPageRender = updatePreview();
`);
assert.equal(run('updatePreview() === oldPageRender'), true, 'unchanged preview must wait for the active render');
await run(`diagramRenderer.renderDiagrams = async () => {}; changePreviewPage(1);`);
await run('finishOldDiagram(); oldPageRender;');
assert.equal(run('posterContent.innerHTML'), '快速第二页');
assert.equal(run('chartRenderCount'), 1, 'a stale render must not rerender the new page');
run(`
  diagramRenderer.renderDiagrams = originalRenderDiagrams;
  echartsRenderer.renderECharts = originalRenderECharts;
`);

run(`
  updatePreview = () => Promise.resolve();
  updateLineNumbers = () => {};
  undoRedoManager.history = [];
  undoRedoManager.index = -1;
  markdownInput.value = '清空前的内容';
  undoRedoManager.push(markdownInput.value);
  handleToolbarAction('clear');
`);
assert.equal(run('markdownInput.value'), '', 'clear must still empty the editor');
assert.equal(
  run('undoRedoManager.undo()'),
  '清空前的内容',
  'undo after clear must restore the immediately previous content',
);

run(`
  undoRedoManager.history = [];
  undoRedoManager.index = -1;
  markdownInput.value = 'plain';
  markdownInput.selectionStart = 0;
  markdownInput.selectionEnd = 5;
  undoRedoManager.push(markdownInput.value);
  handleToolbarAction('bold');
`);
assert.equal(run('markdownInput.value'), '**plain**', 'toolbar formatting must keep its current output');
assert.equal(
  run('undoRedoManager.undo()'),
  'plain',
  'undo after toolbar formatting must restore the immediately previous content',
);

run(`
  undoRedoManager.history = [];
  undoRedoManager.index = -1;
  undoRedoManager.push('same');
  undoRedoManager.push('same');
`);
assert.equal(
  run('undoRedoManager.history.length'),
  1,
  'adjacent duplicate states must not create no-op undo steps',
);

const imageDataUrl = 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
run(`
  undoRedoManager.history = [];
  undoRedoManager.index = -1;
  markdownInput.value = '';
  markdownInput.selectionStart = 0;
  markdownInput.selectionEnd = 0;
  insertImageIntoMarkdown(${JSON.stringify(imageDataUrl)}, 'example.png');
`);
const imageMarkdown = run('markdownInput.value');
assert.match(
  imageMarkdown,
  /madopic-image:\/\/[A-Za-z0-9_-]+/,
  'local images must use a stable draft-safe reference',
);
assert.equal(
  run(`replaceImageDataForPreview(${JSON.stringify(imageMarkdown)})`).includes(imageDataUrl),
  true,
  'stable local-image references must resolve from the in-memory store',
);
assert.match(source, /const ImagePersistence\s*=\s*\{/, 'an IndexedDB persistence adapter must exist');
assert.match(
  source,
  /await\s+ImagePersistence\.loadAll\(\)[\s\S]*?restoreDraft\(\)/,
  'persisted images must load before the draft is restored',
);

run(`
  currentMode = 'xhs';
  markdownPoster.style.height = '';
  applyWidth(800);
`);
assert.equal(
  run('markdownPoster.style.height'),
  '1067px',
  'XHS height must be recalculated after width changes',
);

run(`
  currentMode = 'pyq';
  markdownPoster.style.height = '';
  applyWidth(800);
`);
assert.equal(
  run('markdownPoster.style.height'),
  '1734px',
  'PYQ height must be recalculated after width changes',
);

run(`
  currentMode = 'xhs';
  markdownPoster.offsetWidth = 640;
  markdownPoster.getBoundingClientRect = () => ({ width: 480, height: 640 });
  applyPreviewModeFrame();
`);
assert.equal(
  run('markdownPoster.style.height'),
  '853px',
  'XHS must keep its 3:4 layout when switching modes at 75% zoom',
);

// Export a complete snapshot even when the user starts on page two and edits during export.
const exportPageRenderer = run('createExactExportNode');
const downloads = [];
const zipEntries = [];
const renderedPages = [];
const removedPages = [];
context.Blob = Blob;
context.captureDownload = (blob, filename) => downloads.push({ blob, filename });
context.createTestExportNode = (content) => createElement({
  content,
  remove() { removedPages.push(content); },
});
context.capturePng = async (node) => {
  renderedPages.push(node.content);
  if (node.content === '失败页') throw new Error('Canvas render failed');
  return new Blob([node.content], { type: 'image/png' });
};
context.JSZip = class {
  file(name, blob) { zipEntries.push({ name, blob }); }
  async generateAsync() { return new Blob(['zip'], { type: 'application/zip' }); }
};
run(`
  showNotification = () => {};
  downloadBlob = captureDownload;
  createExactExportNode = async (snapshot, index) => createTestExportNode(snapshot.pages[index]);
  prepareImagesForExport = async () => {};
  renderExportPng = capturePng;
  ensureZipExportLibLoaded = async () => {};
  ensureCanvasExportLibLoaded = () => new Promise(resolve => { globalThis.finishExportLibraries = resolve; });
  currentMode = 'xhs';
  currentPreviewPage = 1;
  markdownInput.value = ${JSON.stringify(`封面\n${pageBreak}\n正文\n${pageBreak}\n结尾`)};
  globalThis.pendingExport = exportToPNG();
`);
assert.equal(run('document.getElementById("exportPngBtn").disabled'), true);
assert.equal(run('document.getElementById("exportPdfBtn").disabled'), true);
await run('exportToPNG()');
assert.equal(downloads.length, 0, 'a second export click must not start another download');
run(`markdownInput.value = '导出期间的新内容'; setMode('free'); finishExportLibraries();`);
await run('pendingExport');
assert.deepEqual(renderedPages, ['封面', '正文', '结尾'], 'export must use every original page in order');
assert.deepEqual(removedPages, renderedPages, 'each temporary page must be disposed');
assert.deepEqual(zipEntries.map(entry => entry.name), ['page-001.png', 'page-002.png', 'page-003.png']);
assert.deepEqual(await Promise.all(zipEntries.map(entry => entry.blob.text())), ['封面', '正文', '结尾']);
assert.equal(downloads.length, 1, 'all PNG pages must share one download');
assert.match(downloads[0].filename, /\.zip$/);
assert.equal(run('document.getElementById("exportPngBtn").disabled'), false);
assert.equal(run('document.getElementById("exportHtmlBtn").disabled'), false, 'buttons must reflect the mode selected during export');

downloads.length = renderedPages.length = removedPages.length = 0;
await run(`
  ensureCanvasExportLibLoaded = async () => {};
  currentMode = 'xhs';
  currentPreviewPage = 1;
  markdownInput.value = ${JSON.stringify(`成功页\n${pageBreak}\n失败页\n${pageBreak}\n未开始页`)};
  exportToPNG();
`);
assert.equal(downloads.length, 0, 'failed batches must not download a partial ZIP');
assert.deepEqual(removedPages, ['成功页', '失败页'], 'failed pages must also release temporary nodes');
assert.equal(run('isExporting'), false);
assert.equal(run('currentPreviewPage'), 1, 'export must not navigate the preview');
assert.equal(run('document.getElementById("exportPngBtn").disabled'), false);
assert.equal(run('document.getElementById("exportHtmlBtn").disabled'), true);
await run('exportToHTML()');
assert.equal(downloads.length, 0, 'calling HTML export directly in XHS mode must also be blocked');

const mergedPages = [];
const rasterPages = [];
const fakePdf = (node) => ({
  output() { return node.content; },
  save(filename) { downloads.push({ filename }); },
});
context.renderTestEditablePdf = async node => {
  if (node.content === '兼容页') throw new Error('Editable text render failed');
  return fakePdf(node);
};
context.renderTestRasterPdf = async node => {
  rasterPages.push(node.content);
  return fakePdf(node);
};
context.PDFLib = {
  PDFDocument: {
    async create() {
      return {
        async copyPages(pdf) { return [pdf.content]; },
        addPage(page) { mergedPages.push(page); },
        async save() { return new Uint8Array([1, 2, 3]); },
      };
    },
    async load(content) { return { content, getPageIndices() { return [0]; } }; },
  },
};
removedPages.length = 0;
await run(`
  ensurePdfExportLibsLoaded = async () => {};
  ensurePdfMergeLibLoaded = async () => {};
  replaceEChartsWithImages = async () => {};
  exportEditablePDF = renderTestEditablePdf;
  exportRasterPDF = renderTestRasterPdf;
  markdownInput.value = ${JSON.stringify(`封面\n${pageBreak}\n兼容页\n${pageBreak}\n结尾`)};
  exportToPDF();
`);
assert.deepEqual(mergedPages, ['封面', '兼容页', '结尾'], 'PDF must combine all pages in order, including raster fallbacks');
assert.deepEqual(rasterPages, ['兼容页']);
assert.deepEqual(removedPages, mergedPages);
assert.equal(downloads.length, 1, 'PDF must download one merged document');
assert.equal(downloads[0].blob.type, 'application/pdf');
assert.match(downloads[0].filename, /\.pdf$/);
assert.equal(run('currentPreviewPage'), 1);

downloads.length = 0;
await run(`setMode('free'); markdownInput.value = '单页正文'; exportToPNG();`);
assert.equal(downloads.length, 1);
assert.match(downloads[0].filename, /\.png$/, 'free mode must retain a standalone PNG');
downloads.length = 0;
await run('exportToPDF()');
assert.equal(downloads.length, 1);
assert.match(downloads[0].filename, /\.pdf$/, 'free mode must retain direct PDF download');

// Four corner text blocks stay outside the Markdown container and accept only safe styles.
const cornerNodes = [];
context.testCornerPoster = createElement({
  innerHTML: 'unchanged body',
  querySelectorAll() { return [...cornerNodes]; },
  appendChild(node) {
    node.remove = () => cornerNodes.splice(cornerNodes.indexOf(node), 1);
    cornerNodes.push(node);
  },
});
run(`
  globalThis.cornerSettings = normalizeHeaderFooterSettings({
    'top-left': { text: '<img src=x onerror=alert(1)>', fontSize: 16, color: '#123456', font: 'serif', bold: true },
    'top-right': { text: '品牌', fontSize: 999, color: 'invalid', font: 'invalid' },
    'bottom-left': { text: '两行\\n页脚', fontSize: -10, italic: true },
    'bottom-right': { text: '  ' }
  });
  renderHeaderFooter(testCornerPoster, cornerSettings);
`);
assert.equal(cornerNodes.length, 3, 'blank corners must remain hidden');
assert.equal(cornerNodes[0].textContent, '<img src=x onerror=alert(1)>', 'corner text must be inserted literally');
assert.equal(cornerNodes[0].innerHTML, undefined, 'corner text must never be parsed as HTML');
assert.equal(cornerNodes[0].style.color, '#123456');
assert.equal(cornerNodes[0].style.fontSize, '16px');
assert.equal(cornerNodes[0].style.fontWeight, '700');
assert.equal(cornerNodes[1].style.fontSize, '32px');
assert.equal(cornerNodes[1].style.color, '#ffffff');
assert.equal(cornerNodes[2].style.fontSize, '8px');
assert.equal(cornerNodes[2].style.fontStyle, 'italic');
assert.equal(cornerNodes[2].textContent, '两行\n页脚');
assert.equal(run('testCornerPoster.innerHTML'), 'unchanged body', 'corner rendering must not replace Markdown content');
run('renderHeaderFooter(testCornerPoster, normalizeHeaderFooterSettings())');
assert.equal(cornerNodes.length, 0, 'clearing settings must remove all previous corner nodes');

const savedValues = new Map();
context.localStorage.setItem = (key, value) => savedValues.set(key, value);
run(`currentHeaderFooter = cornerSettings; autoSave('正文');`);
const savedSettings = JSON.parse(savedValues.get('madopic_settings'));
assert.equal(savedSettings.headerFooter['top-left'].text, '<img src=x onerror=alert(1)>');
assert.equal(savedSettings.headerFooter['bottom-left'].italic, true);

// Page numbers update with preview pagination, including pages with no other corner text.
run(`
  globalThis.numberSettings = normalizeHeaderFooterSettings({
    'top-left': { text: '笔记', pageNumber: 'current' },
    'top-right': { pageNumber: 'invalid' },
    'bottom-left': { pageNumber: 'label' },
    'bottom-right': { pageNumber: 'total' }
  });
  renderHeaderFooter(testCornerPoster, numberSettings, 2, 3);
`);
assert.deepEqual(cornerNodes.map(node => node.textContent), ['笔记 · 2', '第 2 / 3 页', '2 / 3']);
assert.equal(run('numberSettings["top-right"].pageNumber'), 'none');
const previewCornerNodes = [];
const livePoster = run('markdownPoster');
livePoster.querySelectorAll = () => [...previewCornerNodes];
livePoster.appendChild = node => {
  node.remove = () => previewCornerNodes.splice(previewCornerNodes.indexOf(node), 1);
  previewCornerNodes.push(node);
};
run(`
  currentMode = 'xhs';
  currentPreviewPage = 2;
  currentHeaderFooter = numberSettings;
  updatePreviewPagination(${JSON.stringify(`甲\n${pageBreak}\n乙`)});
`);
assert.deepEqual(previewCornerNodes.map(node => node.textContent), ['笔记 · 2', '第 2 / 2 页', '2 / 2']);
run('currentMode = "free"; updatePreviewPagination("全文");');
assert.deepEqual(previewCornerNodes.map(node => node.textContent), ['笔记 · 1', '第 1 / 1 页', '1 / 1']);

// Export each page with its own number and the saved settings, not the live preview's values.
const exportedCorners = [];
const exportContent = createElement();
const exportPoster = createElement({
  querySelector() { return exportContent; },
  appendChild(node) { exportedCorners.push(node); },
});
const numberSnapshot = {
  pages: ['甲', '乙', '丙'],
  template: { cloneNode() { return exportPoster; } },
  headerFooter: run('normalizeHeaderFooterSettings(numberSettings)'),
};
run('currentHeaderFooter = normalizeHeaderFooterSettings(); currentPreviewPage = 0;');
await exportPageRenderer(numberSnapshot, 1);
assert.deepEqual(exportedCorners.map(node => node.textContent), ['笔记 · 2', '第 2 / 3 页', '2 / 3']);
assert.equal(exportContent.innerHTML, '乙');

// Arrow keys navigate only outside text editing and settings dialogs.
const handlePageKey = run('handlePreviewPageKeydown');
let preventedKeys = 0;
const pageKey = overrides => ({
  key: 'ArrowRight',
  target: { closest() { return null; } },
  preventDefault() { preventedKeys++; },
  ...overrides,
});
run(`currentMode = 'xhs'; currentPreviewPage = 0; markdownInput.value = ${JSON.stringify(`甲\n${pageBreak}\n乙`)};`);
await handlePageKey(pageKey());
assert.equal(run('currentPreviewPage'), 1);
await handlePageKey(pageKey());
assert.equal(run('currentPreviewPage'), 1, 'right arrow must stop at the last page');
await handlePageKey(pageKey({ key: 'ArrowLeft' }));
assert.equal(run('currentPreviewPage'), 0);
for (const overrides of [
  { target: { closest() { return {}; } } },
  { target: { isContentEditable: true } },
  { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
  { isComposing: true }, { defaultPrevented: true }, { key: 'ArrowDown' },
]) {
  const count = preventedKeys;
  await handlePageKey(pageKey(overrides));
  assert.equal(run('currentPreviewPage'), 0);
  assert.equal(preventedKeys, count, 'editing and modified keys must keep their native behavior');
}
const modalOverlay = run('overlay');
modalOverlay.classList.contains = () => true;
await handlePageKey(pageKey());
assert.equal(run('currentPreviewPage'), 0, 'open settings dialogs must suspend arrow navigation');
modalOverlay.classList.contains = () => false;
run('currentMode = "free";');
await handlePageKey(pageKey());
assert.equal(run('currentPreviewPage'), 0, 'free mode must keep its arrow key behavior');
