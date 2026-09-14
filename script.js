// ===== 应用状态管理 =====
const AppState = {
    zoom: 100,
    background: 'gradient1',
    fontSize: 18,
    padding: 24,
    width: 640,
    mode: 'free', // 'free' | 'xhs' | 'pyq'
    fixedHeights: { xhs: null, pyq: null }
};

// 状态管理器
const StateManager = {
    state: AppState,
    listeners: [],

    get(key) {
        return this.state[key];
    },

    set(key, value) {
        const oldValue = this.state[key];
        this.state[key] = value;
        this.notify(key, value, oldValue);
    },

    subscribe(listener) {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index > -1) this.listeners.splice(index, 1);
        };
    },

    notify(key, value, oldValue) {
        this.listeners.forEach(fn => {
            try {
                fn(key, value, oldValue);
            } catch (e) {
                console.error('状态监听器错误:', e);
            }
        });
    }
};

// 为了兼容性，保留旧的全局变量作为访问器
let currentZoom = AppState.zoom;
let currentBackground = AppState.background;
let currentFontSize = AppState.fontSize;
let currentPadding = AppState.padding;
let currentWidth = AppState.width;
let currentMode = AppState.mode;
let fixedHeights = AppState.fixedHeights;
let isExporting = false;
let restoringApp = true;
let documentLibrary = null;
let currentCustomBackground = { colorStart: '#a755f7', colorEnd: '#6c23aa', direction: '135deg' };
let backgroundDraft = null;
let currentCardColor = '#ffffff';

const HEADER_FOOTER_CORNERS = {
    'top-left': '左上角 · 页眉',
    'top-right': '右上角 · 页眉',
    'bottom-left': '左下角 · 页脚',
    'bottom-right': '右下角 · 页脚'
};
const HEADER_FOOTER_FONTS = {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
    serif: 'Georgia, "Songti SC", "SimSun", serif',
    mono: '"SF Mono", Monaco, Consolas, monospace'
};
let currentHeaderFooter = normalizeHeaderFooterSettings();
let headerFooterDraft = null;

function normalizeHeaderFooterSettings(settings = {}) {
    return Object.fromEntries(Object.keys(HEADER_FOOTER_CORNERS).map(corner => {
        const value = settings?.[corner] || {};
        const fontSize = Number(value.fontSize);
        return [corner, {
            text: typeof value.text === 'string' ? value.text : '',
            fontSize: Number.isFinite(fontSize) ? Math.max(8, Math.min(32, fontSize)) : 12,
            color: /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : '#ffffff',
            font: Object.hasOwn(HEADER_FOOTER_FONTS, value.font) ? value.font : 'sans',
            // 沿用 pageNumber 字段，兼容已有设置；额外显示也支持文档名称。
            pageNumber: ['current', 'total', 'label', 'document-name'].includes(value.pageNumber) ? value.pageNumber : 'none',
            bold: value.bold === true,
            italic: value.italic === true
        }];
    }));
}

// ===== 工具函数 =====

/**
 * 防抖函数：延迟执行，在 delay 毫秒内多次调用只执行最后一次
 */
function debounce(fn, delay = 300) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * 动态加载脚本（懒加载 CDN）
 */
const loadedScripts = new Set();
async function loadScript(src) {
    if (loadedScripts.has(src)) return;
    if (src.includes('html2canvas') && typeof html2canvas !== 'undefined') {
        loadedScripts.add(src);
        return;
    }
    if (src.includes('jspdf') && window.jspdf && window.jspdf.jsPDF) {
        loadedScripts.add(src);
        return;
    }
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => {
            loadedScripts.add(src);
            resolve();
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

async function ensureCanvasExportLibLoaded() {
    await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
}

async function ensurePdfExportLibsLoaded() {
    await Promise.all([
        loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'),
        loadScript('https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js')
    ]);
}

async function ensureZipExportLibLoaded() {
    await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
}

let markdownArchiveParserPromise;
function loadMarkdownArchiveParser() {
    if (!markdownArchiveParserPromise) {
        markdownArchiveParserPromise = import('https://cdn.jsdelivr.net/npm/mdast-util-from-markdown@2.0.2/+esm')
            .then(module => module.fromMarkdown)
            .catch(error => {
                markdownArchiveParserPromise = null;
                throw error;
            });
    }
    return markdownArchiveParserPromise;
}

async function ensurePdfMergeLibLoaded() {
    await loadScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
}

/**
 * CORS 图片代理：将跨域图片 URL 转换为代理 URL
 */
function corsProxyUrl(url) {
    // 跳过 data: 和 blob: URL
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
    // 跳过同源图片
    try {
        const imgUrl = new URL(url, window.location.href);
        if (imgUrl.origin === window.location.origin) return url;
    } catch (e) {
        return url;
    }
    // 使用 weserv.nl 代理（免费、支持 CORS）
    return `https://images.weserv.nl/?url=${encodeURIComponent(url)}`;
}

function isSafeUrl(value, type = 'link') {
    if (!value) return true;
    const normalized = String(value).replace(/[\u0000-\u001F\u007F\s]+/g, '').toLowerCase();
    if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) {
        return false;
    }
    if (normalized.startsWith('#') || normalized.startsWith('/') || normalized.startsWith('./') || normalized.startsWith('../')) {
        return true;
    }

    try {
        const parsed = new URL(value, window.location.href);
        if (type === 'image') {
            return ['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)
                && (!parsed.href.toLowerCase().startsWith('data:') || parsed.href.toLowerCase().startsWith('data:image/'));
        }
        return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol);
    } catch (_) {
        return false;
    }
}

/**
 * HTML 清理函数：移除潜在的 XSS 攻击代码
 */
function sanitizeHTML(html) {
    // 创建临时 DOM 容器
    const temp = document.createElement('div');
    temp.innerHTML = html;

    // 移除危险的标签
    const dangerousTags = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea'];
    dangerousTags.forEach(tag => {
        const elements = temp.querySelectorAll(tag);
        elements.forEach(el => el.remove());
    });

    // 移除危险的属性（on* 事件处理器）
    const allElements = temp.querySelectorAll('*');
    allElements.forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            const attrName = attr.name.toLowerCase();
            if (attrName.startsWith('on') || attrName === 'srcdoc' || attrName === 'style' || attrName === 'formaction') {
                el.removeAttribute(attr.name);
            }
        });

        if (el.hasAttribute('href')) {
            const href = el.getAttribute('href');
            if (!isSafeUrl(href, 'link')) {
                el.removeAttribute('href');
            } else if (el.tagName.toLowerCase() === 'a') {
                el.setAttribute('rel', 'nofollow noopener noreferrer');
            }
        }
        if (el.hasAttribute('xlink:href') && !isSafeUrl(el.getAttribute('xlink:href'), 'link')) {
            el.removeAttribute('xlink:href');
        }
        if (el.hasAttribute('src')) {
            const src = el.getAttribute('src');
            if (!isSafeUrl(src, 'image')) {
                el.removeAttribute('src');
            }
        }
    });

    return temp.innerHTML;
}

// ===== 撤销/重做管理器 =====
class UndoRedoManager {
    constructor(maxHistory = 50) {
        this.history = [];
        this.index = -1;
        this.maxHistory = maxHistory;
        this.isUndoRedo = false;
    }

    push(state) {
        if (this.isUndoRedo) return;
        if (this.index >= 0 && this.history[this.index] === state) return;
        // 移除当前位置之后的历史
        this.history = this.history.slice(0, this.index + 1);
        this.history.push(state);
        // 限制历史大小
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        } else {
            this.index++;
        }
    }

    undo() {
        if (this.index > 0) {
            this.index--;
            return this.history[this.index];
        }
        return null;
    }

    redo() {
        if (this.index < this.history.length - 1) {
            this.index++;
            return this.history[this.index];
        }
        return null;
    }

    canUndo() { return this.index > 0; }
    canRedo() { return this.index < this.history.length - 1; }
}

const undoRedoManager = new UndoRedoManager();

// ===== 自动保存 =====
const AUTOSAVE_KEY = 'madopic_draft';
const AUTOSAVE_SETTINGS_KEY = 'madopic_settings';

function saveSettings() {
    if (restoringApp) return true;
    try {
        localStorage.setItem(AUTOSAVE_SETTINGS_KEY, JSON.stringify({
            background: currentBackground,
            customBackground: currentCustomBackground,
            cardColor: currentCardColor,
            fontSize: typeof currentFontSize !== 'undefined' ? currentFontSize : 18,
            width: typeof currentWidth !== 'undefined' ? currentWidth : 640,
            padding: typeof currentPadding !== 'undefined' ? currentPadding : 24,
            mode: typeof currentMode !== 'undefined' ? currentMode : 'free',
            headerFooter: currentHeaderFooter
        }));
        return true;
    } catch (e) {
        console.warn('设置保存失败:', e);
        showNotification('设置未能保存，请检查浏览器存储空间', 'warning');
        return false;
    }
}

function autoSave(content) {
    if (restoringApp) return;
    if (documentLibrary?.active) {
        documentLibrary.save(content).catch(() => {});
        return;
    }
    // IndexedDB 不可用时保留旧草稿，避免正文丢失；恢复后再迁移到文档库。
    try {
        localStorage.setItem(AUTOSAVE_KEY, content);
    } catch (error) {
        showNotification('正文未能保存，请及时导出 Markdown 备份', 'warning');
    }
}

function loadDraft() {
    try {
        return localStorage.getItem(AUTOSAVE_KEY);
    } catch (e) {
        console.warn('加载草稿失败:', e);
        if (typeof showNotification === 'function') {
            showNotification('加载草稿失败，将使用默认内容', 'info');
        }
        return null;
    }
}

function loadSettings() {
    try {
        const settings = localStorage.getItem(AUTOSAVE_SETTINGS_KEY);
        return settings ? JSON.parse(settings) : null;
    } catch (e) {
        console.warn('加载设置失败:', e);
        if (typeof showNotification === 'function') {
            showNotification('加载设置失败，将使用默认设置', 'info');
        }
        return null;
    }
}

// ===== 数学公式渲染器 =====
const MATH_DELIMITERS = [
    { left: '$$', right: '$$', display: true },
    { left: '$', right: '$', display: false },
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false }
];

function readMathExpression(source) {
    const delimiter = MATH_DELIMITERS.find(({ left }) => source.startsWith(left));
    if (!delimiter) return;
    let braces = 0;
    for (let index = delimiter.left.length; index < source.length; index++) {
        if (!delimiter.display && source[index] === '\n') return;
        if (braces === 0 && source.startsWith(delimiter.right, index)) {
            return { raw: source.slice(0, index + delimiter.right.length), display: delimiter.display };
        }
        if (source[index] === '\\') index++;
        else if (source[index] === '{') braces++;
        else if (source[index] === '}') braces = Math.max(0, braces - 1);
    }
}

// 在 Markdown 的斜体、转义和换行规则之前识别公式，保留完整的 LaTeX 文本。
// 代码块和行内代码仍由 Marked 自己解析，不会转换为公式。
function setupMarkdownMath() {
    marked.use({ extensions: [
        {
            name: 'madopicBlockMath',
            level: 'block',
            start(source) { return source.match(/(?:^|\n) {0,3}(?:\$\$|\\\[)/)?.index; },
            tokenizer(source) {
                const indent = source.match(/^ {0,3}/)[0].length;
                const math = readMathExpression(source.slice(indent));
                if (!math?.display) return;
                const end = source.slice(indent + math.raw.length).match(/^[\t ]*(?:\n|$)/);
                if (!end) return;
                return { type: 'madopicBlockMath', raw: source.slice(0, indent + math.raw.length + end[0].length), text: math.raw };
            },
            renderer(token) { return `<div class="math-source">${escapeHtml(token.text)}</div>\n`; }
        },
        {
            name: 'madopicInlineMath',
            level: 'inline',
            start(source) { return source.search(/\$|\\(?:\(|\[)/); },
            tokenizer(source) {
                const math = readMathExpression(source);
                if (math) return { type: 'madopicInlineMath', raw: math.raw, text: math.raw };
            },
            renderer(token) { return `<span class="math-source">${escapeHtml(token.text)}</span>`; }
        }
    ] });
}

function protectMarkdownSegments(markdown) {
    const segments = [];
    const protect = (text, pattern) => text.replace(pattern, (match) => {
        const token = `\uE000MADOPIC_PROTECTED_${segments.length}\uE001`;
        segments.push(match);
        return token;
    });

    let protectedText = markdown;
    protectedText = protect(protectedText, /```[\s\S]*?```|~~~[\s\S]*?~~~/g);
    protectedText = protect(protectedText, /`[^`\n]*`/g);
    protectedText = protect(protectedText, /!?\[[^\]]*\]\([^\n)]*\)/g);
    protectedText = protect(protectedText, /\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$\n])+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g);

    return {
        text: protectedText,
        restore(text) {
            return text.replace(/\uE000MADOPIC_PROTECTED_(\d+)\uE001/g, (_, index) => segments[Number(index)] || '');
        }
    };
}

class MathRenderer {
    constructor() {
        this.isKaTeXLoaded = false;
        this.checkKaTeXAvailability();
    }

    checkKaTeXAvailability() {
        this.isKaTeXLoaded = typeof katex !== 'undefined' && typeof renderMathInElement !== 'undefined';
        if (!this.isKaTeXLoaded) {
            console.warn('KaTeX not loaded. Math formulas will not be rendered.');
        } else {
            // 检查mhchem扩展是否可用
            const hasMhchem = typeof katex.__defineMacro !== 'undefined' ||
                (window.katex && window.katex.__plugins && window.katex.__plugins['mhchem']);
            if (hasMhchem) {
                console.log('KaTeX with mhchem extension loaded successfully');
            } else {
                console.warn('KaTeX loaded but mhchem extension may not be available');
            }
        }
    }

    renderMath(element) {
        if (!this.isKaTeXLoaded) {
            console.warn('KaTeX not available for math rendering');
            return;
        }

        try {
            renderMathInElement(element, {
                delimiters: MATH_DELIMITERS,
                throwOnError: false,
                errorColor: '#cc0000',
                strict: false,
                trust: false,
                macros: {
                    // 物理常量
                    '\\emc': 'E=mc^{2}',
                    '\\hbar': '\\hslash',
                    '\\kb': 'k_B',
                    '\\NA': 'N_A',
                    // 常用符号
                    '\\R': '\\mathbb{R}',
                    '\\C': '\\mathbb{C}',
                    '\\N': '\\mathbb{N}',
                    '\\Z': '\\mathbb{Z}',
                    '\\Q': '\\mathbb{Q}',
                    // 微积分
                    '\\dd': '\\mathrm{d}',
                    '\\dv': ['\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}', 2],
                    '\\pdv': ['\\frac{\\partial#1}{\\partial#2}', 2],
                    // 向量
                    '\\vb': ['\\mathbf{#1}', 1],
                    '\\vu': ['\\hat{\\mathbf{#1}}', 1],
                    // 物理单位
                    '\\unit': ['\\,\\mathrm{#1}', 1]
                },
                fleqn: false,
                displayMode: false
            });
        } catch (error) {
            console.error('Math rendering error:', error);
            this.showMathError(element, error.message);
        }
    }

    showMathError(element, errorMessage) {
        const errorElements = element.querySelectorAll('.katex-error');
        errorElements.forEach(errorEl => {
            errorEl.style.color = '#cc0000';
            errorEl.title = `Math Error: ${errorMessage}`;
        });
    }

    // 预处理Markdown中的数学公式
    preprocessMath(markdown) {
        const protectedMarkdown = protectMarkdownSegments(markdown);
        markdown = protectedMarkdown.text;

        // 处理质能守恒公式的特殊情况
        markdown = markdown.replace(/E\s*=\s*mc\^?2/g, '$E=mc^{2}$');

        // 处理其他常见物理公式
        markdown = markdown.replace(/F\s*=\s*ma/g, '$F=ma$');
        markdown = markdown.replace(/v\s*=\s*u\s*\+\s*at/g, '$v=u+at$');
        markdown = markdown.replace(/s\s*=\s*ut\s*\+\s*½at²/g, '$s=ut+\\frac{1}{2}at^{2}$');
        markdown = markdown.replace(/v²\s*=\s*u²\s*\+\s*2as/g, '$v^{2}=u^{2}+2as$');

        // 处理数学常量
        markdown = markdown.replace(/π/g, '$\\pi$');
        markdown = markdown.replace(/∞/g, '$\\infty$');
        markdown = markdown.replace(/±/g, '$\\pm$');
        markdown = markdown.replace(/≤/g, '$\\leq$');
        markdown = markdown.replace(/≥/g, '$\\geq$');
        markdown = markdown.replace(/≠/g, '$\\neq$');
        markdown = markdown.replace(/∈/g, '$\\in$');
        markdown = markdown.replace(/∉/g, '$\\notin$');
        markdown = markdown.replace(/⊆/g, '$\\subseteq$');
        markdown = markdown.replace(/⊇/g, '$\\supseteq$');
        markdown = markdown.replace(/∪/g, '$\\cup$');
        markdown = markdown.replace(/∩/g, '$\\cap$');
        markdown = markdown.replace(/∅/g, '$\\emptyset$');

        // 处理希腊字母
        markdown = markdown.replace(/α/g, '$\\alpha$');
        markdown = markdown.replace(/β/g, '$\\beta$');
        markdown = markdown.replace(/γ/g, '$\\gamma$');
        markdown = markdown.replace(/δ/g, '$\\delta$');
        markdown = markdown.replace(/ε/g, '$\\epsilon$');
        markdown = markdown.replace(/θ/g, '$\\theta$');
        markdown = markdown.replace(/λ/g, '$\\lambda$');
        markdown = markdown.replace(/μ/g, '$\\mu$');
        markdown = markdown.replace(/σ/g, '$\\sigma$');
        markdown = markdown.replace(/φ/g, '$\\phi$');
        markdown = markdown.replace(/ω/g, '$\\omega$');

        return protectedMarkdown.restore(markdown);
    }
}

// 创建全局数学渲染器实例
const mathRenderer = new MathRenderer();

// ===== 图表渲染器 =====
class DiagramRenderer {
    constructor() {
        this.isMermaidLoaded = false;
        this.mermaidConfig = {
            startOnLoad: false,
            theme: 'default',
            themeVariables: {
                primaryColor: '#6366f1',
                primaryTextColor: '#1f2937',
                primaryBorderColor: '#4f46e5',
                lineColor: '#6b7280',
                secondaryColor: '#f3f4f6',
                tertiaryColor: '#ffffff'
            },
            flowchart: {
                useMaxWidth: true,
                htmlLabels: true
            },
            sequence: {
                useMaxWidth: true,
                wrap: true
            },
            gantt: {
                useMaxWidth: true
            },
            securityLevel: 'strict'
        };
        this.checkMermaidAvailability();
    }

    checkMermaidAvailability() {
        this.isMermaidLoaded = typeof mermaid !== 'undefined';
        if (this.isMermaidLoaded) {
            try {
                mermaid.initialize(this.mermaidConfig);
                console.log('Mermaid initialized successfully');
            } catch (error) {
                console.error('Mermaid initialization error:', error);
                this.isMermaidLoaded = false;
            }
        } else {
            console.warn('Mermaid not loaded. Diagrams will not be rendered.');
        }
    }

    async renderDiagram(element, diagramCode, diagramId) {
        if (!this.isMermaidLoaded) {
            console.warn('Mermaid not available for diagram rendering');
            this.showDiagramError(element, 'Mermaid library not loaded');
            return;
        }

        try {
            // 清除之前的内容
            element.innerHTML = '';

            // 渲染图表
            const { svg } = await mermaid.render(diagramId, diagramCode);
            element.innerHTML = svg;

            // 添加图表容器样式
            element.classList.add('mermaid-diagram');

        } catch (error) {
            console.error('Diagram rendering error:', error);
            this.showDiagramError(element, error.message);
        }
    }

    showDiagramError(element, errorMessage) {
        element.textContent = '';
        const wrapper = document.createElement('div');
        wrapper.className = 'diagram-error';
        const icon = document.createElement('i');
        icon.className = 'fas fa-exclamation-triangle';
        const title = document.createElement('div');
        title.className = 'error-title';
        title.textContent = '图表渲染错误';
        const message = document.createElement('div');
        message.className = 'error-message';
        message.textContent = errorMessage;
        wrapper.append(icon, title, message);
        element.appendChild(wrapper);
        element.classList.add('diagram-error-container');
    }

    // 预处理Markdown中的图表代码
    preprocessDiagram(markdown) {
        // 为每个mermaid代码块生成唯一ID
        let diagramCounter = 0;
        return markdown.replace(/```mermaid\s*\n([\s\S]*?)\n```/g, (match, code) => {
            const diagramId = `mermaid-diagram-${++diagramCounter}`;
            return `<div class="mermaid-container" data-diagram-id="${diagramId}" data-diagram-code="${encodeURIComponent(code.trim())}"></div>`;
        });
    }

    // 渲染页面中的所有图表
    async renderDiagrams(container) {
        if (!this.isMermaidLoaded) {
            return;
        }

        const diagramContainers = container.querySelectorAll('.mermaid-container');

        for (const diagramContainer of diagramContainers) {
            const diagramId = diagramContainer.getAttribute('data-diagram-id');
            const diagramCode = decodeURIComponent(diagramContainer.getAttribute('data-diagram-code'));

            if (diagramId && diagramCode) {
                await this.renderDiagram(diagramContainer, diagramCode, diagramId);
            }
        }
    }

    // 设置主题
    setTheme(theme) {
        if (!this.isMermaidLoaded) {
            return;
        }

        this.mermaidConfig.theme = theme;
        try {
            mermaid.initialize(this.mermaidConfig);
        } catch (error) {
            console.error('Theme update error:', error);
        }
    }
}

// 创建全局图表渲染器实例
const diagramRenderer = new DiagramRenderer();

// ECharts 渲染器类
class EChartsRenderer {
    constructor() {
        this.isEChartsLoaded = false;
        // 使用 WeakMap 存储实例，自动垃圾回收
        this.instances = new WeakMap();
        this.checkEChartsAvailability();
    }

    checkEChartsAvailability() {
        this.isEChartsLoaded = typeof echarts !== 'undefined';
        if (!this.isEChartsLoaded) {
            console.warn('ECharts not loaded. ECharts diagrams will not be rendered.');
        }
    }

    async renderEChart(element, chartConfig, chartId) {
        if (!this.isEChartsLoaded) {
            console.warn('ECharts not available for chart rendering');
            this.showEChartError(element, 'ECharts library not loaded');
            return;
        }

        try {
            // 清理之前的实例（如果存在）
            this.destroy(element);

            // 清除之前的内容
            element.innerHTML = '';

            // 创建图表容器
            const chartContainer = document.createElement('div');
            chartContainer.id = chartId;
            chartContainer.style.width = '100%';
            chartContainer.style.height = '400px';
            chartContainer.style.minHeight = '300px';
            element.appendChild(chartContainer);

            // 解析配置
            let config;
            if (typeof chartConfig === 'string') {
                config = JSON.parse(chartConfig);
            } else {
                config = chartConfig;
            }

            // 初始化图表
            const chart = echarts.init(chartContainer);
            chart.setOption(config);

            // 响应式调整
            const resizeObserver = new ResizeObserver(() => {
                chart.resize();
            });
            resizeObserver.observe(chartContainer);

            // 使用 WeakMap 存储图表实例
            this.instances.set(element, {
                chart,
                resizeObserver,
                container: chartContainer
            });

        } catch (error) {
            console.error('ECharts rendering error:', error);
            this.showEChartError(element, error.message);
        }
    }

    showEChartError(element, errorMessage) {
        element.textContent = '';
        const wrapper = document.createElement('div');
        wrapper.className = 'echarts-error';
        wrapper.style.cssText = `
            padding: 20px;
            border: 2px dashed #ff6b6b;
            border-radius: 8px;
            background-color: #ffe0e0;
            color: #d63031;
            text-align: center;
            font-family: monospace;
        `;
        const icon = document.createElement('i');
        icon.className = 'fas fa-exclamation-triangle';
        icon.style.marginRight = '8px';
        const text = document.createTextNode(`ECharts Error: ${errorMessage}`);
        wrapper.append(icon, text);
        element.appendChild(wrapper);
    }

    preprocessECharts(markdown) {
        // 处理 ```echarts 代码块
        return markdown.replace(/```echarts\s*\n([\s\S]*?)\n```/g, (match, code) => {
            const chartId = 'echarts-' + Math.random().toString(36).substr(2, 9);
            return `<div class="echarts-container" data-echarts-id="${chartId}" data-echarts-config="${encodeURIComponent(code.trim())}"></div>`;
        });
    }

    async renderECharts(container) {
        const echartsElements = container.querySelectorAll('.echarts-container');

        for (const element of echartsElements) {
            const chartId = element.getAttribute('data-echarts-id');
            const configData = decodeURIComponent(element.getAttribute('data-echarts-config'));

            await this.renderEChart(element, configData, chartId);
        }
    }

    /**
     * 清理单个 ECharts 实例
     */
    destroy(element) {
        const instance = this.instances.get(element);
        if (instance) {
            try {
                // 断开 ResizeObserver
                if (instance.resizeObserver) {
                    instance.resizeObserver.disconnect();
                }
                // 销毁图表实例
                if (instance.chart) {
                    instance.chart.dispose();
                }
            } catch (e) {
                console.warn('清理 ECharts 实例失败:', e);
            }
            // 从 WeakMap 中删除
            this.instances.delete(element);
        }
    }

    /**
     * 清理指定容器内的所有 ECharts 实例
     */
    destroyAll(container) {
        if (!container) return;

        const echartsElements = container.querySelectorAll('.echarts-container');
        echartsElements.forEach(element => {
            this.destroy(element);
        });
    }
}


// 创建全局 ECharts 渲染器实例
const echartsRenderer = new EChartsRenderer();

// ===== 卡片渲染器 =====
class CardRenderer {
    constructor() {
        // 卡片渲染器不需要外部依赖
    }

    // 预处理Markdown中的卡片语法
    preprocessCards(markdown) {
        // 处理 :::card 语法，支持不同类型的卡片
        return markdown.replace(/:::card(?:\s+(info|success|warning|error))?\s*\n([\s\S]*?)\n:::/g, (match, type, content) => {
            const cardType = type || 'default';
            const cardId = 'card-' + Math.random().toString(36).substr(2, 9);
            return `<div class="card-container" data-card-id="${cardId}" data-card-type="${cardType}" data-card-content="${encodeURIComponent(content.trim())}"></div>`;
        });
    }

    // 渲染页面中的所有卡片
    async renderCards(container) {
        const cardContainers = container.querySelectorAll('.card-container');

        for (const cardContainer of cardContainers) {
            const cardId = cardContainer.getAttribute('data-card-id');
            const cardType = cardContainer.getAttribute('data-card-type');
            const cardContent = decodeURIComponent(cardContainer.getAttribute('data-card-content'));

            if (cardId && cardContent) {
                await this.renderCard(cardContainer, cardContent, cardType);
            }
        }
    }

    // 渲染单个卡片
    async renderCard(element, content, type) {
        try {
            // 清除之前的内容
            element.innerHTML = '';

            // 解析卡片内容的Markdown
            let htmlContent = '';
            try {
                htmlContent = marked.parse(content);
                htmlContent = sanitizeHTML(htmlContent);
            } catch (err) {
                console.error('卡片内容Markdown解析失败: ', err);
                htmlContent = '<p>卡片内容解析失败</p>';
            }

            // 创建卡片HTML结构
            const cardHtml = `
                <div class="madopic-card ${type !== 'default' ? 'card-' + type : ''}">
                    <div class="card-content">
                        ${htmlContent}
                    </div>
                </div>
            `;

            element.innerHTML = cardHtml;
            mathRenderer.renderMath(element);

        } catch (error) {
            console.error('卡片渲染错误:', error);
            element.textContent = '';
            const card = document.createElement('div');
            card.className = 'madopic-card';
            const content = document.createElement('div');
            content.className = 'card-content';
            const message = document.createElement('p');
            message.style.color = '#ef4444';
            message.textContent = `卡片渲染失败：${error.message}`;
            content.appendChild(message);
            card.appendChild(content);
            element.appendChild(card);
        }
    }
}

// 创建全局卡片渲染器实例
const cardRenderer = new CardRenderer();

// ===== 导出相关常量 =====
// 控制导出清晰度的缩放倍数范围
const EXPORT_MIN_SCALE = 2;
const EXPORT_MAX_SCALE = 3;

function getPreferredExportScale() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const urlScale = parseFloat(urlParams.get('scale'));
        const storedScale = parseFloat(localStorage.getItem('madopic_export_scale'));
        const base = Number.isFinite(urlScale)
            ? urlScale
            : (Number.isFinite(storedScale)
                ? storedScale
                : Math.max(2, window.devicePixelRatio || 1));
        return Math.min(EXPORT_MAX_SCALE, Math.max(EXPORT_MIN_SCALE, base));
    } catch (_) {
        return Math.max(EXPORT_MIN_SCALE, Math.min(EXPORT_MAX_SCALE, 2));
    }
}

const EXPORT_SCALE = getPreferredExportScale();

// 预设背景渐变
const backgroundPresets = {
    gradient1: 'linear-gradient(135deg, #A755F7 0%, #7275F2 50%, #6C23AA 100%)',
    gradient2: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    gradient3: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    gradient4: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    gradient5: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
    gradient6: 'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
    gradient7: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
    gradient8: 'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)'
};

// DOM 元素
const markdownInput = document.getElementById('markdownInput');
const lineNumbersEl = document.querySelector('.line-numbers');
const posterContent = document.getElementById('posterContent');
const markdownPoster = document.getElementById('markdownPoster');
const previewContent = document.getElementById('previewContent');
const backgroundPanel = document.getElementById('backgroundPanel');
const layoutPanel = document.getElementById('layoutPanel');
const overlay = document.getElementById('overlay');
const zoomLevel = document.querySelector('.zoom-level');
const pageControls = document.getElementById('pageControls');
const pageIndicator = document.getElementById('pageIndicator');
const prevPageButton = document.getElementById('prevPage');
const nextPageButton = document.getElementById('nextPage');
const headerFooterPanel = document.getElementById('headerFooterPanel');

// 图片数据存储（使用 Map 提供更好的性能）
const imageDataStore = new Map();
let hasShownImagePersistenceWarning = false;

const ImagePersistence = {
    databaseName: 'madopic',
    databaseVersion: 2,
    storeName: 'images',
    databasePromise: null,

    open() {
        if (typeof indexedDB === 'undefined') {
            return Promise.reject(new Error('IndexedDB is unavailable'));
        }
        if (this.databasePromise) return this.databasePromise;

        this.databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.databaseName, this.databaseVersion);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(this.storeName)) {
                    database.createObjectStore(this.storeName, { keyPath: 'id' });
                }
                if (!database.objectStoreNames.contains('documents')) {
                    database.createObjectStore('documents', { keyPath: 'id' });
                }
            };
            request.onsuccess = () => {
                const database = request.result;
                database.onversionchange = () => {
                    database.close();
                    this.databasePromise = null;
                };
                resolve(database);
            };
            request.onerror = () => reject(request.error || new Error('Unable to open image storage'));
            request.onblocked = () => reject(new Error('Image storage upgrade is blocked'));
        }).catch((error) => {
            this.databasePromise = null;
            throw error;
        });

        return this.databasePromise;
    },

    async loadAll() {
        const database = await this.open();
        const records = await new Promise((resolve, reject) => {
            const request = database.transaction(this.storeName, 'readonly')
                .objectStore(this.storeName)
                .getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error('Unable to load saved images'));
        });

        records.forEach((record) => {
            if (record && typeof record.id === 'string' && typeof record.dataUrl === 'string') {
                imageDataStore.set(record.id, record.dataUrl);
            }
        });
        return records.length;
    },

    async save(id, dataUrl) {
        const database = await this.open();
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(this.storeName, 'readwrite');
            transaction.objectStore(this.storeName).put({ id, dataUrl });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('Unable to save image'));
            transaction.onabort = () => reject(transaction.error || new Error('Image save was aborted'));
        });
    }
};

// 图片缓存管理器
const ImageCache = {
    cache: new Map(),
    maxSize: 50, // 最多缓存 50 张图片

    set(url, data) {
        // 如果缓存已满，删除最早的项
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(url, {
            data,
            timestamp: Date.now()
        });
    },

    get(url) {
        const item = this.cache.get(url);
        return item ? item.data : null;
    },

    has(url) {
        return this.cache.has(url);
    },

    clear() {
        this.cache.clear();
    },

    // 清理超过指定时间的缓存（默认 30 分钟）
    cleanup(maxAge = 30 * 60 * 1000) {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.timestamp > maxAge) {
                this.cache.delete(key);
            }
        }
    }
};

// 预览渲染状态
let hasInitialPreviewRendered = false;
let lastPreviewKey = null;
let previewRenderVersion = 0;
let previewRenderPromise = Promise.resolve();
let previewPages = [''];
let currentPreviewPage = 0;
let previewWheelGesture = { time: -Infinity, direction: 0, delta: 0, paged: false };

// 分页符必须独占一行；代码块里的示例保持原样，不参与分页。
function splitMarkdownPages(markdown) {
    const pages = [];
    let lines = [];
    let fence = null;

    for (const line of markdown.split(/\r\n|\n|\r/)) {
        const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (fenceMatch && fenceMatch[1][0] === fence[0]
                && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) {
                fence = null;
            }
        } else if (fenceMatch && (fenceMatch[1][0] === '~' || !fenceMatch[2].includes('`'))) {
            fence = fenceMatch[1];
        } else if (/^ {0,3}<!--madopic-new-page-->[\t ]*$/.test(line)) {
            const content = lines.join('\n');
            if (content.trim()) pages.push(content);
            lines = [];
            continue;
        }
        lines.push(line);
    }

    const content = lines.join('\n');
    if (content.trim()) pages.push(content);
    return pages.length ? pages : [''];
}

function updatePreviewPagination(markdown) {
    previewPages = currentMode === 'xhs' ? splitMarkdownPages(markdown) : [markdown];
    currentPreviewPage = Math.max(0, Math.min(currentPreviewPage, previewPages.length - 1));
    pageControls.hidden = currentMode !== 'xhs';
    pageIndicator.textContent = `第 ${currentPreviewPage + 1} / ${previewPages.length} 页`;
    prevPageButton.disabled = currentPreviewPage === 0;
    nextPageButton.disabled = currentPreviewPage === previewPages.length - 1;
    renderHeaderFooter(markdownPoster, headerFooterDraft || currentHeaderFooter);
}

function changePreviewPage(offset) {
    if (currentMode !== 'xhs') return;
    // 翻页前同步输入，避免编辑去抖期间使用旧的页数。
    updatePreviewPagination(markdownInput.value);
    currentPreviewPage = Math.max(0, Math.min(currentPreviewPage + offset, previewPages.length - 1));
    document.getElementById('previewContainer').scrollTop = 0;
    return updatePreview();
}

// 初始化应用
async function bootstrapApp() {
    initializeApp();
    setupEventListeners();
    await initOptimizations();
    restoringApp = false;
    await updatePreview();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
    bootstrapApp();
}

// 初始化应用
function initializeApp() {
    setupMarkdownMath();
    // 配置 marked 选项
    marked.setOptions({
        breaks: true,
        gfm: true,
        // 安全性：启用 HTML 清理以防止 XSS 攻击
        // 注意：marked 的 sanitize 在新版本中已废弃，建议使用 DOMPurify
        // 这里保持 false 以支持自定义 HTML，但在实际渲染时应手动清理
        sanitize: false,
        highlight: function (code, lang) {
            return code;
        }
    });

    // 设置初始背景
    applyBackground(backgroundPresets[currentBackground]);
    applyCardColor(currentCardColor);

    // 应用初始设置
    applyFontSize(currentFontSize);
    applyPadding(currentPadding);
    applyWidth(currentWidth);

    // 初始化图表渲染器主题
    diagramRenderer.setTheme('default');

    // 更新缩放显示
    updateZoomDisplay();

    // 初始化行号
    updateLineNumbers();
}

// 设置事件监听器
function setupEventListeners() {
    // Markdown 输入监听
    // 更平滑的输入预览：稍延长防抖并在输入结束时仅渲染一次
    markdownInput.addEventListener('input', debounce(updatePreview, 250));
    markdownInput.addEventListener('input', () => autoSave(markdownInput.value));
    markdownInput.addEventListener('input', updateLineNumbers);
    markdownInput.addEventListener('scroll', syncLineNumbersScroll);

    // 工具栏按钮
    setupToolbarButtons();

    // 缩放控制
    document.getElementById('zoomIn').addEventListener('click', zoomIn);
    document.getElementById('zoomOut').addEventListener('click', zoomOut);
    prevPageButton.addEventListener('click', () => changePreviewPage(-1));
    nextPageButton.addEventListener('click', () => changePreviewPage(1));
    document.getElementById('previewContainer').addEventListener('wheel', handlePreviewPageWheel, { passive: false });

    // 背景设置面板
    document.getElementById('backgroundBtn').addEventListener('click', openBackgroundPanel);
    document.getElementById('cancelBackground').addEventListener('click', closeBackgroundPanel);
    document.getElementById('applyBackground').addEventListener('click', applyBackgroundSettings);
    setupHeaderFooterPanel();

    // 文字布局设置面板
    document.getElementById('layoutBtn').addEventListener('click', openLayoutPanel);
    document.getElementById('cancelLayout').addEventListener('click', closeLayoutPanel);
    document.getElementById('applyLayout').addEventListener('click', applyLayoutSettings);

    overlay.addEventListener('click', closeAllPanels);

    // 滑块事件监听
    setupSliders();

    // 导出功能
    setupExportButtons();
    setupModeButtons();
    setupDocumentSidebar();

    // 背景预设选择
    setupBackgroundPresets();

    // 自定义颜色输入
    setupColorInputs();

    // 图片处理
    setupImageHandlers();

    // 键盘快捷键
    setupKeyboardShortcuts();
}

// 设置导出按钮事件
function setupExportButtons() {
    const menu = document.getElementById('exportMenu');
    const toggle = document.getElementById('exportMenuBtn');
    const items = document.getElementById('exportMenuItems');
    const actions = { exportPngBtn: exportToPNG, exportPdfBtn: exportToPDF, exportHtmlBtn: exportToHTML, exportMarkdownBtn: exportToMarkdown };
    Object.entries(actions).forEach(([id, action]) => {
        document.getElementById(id).addEventListener('click', () => {
            setExportMenuOpen(false);
            toggle.focus();
            document.getElementById('toolbarRight').classList.remove('mobile-open');
            document.getElementById('hamburgerBtn').classList.remove('active');
            action();
        });
    });
    toggle.addEventListener('click', () => setExportMenuOpen(items.hidden));
    document.addEventListener('click', event => {
        if (!menu.contains(event.target)) setExportMenuOpen(false);
    });
    menu.addEventListener('focusout', event => {
        if (event.relatedTarget && !menu.contains(event.relatedTarget)) setExportMenuOpen(false);
    });
    menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setExportMenuOpen(false);
            toggle.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setExportMenuOpen(true);
            const buttons = [...items.querySelectorAll('button:not(:disabled)')];
            const current = buttons.indexOf(document.activeElement);
            const next = event.key === 'ArrowDown' ? current + 1 : current < 0 ? buttons.length - 1 : current - 1;
            buttons[(next + buttons.length) % buttons.length]?.focus();
        }
    });
    updateExportButtons();
}

function setExportMenuOpen(open) {
    document.getElementById('exportMenuItems').hidden = !open;
    document.getElementById('exportMenuBtn').setAttribute('aria-expanded', String(open));
}

function updateExportButtons() {
    const isXhs = currentMode === 'xhs';
    const descriptions = {
        exportPngBtn: isXhs ? '将全部分页导出为 PNG 压缩包（ZIP）' : '导出 PNG 图片',
        exportPdfBtn: isXhs ? '将全部分页合并为一个 PDF 文档' : '导出 PDF 文档',
        exportHtmlBtn: isXhs ? '小红书模式不支持导出 HTML，请使用 PNG 或 PDF' : '导出 HTML 页面',
        exportMarkdownBtn: '将完整 Markdown 和引用的图片打包为 ZIP'
    };
    Object.entries(descriptions).forEach(([id, title]) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.disabled = isExporting || (id === 'exportHtmlBtn' && isXhs);
        button.title = title;
        button.setAttribute('aria-busy', String(isExporting));
    });
    const toggle = document.getElementById('exportMenuBtn');
    toggle.disabled = isExporting;
    toggle.setAttribute('aria-busy', String(isExporting));
}

function beginExport() {
    if (isExporting) return false;
    isExporting = true;
    updateExportButtons();
    return true;
}

function endExport() {
    isExporting = false;
    updateExportButtons();
}

// 模式按钮绑定
function setupModeButtons() {
    const group = document.getElementById('modeGroup');
    if (!group) return;
    group.querySelectorAll('button[data-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-mode');
            setMode(mode);
        });
    });
}

function setMode(mode) {
    if (!['free', 'xhs', 'pyq'].includes(mode)) return;
    if (currentMode !== mode) currentPreviewPage = 0;
    currentMode = mode;
    updateExportButtons();
    // 切换按钮激活态
    const group = document.getElementById('modeGroup');
    if (group) {
        group.querySelectorAll('button[data-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
        });
    }
    // 切换模式后同时更新画布比例和分页内容。
    applyPreviewModeFrame();
    saveSettings();
    return updatePreview();
}

// 使用布局宽度，避免预览缩放影响画布比例和导出尺寸。
function getUnscaledWidth(element) {
    return element.offsetWidth || element.getBoundingClientRect().width;
}

function applyPreviewModeFrame() {
    // 预览时根据模式设置固定可视高度（以外层 markdownPoster 的 box 包含 padding 与内容）
    markdownPoster.dataset.mode = currentMode;
    if (currentMode === 'xhs') {
        // 3:4（宽:高） => 高度 = 宽度 / 3 * 4。由于 width 是含 padding 的可视宽度，这里与导出一致
        const targetHeight = Math.round((getUnscaledWidth(markdownPoster) / 3) * 4);
        markdownPoster.style.height = `${targetHeight}px`;
        markdownPoster.style.minHeight = `${targetHeight}px`;
        markdownPoster.style.overflow = 'hidden'; // 超出裁掉

        // 计算可用给白卡片（posterContent）的最大高度，保留上下紫色 padding
        const mpComputed = getComputedStyle(markdownPoster);
        const paddingTop = parseFloat(mpComputed.paddingTop) || 0;
        const paddingBottom = parseFloat(mpComputed.paddingBottom) || 0;
        const innerMax = Math.max(0, targetHeight - paddingTop - paddingBottom);
        posterContent.style.maxHeight = `${innerMax}px`;
        posterContent.style.overflow = 'hidden';
    } else if (currentMode === 'pyq') {
        // 朋友圈固定比例：1290x2796 ≈ 宽:高 = 1290:2796。
        // 在保持当前外层宽度不变的前提下，按该比例计算高度。
        const targetHeight = Math.round(getUnscaledWidth(markdownPoster) * (2796 / 1290));
        markdownPoster.style.height = `${targetHeight}px`;
        markdownPoster.style.minHeight = `${targetHeight}px`;
        markdownPoster.style.overflow = 'hidden';

        const mpComputed = getComputedStyle(markdownPoster);
        const paddingTop = parseFloat(mpComputed.paddingTop) || 0;
        const paddingBottom = parseFloat(mpComputed.paddingBottom) || 0;
        const innerMax = Math.max(0, targetHeight - paddingTop - paddingBottom);
        posterContent.style.maxHeight = `${innerMax}px`;
        posterContent.style.overflow = 'hidden';
    } else {
        markdownPoster.style.height = '';
        markdownPoster.style.minHeight = '600px';
        markdownPoster.style.overflow = 'hidden';
        posterContent.style.maxHeight = '';
        posterContent.style.overflow = '';
    }
}

// 设置工具栏按钮
function setupToolbarButtons() {
    document.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', function () {
            const action = this.getAttribute('data-action');
            handleToolbarAction(action);
            this.closest('details')?.removeAttribute('open');
        });
    });
    const templates = document.getElementById('insertTemplates');
    document.addEventListener('click', event => {
        if (!templates.contains(event.target)) templates.open = false;
    });
    templates.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            templates.open = false;
            templates.querySelector('summary').focus();
        }
    });
}

function applyEditorChange(nextValue, selectionStart, selectionEnd = selectionStart, options = {}) {
    if (!markdownInput) return;

    const { focus = true, recordHistory = true } = options;
    const previousValue = markdownInput.value;

    if (recordHistory && undoRedoManager.history[undoRedoManager.index] !== previousValue) {
        undoRedoManager.push(previousValue);
    }

    markdownInput.value = nextValue;
    const safeStart = Math.max(0, Math.min(selectionStart, nextValue.length));
    const safeEnd = Math.max(safeStart, Math.min(selectionEnd, nextValue.length));
    markdownInput.setSelectionRange(safeStart, safeEnd);

    if (recordHistory && undoRedoManager.history[undoRedoManager.index] !== nextValue) {
        undoRedoManager.push(nextValue);
    }

    updateLineNumbers();
    updatePreview();
    if (focus) markdownInput.focus();
}

// 处理工具栏动作
function handleToolbarAction(action) {
    const textarea = markdownInput;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.substring(start, end);
    const beforeText = textarea.value.substring(0, start);
    const afterText = textarea.value.substring(end);

    let insertText = '';
    let cursorPos = start;

    switch (action) {
        case 'bold':
            insertText = `**${selectedText || '粗体文本'}**`;
            cursorPos = start + (selectedText ? insertText.length : 2);
            break;
        case 'italic':
            insertText = `*${selectedText || '斜体文本'}*`;
            cursorPos = start + (selectedText ? insertText.length : 1);
            break;
        case 'heading':
            insertText = `## ${selectedText || '标题'}`;
            cursorPos = start + (selectedText ? insertText.length : 3);
            break;
        case 'list':
            insertText = `\n- ${selectedText || '列表项'}`;
            cursorPos = start + (selectedText ? insertText.length : 3);
            break;
        case 'link':
            insertText = `[${selectedText || '链接文本'}](https://example.com)`;
            cursorPos = start + (selectedText ? insertText.length : 1);
            break;
        case 'image':
            insertImage();
            return;
        case 'page-break':
            insertText = '\n\n<!--madopic-new-page-->\n\n';
            cursorPos = start + insertText.length;
            break;
        case 'flowchart':
            MarkdownHelper.insertFlowchart();
            return;
        case 'sequence':
            MarkdownHelper.insertSequenceDiagram();
            return;
        case 'gantt':
            MarkdownHelper.insertGanttChart();
            return;
        case 'pie':
            MarkdownHelper.insertPieChart();
            return;
        case 'math':
            MarkdownHelper.insertMathFormulas();
            return;
        case 'physics':
            MarkdownHelper.insertPhysicsFormulas();
            return;
        case 'chemistry':
            MarkdownHelper.insertChemistryFormulas();
            return;
        case 'echarts':
            MarkdownHelper.insertEChartsTemplate();
            return;
        case 'einstein':
            MarkdownHelper.insertEinsteinFormula();
            return;
        case 'card':
            MarkdownHelper.insertCard();
            return;
        case 'empty-line':
            // 插入可在预览中可见的"Markdown 空行"占位段落
            insertText = `\n\n<p class="md-empty-line">&nbsp;</p>\n\n`;
            cursorPos = start + insertText.length;
            break;
        case 'clear':
            applyEditorChange('', 0, 0);
            return;
    }

    applyEditorChange(beforeText + insertText + afterText, cursorPos, cursorPos);
}

// 更新预览
function updatePreview() {
    // 同步行号（在去抖预览之外也保证立即更新）
    updateLineNumbers();

    // 自动保存草稿
    autoSave(markdownInput.value);

    updatePreviewPagination(markdownInput.value);
    const markdownText = previewPages[currentPreviewPage].trim();
    const previewKey = JSON.stringify([currentMode, currentPreviewPage, markdownText]);
    if (previewKey === lastPreviewKey) return previewRenderPromise;
    lastPreviewKey = previewKey;
    const renderVersion = ++previewRenderVersion;
    echartsRenderer.destroyAll(posterContent);

    // 检查是否为空内容
    if (!markdownText) {
        showEmptyPreview();
        previewRenderPromise = Promise.resolve();
    } else {
        previewRenderPromise = renderPreviewPage(markdownText, renderVersion);
    }
    return previewRenderPromise;
}

function prepareMarkdownHTML(markdownText) {
    // 预处理数学公式
    let processedMarkdown = mathRenderer.preprocessMath(markdownText);

    // 预处理图表
    processedMarkdown = diagramRenderer.preprocessDiagram(processedMarkdown);

    // 预处理 ECharts 图表
    processedMarkdown = echartsRenderer.preprocessECharts(processedMarkdown);

    // 预处理卡片
    processedMarkdown = cardRenderer.preprocessCards(processedMarkdown);

    // 替换简化的base64为完整版本进行预览
    processedMarkdown = replaceImageDataForPreview(processedMarkdown);

    return sanitizeHTML(marked.parse(processedMarkdown));
}

async function renderPreviewPage(markdownText, renderVersion) {
    let htmlContent = '';
    try {
        htmlContent = prepareMarkdownHTML(markdownText);
    } catch (err) {
        console.error('Markdown 渲染失败: ', err);
        htmlContent = '<p style="color:#ef4444">渲染失败，请检查 Markdown 内容。</p>';
        if (typeof showNotification === 'function') {
            showNotification('Markdown 渲染失败，请检查内容格式', 'error');
        }
    }
    posterContent.innerHTML = htmlContent;

    // 渲染数学公式
    mathRenderer.renderMath(posterContent);

    // 渲染图表
    posterContent.querySelectorAll('.mermaid-container').forEach((container, index) => {
        container.setAttribute('data-diagram-id', `preview-mermaid-${renderVersion}-${index}`);
    });
    await diagramRenderer.renderDiagrams(posterContent);
    if (renderVersion !== previewRenderVersion) return;

    // 渲染 ECharts 图表
    await echartsRenderer.renderECharts(posterContent);
    if (renderVersion !== previewRenderVersion) return;

    // 渲染卡片
    await cardRenderer.renderCards(posterContent);
    if (renderVersion !== previewRenderVersion) return;

    // 代码高亮（Prism.js）
    if (typeof Prism !== 'undefined') {
        Prism.highlightAllUnder(posterContent);
    }

    // 确保内容容器可见
    posterContent.style.display = 'block';

    // 重新应用当前的字体大小设置
    applyFontSize(currentFontSize);

    // 仅首次渲染使用淡入动画，后续输入不再触发，避免屏闪
    if (!hasInitialPreviewRendered) {
        posterContent.style.animation = 'fadeIn 0.3s ease';
        hasInitialPreviewRendered = true;
    } else {
        posterContent.style.animation = '';
    }
}

// 防抖版本的 updatePreview
const debouncedUpdatePreview = debounce(updatePreview, 300);

// ===== 行号逻辑 =====
function updateLineNumbers() {
    if (!lineNumbersEl) return;
    const value = markdownInput.value || '';
    const lines = value.split('\n').length;
    // 构造包含行号的内容（使用换行分隔）
    let content = '';
    for (let i = 1; i <= lines; i++) {
        content += (i === 1 ? '' : '\n') + i;
    }
    lineNumbersEl.textContent = content || '1';
    // 高度同步
    lineNumbersEl.style.height = markdownInput.scrollHeight + 'px';
    syncLineNumbersScroll();
}

function syncLineNumbersScroll() {
    if (!lineNumbersEl) return;
    lineNumbersEl.scrollTop = markdownInput.scrollTop;
}

// 显示空内容提示
function showEmptyPreview() {
    posterContent.innerHTML = `
        <div class="empty-preview">
            <div class="empty-icon">
                <i class="fab fa-markdown"></i>
            </div>
            <h3>开始创作吧！</h3>
            <p>在左侧编辑器中输入 Markdown 内容</p>
            <div class="empty-tips">
                <div class="tip-item">
                    <i class="fas fa-lightbulb"></i>
                    <span>支持标题、列表、链接、图片等格式</span>
                </div>
                <div class="tip-item">
                    <i class="fas fa-keyboard"></i>
                    <span>使用工具栏快捷按钮快速插入格式</span>
                </div>
                <div class="tip-item">
                    <i class="fas fa-palette"></i>
                    <span>点击"自定义"按钮调整背景和样式</span>
                </div>
            </div>
        </div>
    `;
    hasInitialPreviewRendered = false;
}

// 为图片元素设置跨域与防盗链相关属性
function applyImageAttributes(root) {
    const imgs = root.querySelectorAll('img');
    imgs.forEach((img) => {
        try {
            if (!img.getAttribute('crossorigin')) {
                img.setAttribute('crossorigin', 'anonymous');
            }
            if (!img.getAttribute('referrerpolicy')) {
                img.setAttribute('referrerpolicy', 'no-referrer');
            }
            if (!img.getAttribute('decoding')) {
                img.setAttribute('decoding', 'sync');
            }
            if (!img.getAttribute('loading')) {
                img.setAttribute('loading', 'eager');
            }
        } catch (_) {
            // 忽略单个图片设置失败
        }
    });
}

// 缩放控制
function zoomIn() {
    if (currentZoom < 150) {
        currentZoom += 25;
        applyZoom();
    }
}

function zoomOut() {
    if (currentZoom > 50) {
        currentZoom -= 25;
        applyZoom();
    }
}

function applyZoom() {
    previewContent.className = 'preview-content';
    if (currentZoom !== 100) {
        previewContent.classList.add(`zoom-${currentZoom}`);
    }
    updateZoomDisplay();
}

function updateZoomDisplay() {
    zoomLevel.textContent = `${currentZoom}%`;
}

// 背景设置面板
function openBackgroundPanel() {
    backgroundDraft = { background: currentBackground, custom: { ...currentCustomBackground }, cardColor: currentCardColor };
    document.getElementById('cardColor').value = currentCardColor;
    updateCardColorPresets(currentCardColor);
    document.getElementById('colorStart').value = currentCustomBackground.colorStart;
    document.getElementById('colorEnd').value = currentCustomBackground.colorEnd;
    document.getElementById('gradientDirection').value = currentCustomBackground.direction;
    document.querySelectorAll('.bg-preset').forEach(preset => {
        preset.classList.toggle('active', preset.dataset.bg === currentBackground);
    });
    backgroundPanel.classList.add('active');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeBackgroundPanel() {
    backgroundDraft = null;
    applyBackground(getBackgroundCSS());
    applyCardColor(currentCardColor);
    backgroundPanel.classList.remove('active');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
}

// 文字布局设置面板
function openLayoutPanel() {
    for (const [name, value] of [['fontSize', currentFontSize], ['padding', currentPadding], ['width', currentWidth]]) {
        document.getElementById(`${name}Slider`).value = value;
        document.getElementById(`${name}Value`).textContent = `${value}px`;
    }
    layoutPanel.classList.add('active');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLayoutPanel() {
    applyFontSize(currentFontSize);
    applyPadding(currentPadding);
    applyWidth(currentWidth);
    layoutPanel.classList.remove('active');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
}

// 关闭所有面板
function closeAllPanels() {
    closeBackgroundPanel();
    closeLayoutPanel();
    closeHeaderFooterPanel();
    overlay.classList.remove('active');
    document.body.style.overflow = '';
}

function getCurrentDocumentName() {
    return MadopicDocumentLibrary.title({
        name: documentLibrary?.active?.name || '',
        content: markdownInput.value
    });
}

function formatHeaderFooterText(value, pageNumber, totalPages, documentName) {
    const formats = {
        current: `${pageNumber}`,
        total: `${pageNumber} / ${totalPages}`,
        label: `第 ${pageNumber} / ${totalPages} 页`,
        'document-name': documentName
    };
    const extra = formats[value.pageNumber] || '';
    return value.text.trim() && extra ? `${value.text} · ${extra}` : (extra || value.text);
}

function renderHeaderFooter(poster, settings = currentHeaderFooter, pageNumber = currentPreviewPage + 1, totalPages = previewPages.length, documentName = getCurrentDocumentName()) {
    poster.querySelectorAll('.poster-corner').forEach(element => element.remove());
    Object.entries(settings).forEach(([corner, value]) => {
        const content = formatHeaderFooterText(value, pageNumber, totalPages, documentName);
        if (!content.trim()) return;
        const text = document.createElement('div');
        text.className = `poster-corner poster-corner-${corner}`;
        text.dataset.corner = corner;
        text.textContent = content;
        Object.assign(text.style, {
            fontSize: `${value.fontSize}px`,
            color: value.color,
            fontFamily: HEADER_FOOTER_FONTS[value.font],
            fontWeight: value.bold ? '700' : '400',
            fontStyle: value.italic ? 'italic' : 'normal'
        });
        poster.appendChild(text);
    });
}

function setupHeaderFooterPanel() {
    const fields = document.getElementById('headerFooterFields');
    fields.innerHTML = Object.entries(HEADER_FOOTER_CORNERS).map(([corner, label]) => `
        <fieldset class="corner-settings" data-corner="${corner}">
            <legend>${label}</legend>
            <label for="${corner}-text">文字内容</label>
            <textarea id="${corner}-text" data-field="text" rows="2" placeholder="留空可仅显示下方所选内容"></textarea>
            <label class="corner-page-number">额外显示<select data-field="pageNumber" aria-label="${label}额外显示">
                <option value="none">不显示</option>
                <option value="current">当前页：1</option>
                <option value="total">页码 / 总页数：1 / 3</option>
                <option value="label">第 1 / 3 页</option>
                <option value="document-name">当前文档名称</option>
            </select></label>
            <div class="corner-style-controls">
                <label>字体<select data-field="font" aria-label="${label}字体">
                    <option value="sans">无衬线</option><option value="serif">衬线</option><option value="mono">等宽</option>
                </select></label>
                <label>字号<input data-field="fontSize" type="number" min="8" max="32" step="1" aria-label="${label}字号"></label>
                <label>颜色<input data-field="color" type="color" aria-label="${label}颜色"></label>
            </div>
            <div class="corner-text-options">
                <label><input data-field="bold" type="checkbox"> 加粗</label>
                <label><input data-field="italic" type="checkbox"> 斜体</label>
            </div>
        </fieldset>
    `).join('');
    fields.addEventListener('input', () => {
        const settings = {};
        fields.querySelectorAll('[data-corner]').forEach(fieldset => {
            const value = {};
            fieldset.querySelectorAll('[data-field]').forEach(input => {
                value[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
            });
            settings[fieldset.dataset.corner] = value;
        });
        headerFooterDraft = normalizeHeaderFooterSettings(settings);
        renderHeaderFooter(markdownPoster, headerFooterDraft);
    });
    document.getElementById('headerFooterBtn').addEventListener('click', openHeaderFooterPanel);
    document.getElementById('cancelHeaderFooter').addEventListener('click', closeHeaderFooterPanel);
    document.getElementById('applyHeaderFooter').addEventListener('click', () => {
        currentHeaderFooter = normalizeHeaderFooterSettings(headerFooterDraft);
        closeHeaderFooterPanel();
        saveSettings();
    });
    headerFooterPanel.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const controls = headerFooterPanel.querySelectorAll('textarea, input, select, button');
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
}

function openHeaderFooterPanel() {
    headerFooterDraft = normalizeHeaderFooterSettings(currentHeaderFooter);
    headerFooterPanel.querySelectorAll('[data-corner]').forEach(fieldset => {
        const value = headerFooterDraft[fieldset.dataset.corner];
        fieldset.querySelectorAll('[data-field]').forEach(input => {
            if (input.type === 'checkbox') input.checked = value[input.dataset.field];
            else input.value = value[input.dataset.field];
        });
    });
    headerFooterPanel.classList.add('active');
    headerFooterPanel.setAttribute('aria-hidden', 'false');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    document.getElementById('top-left-text').focus();
}

function closeHeaderFooterPanel() {
    const wasOpen = headerFooterPanel.classList.contains('active');
    headerFooterPanel.classList.remove('active');
    headerFooterDraft = null;
    renderHeaderFooter(markdownPoster);
    overlay.classList.remove('active');
    document.body.style.overflow = '';
    if (wasOpen) document.getElementById('headerFooterBtn').focus();
    headerFooterPanel.setAttribute('aria-hidden', 'true');
}

function setupBackgroundPresets() {
    document.querySelectorAll('.bg-preset').forEach(preset => {
        preset.addEventListener('click', function () {
            // 移除其他选中状态
            document.querySelectorAll('.bg-preset').forEach(p => p.classList.remove('active'));
            // 添加选中状态
            this.classList.add('active');
            if (!backgroundDraft) return;
            backgroundDraft.background = this.getAttribute('data-bg');
            applyBackground(getBackgroundCSS(backgroundDraft.background, backgroundDraft.custom));
        });
    });
}

function setupColorInputs() {
    const colorStart = document.getElementById('colorStart');
    const colorEnd = document.getElementById('colorEnd');
    const gradientDirection = document.getElementById('gradientDirection');

    [colorStart, colorEnd, gradientDirection].forEach(input => {
        input.addEventListener('input', function () {
            if (!backgroundDraft) return;
            // 取消预设选择
            document.querySelectorAll('.bg-preset').forEach(p => p.classList.remove('active'));
            backgroundDraft.background = 'custom';
            backgroundDraft.custom = { colorStart: colorStart.value, colorEnd: colorEnd.value, direction: gradientDirection.value };
            applyBackground(getBackgroundCSS('custom', backgroundDraft.custom));
        });
    });
    const chooseCardColor = color => {
        if (!backgroundDraft) return;
        backgroundDraft.cardColor = color;
        document.getElementById('cardColor').value = color;
        applyCardColor(color);
        updateCardColorPresets(color);
    };
    document.getElementById('cardColor').addEventListener('input', event => chooseCardColor(event.target.value));
    document.querySelectorAll('[data-card-color]').forEach(button => {
        button.addEventListener('click', () => chooseCardColor(button.dataset.cardColor));
    });
}

function updateCardColorPresets(color) {
    document.querySelectorAll('[data-card-color]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.cardColor.toLowerCase() === color.toLowerCase()));
    });
}

function applyCardColor(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255);
    const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const dark = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 < 0.18;
    const variables = {
        '--background-primary': color,
        '--background-secondary': dark ? '#242424' : '#fafafa',
        '--background-gray': dark ? '#303030' : '#fafafa',
        '--background-light': dark ? '#242424' : '#fafafa',
        '--text-primary': dark ? '#f5f5f5' : '#0f0f0f',
        '--text-secondary': dark ? '#e5e5e5' : '#525252',
        '--text-light': dark ? '#e5e5e5' : '#525252',
        '--text-muted': dark ? '#cccccc' : '#878787',
        '--primary-color': dark ? '#b8b8ff' : '#5b5bd6',
        '--primary-hover': dark ? '#d0d0ff' : '#4a4ac4',
        '--border-color': dark ? '#555555' : '#e6e6e6'
    };
    Object.entries(variables).forEach(([name, value]) => posterContent.style.setProperty(name, value));
    posterContent.style.color = variables['--text-light'];
}

function getBackgroundCSS(background = currentBackground, custom = currentCustomBackground) {
    return background === 'custom'
        ? `linear-gradient(${custom.direction}, ${custom.colorStart} 0%, ${custom.colorEnd} 100%)`
        : backgroundPresets[background] || backgroundPresets.gradient1;
}

function applyBackgroundSettings() {
    if (backgroundDraft) {
        currentBackground = backgroundDraft.background;
        currentCustomBackground = { ...backgroundDraft.custom };
        currentCardColor = backgroundDraft.cardColor;
    }
    closeBackgroundPanel();
    if (saveSettings()) showNotification('背景设置已更新并保存！', 'success');
}

function applyLayoutSettings() {
    // 应用字体大小设置
    currentFontSize = parseFloat(document.getElementById('fontSizeSlider').value);
    applyFontSize(currentFontSize);

    // 应用边距设置
    currentPadding = parseFloat(document.getElementById('paddingSlider').value);
    applyPadding(currentPadding);

    // 应用宽度设置
    currentWidth = parseInt(document.getElementById('widthSlider').value);
    applyWidth(currentWidth);

    closeLayoutPanel();

    // 显示成功提示
    if (saveSettings()) showNotification('文字布局设置已更新并保存！', 'success');
}

function applyBackground(backgroundCSS) {
    markdownPoster.style.background = backgroundCSS;
}

function applyFontSize(fontSize) {
    // 使用CSS变量统一管理字体大小，避免大量DOM操作
    posterContent.style.setProperty('--dynamic-font-size', `${fontSize}px`);
    posterContent.style.setProperty('--dynamic-h1-size', `${Math.round(fontSize * 1.75)}px`);
    posterContent.style.setProperty('--dynamic-h2-size', `${Math.round(fontSize * 1.375)}px`);
    posterContent.style.setProperty('--dynamic-h3-size', `${Math.round(fontSize * 1.125)}px`);
    posterContent.style.setProperty('--dynamic-h4-size', `${Math.round(fontSize * 1.05)}px`);
    posterContent.style.setProperty('--dynamic-h5-h6-size', `${Math.round(fontSize * 0.95)}px`);
    posterContent.style.setProperty('--dynamic-code-size', `${Math.round(fontSize * 0.875)}px`);
    posterContent.style.setProperty('--dynamic-quote-size', `${Math.round(fontSize * 0.95)}px`);
}

function applyPadding(padding) {
    // 调整白色内容卡片的内边距，即文字到紫色背景之间的留白
    posterContent.style.padding = `${padding}px`;
}

function applyWidth(width) {
    // 调整预览区的整体宽度（导出图片的宽度）
    markdownPoster.style.width = `${width}px`;
    applyPreviewModeFrame();
}

function setupSliders() {
    const fontSizeSlider = document.getElementById('fontSizeSlider');
    const fontSizeValue = document.getElementById('fontSizeValue');
    const paddingSlider = document.getElementById('paddingSlider');
    const paddingValue = document.getElementById('paddingValue');
    const widthSlider = document.getElementById('widthSlider');
    const widthValue = document.getElementById('widthValue');

    // 字体大小滑块
    fontSizeSlider.addEventListener('input', function () {
        const value = parseFloat(this.value);
        fontSizeValue.textContent = `${value}px`;
        // 实时预览
        applyFontSize(value);
    });

    // 边距滑块
    paddingSlider.addEventListener('input', function () {
        const value = parseFloat(this.value);
        paddingValue.textContent = `${value}px`;
        // 实时预览
        applyPadding(value);
    });

    // 宽度滑块
    widthSlider.addEventListener('input', function () {
        const value = this.value;
        widthValue.textContent = `${value}px`;
        // 实时预览
        applyWidth(parseInt(value));
    });

    // 初始化滑块值显示
    fontSizeValue.textContent = `${fontSizeSlider.value}px`;
    paddingValue.textContent = `${paddingSlider.value}px`;
    widthValue.textContent = `${widthSlider.value}px`;
}


// ===== 导出相关工具 =====
/**
 * 创建一个与预览完全一致的离屏克隆节点用于导出。
 * 关键点：同步计算样式与实际渲染宽度，并统一为 border-box，避免行宽与换行偏差。
 * 返回未挂载的模板节点，供整批页面复用。
 */
function createExportTemplate() {
    const clone = markdownPoster.cloneNode(true);
    clone.id = 'madopic-export-poster';
    const mpComputed = getComputedStyle(markdownPoster);
    Object.assign(clone.style, {
        position: 'fixed',
        top: '-9999px',
        left: '-9999px',
        margin: '0',
        width: `${getUnscaledWidth(markdownPoster)}px`,
        maxWidth: 'none',
        padding: mpComputed.padding,
        boxSizing: 'border-box',
        background: markdownPoster.style.background || mpComputed.background,
        transform: 'none'
    });
    // 移除内部动画/滤镜但不改变布局
    const inner = clone.querySelector('.poster-content');
    if (inner) {
        inner.removeAttribute('id');
        const pcComputed = getComputedStyle(posterContent);
        inner.style.animation = 'none';
        inner.style.width = `${getUnscaledWidth(posterContent)}px`;
        inner.style.padding = pcComputed.padding;
        inner.style.boxSizing = 'border-box';
        inner.style.backdropFilter = pcComputed.backdropFilter || 'none';
        inner.style.webkitBackdropFilter = pcComputed.webkitBackdropFilter || 'none';
    }
    // 固定高度模式：小红书 3:4。导出时必须与预览一致，且裁掉超出部分
    if (currentMode === 'xhs') {
        const target = Math.round((getUnscaledWidth(markdownPoster) / 3) * 4);
        clone.style.height = `${target}px`;
        clone.style.minHeight = `${target}px`;
        clone.style.overflow = 'hidden';

        // 同步内部白卡片最大高度，保留上下紫色 padding 作为边距
        const mpComputed = getComputedStyle(markdownPoster);
        const paddingTop = parseFloat(mpComputed.paddingTop) || 0;
        const paddingBottom = parseFloat(mpComputed.paddingBottom) || 0;
        const innerMax = Math.max(0, target - paddingTop - paddingBottom);
        const inner = clone.querySelector('.poster-content');
        if (inner) {
            inner.style.maxHeight = `${innerMax}px`;
            inner.style.overflow = 'hidden';
        }
    } else if (currentMode === 'pyq') {
        const target = Math.round(getUnscaledWidth(markdownPoster) * (2796 / 1290));
        clone.style.height = `${target}px`;
        clone.style.minHeight = `${target}px`;
        clone.style.overflow = 'hidden';

        const mpComputed = getComputedStyle(markdownPoster);
        const paddingTop = parseFloat(mpComputed.paddingTop) || 0;
        const paddingBottom = parseFloat(mpComputed.paddingBottom) || 0;
        const innerMax = Math.max(0, target - paddingTop - paddingBottom);
        const inner = clone.querySelector('.poster-content');
        if (inner) {
            inner.style.maxHeight = `${innerMax}px`;
            inner.style.overflow = 'hidden';
        }
    }
    return clone;
}

// 点击导出时同步保存全文、模式和布局；后续编辑、缩放、翻页不影响这次导出。
function createExportSnapshot() {
    const pages = currentMode === 'xhs' ? splitMarkdownPages(markdownInput.value) : [markdownInput.value];
    return {
        mode: currentMode,
        pages: pages.map(replaceImageDataForPreview),
        template: createExportTemplate(),
        headerFooter: normalizeHeaderFooterSettings(headerFooterDraft || currentHeaderFooter),
        documentName: getCurrentDocumentName(),
        filename: `madopic-${getFormattedTimestamp()}`
    };
}

let exportRenderVersion = 0;

function disposeExportNode(node) {
    if (!node) return;
    echartsRenderer.destroyAll(node);
    node.remove();
}

async function createExactExportNode(snapshot = null, pageIndex = 0) {
    if (!snapshot) await updatePreview();
    const clone = snapshot ? snapshot.template.cloneNode(true) : createExportTemplate();
    const renderId = ++exportRenderVersion;
    try {
        const content = clone.querySelector('.poster-content');
        if (snapshot && content) content.innerHTML = prepareMarkdownHTML(snapshot.pages[pageIndex]);
        if (snapshot) renderHeaderFooter(clone, snapshot.headerFooter, pageIndex + 1, snapshot.pages.length, snapshot.documentName);
        document.body.appendChild(clone);

        // 为导出节点重新渲染数学公式
        const cloneContent = clone.querySelector('.poster-content');
        if (cloneContent) {
            mathRenderer.renderMath(cloneContent);

            // 为导出节点的Mermaid图表生成新的唯一ID，避免与原始预览区冲突
            const mermaidContainers = cloneContent.querySelectorAll('.mermaid-container');
            mermaidContainers.forEach((container, index) => {
                const newId = `export-mermaid-${renderId}-${index}`;
                container.setAttribute('data-diagram-id', newId);
            });

            // 为导出节点重新渲染图表
            await diagramRenderer.renderDiagrams(cloneContent);

            // 为导出节点重新渲染ECharts图表
            await echartsRenderer.renderECharts(cloneContent);

            // 为导出节点重新渲染卡片
            await cardRenderer.renderCards(cloneContent);

            if (typeof Prism !== 'undefined') Prism.highlightAllUnder(cloneContent);

            // 额外等待确保所有渲染完成
            await new Promise(resolve => setTimeout(resolve, 500));

            // 再等待一帧确保DOM更新完成
            await new Promise(resolve => requestAnimationFrame(resolve));
        }

        return clone;
    } catch (error) {
        disposeExportNode(clone);
        throw error;
    }
}

async function forEachExportPage(snapshot, consumePage) {
    for (let index = 0; index < snapshot.pages.length; index++) {
        let node = null;
        try {
            node = await createExactExportNode(snapshot, index);
            await prepareImagesForExport(node);
            if (document.fonts && document.fonts.ready) await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(resolve));
            await consumePage(node, index);
        } finally {
            disposeExportNode(node);
        }
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    try {
        link.click();
    } finally {
        link.remove();
        // 给浏览器时间读取下载内容，再释放对象 URL。
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
}

/**
 * 确保导出节点中的所有图片都可被 html2canvas 捕获。
 * 做法：为每个 <img> 设置 crossorigin/referrerpolicy，并强制等待加载完毕。
 */
async function prepareImagesForExport(root) {
    const images = Array.from(root.querySelectorAll('img'));
    const loadPromises = images.map((img) => new Promise((resolve) => {
        try {
            // 仅导出阶段设置跨域与防盗链（避免影响预览）
            img.setAttribute('crossorigin', 'anonymous');
            img.setAttribute('referrerpolicy', 'no-referrer');
            // 若已完成加载则直接 resolve
            if (img.complete && img.naturalWidth > 0) return resolve();
            // 监听加载/失败
            const clean = () => {
                img.removeEventListener('load', onLoad);
                img.removeEventListener('error', onError);
            };
            const onLoad = () => { clean(); resolve(); };
            const onError = () => {
                clean();
                // 第一次失败，尝试代理加速/绕过 CORS 防盗链
                tryProxyImage(img).finally(resolve);
            };
            img.addEventListener('load', onLoad, { once: true });
            img.addEventListener('error', onError, { once: true });
            // 触发重新加载（给 src 加一个无副作用查询串）。
            // 对 data: 协议不处理；对 blob: 协议尝试转成 dataURL（html2canvas 不抓取跨上下文 blob）
            try {
                if (img.src.startsWith('data:')) {
                    // 已是 dataURL，无需处理
                } else if (img.src.startsWith('blob:')) {
                    // 尝试将 blob 读取为 dataURL
                    const xhr = new XMLHttpRequest();
                    xhr.open('GET', img.src, true);
                    xhr.responseType = 'blob';
                    xhr.onload = () => {
                        try {
                            const reader = new FileReader();
                            reader.onload = () => { img.src = reader.result; };
                            reader.onerror = () => { };
                            reader.readAsDataURL(xhr.response);
                        } catch (_) { }
                    };
                    xhr.onerror = () => { };
                    xhr.send();
                } else {
                    const url = new URL(img.src, window.location.href);
                    url.searchParams.set('madopic_cache_bust', Date.now().toString());
                    img.src = url.href;
                }
            } catch (_) {
                // 若 URL 构造失败则忽略
            }
        } catch (_) {
            resolve();
        }
    }));
    await Promise.race([
        Promise.allSettled(loadPromises),
        new Promise((resolve) => setTimeout(resolve, 3000)) // 最多等待 3s，避免卡死
    ]);
}

/**
 * 若图片加载失败，尝试通过公共图片代理服务加载，提升导出命中率。
 * 代理：images.weserv.nl（仅用于 http/https 且跨源情况）。
 */
function tryProxyImage(img) {
    return new Promise((resolve) => {
        try {
            if (img.dataset.madopicProxied === '1') return resolve();
            const original = new URL(img.src, window.location.href);
            // 同源或 data/blob 不代理
            if (original.origin === window.location.origin) return resolve();
            if (original.protocol !== 'http:' && original.protocol !== 'https:') return resolve();

            // 构造代理 URL（去掉协议）
            const hostless = original.href.replace(/^https?:\/\//i, '');
            // 代理默认会设置允许跨域，附带 no-referrer。若原图为 https，确保代理也为 https
            const proxied = `https://images.weserv.nl/?url=${encodeURIComponent(hostless)}&n=-1&output=png`;

            const onLoad = () => { cleanup(); resolve(); };
            const onError = () => { cleanup(); resolve(); };
            const cleanup = () => {
                img.removeEventListener('load', onLoad);
                img.removeEventListener('error', onError);
            };

            img.addEventListener('load', onLoad, { once: true });
            img.addEventListener('error', onError, { once: true });
            img.dataset.madopicProxied = '1';
            img.setAttribute('crossorigin', 'anonymous');
            img.setAttribute('referrerpolicy', 'no-referrer');
            img.src = proxied;
        } catch (_) {
            resolve();
        }
    });
}

/**
 * 导出为 PNG（通过克隆节点离屏渲染，保证与预览一致）。
 * 流程：等待字体 → 克隆节点 → 读取尺寸 → html2canvas 渲染 → 透明边缘裁剪 → 触发下载 → 清理。
 */
async function renderExportPng(node, mode) {
    const rect = node.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    if (height * EXPORT_SCALE > 32767) {
        showNotification('内容过长，可能导致导出失败。建议缩短内容或降低导出比例。', 'warning');
    }
    const canvas = await renderWithFallbackScales(node, width, height, getExportScaleCandidates(EXPORT_SCALE));
    let outputCanvas = canvas;
    if (mode === 'free') {
        try {
            outputCanvas = trimTransparentEdges(canvas) || canvas;
        } catch (error) {
            console.warn('无法裁剪透明边缘:', error);
        }
    }
    try {
        return await new Promise((resolve, reject) => {
            outputCanvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('无法生成 PNG 图片数据'));
            }, 'image/png');
        });
    } finally {
        // 图片数据已转为 Blob，及时释放大画布，避免多页导出占满内存。
        canvas.width = canvas.height = 0;
        if (outputCanvas !== canvas) outputCanvas.width = outputCanvas.height = 0;
    }
}

function markdownArchiveImageKey(source, storedImages) {
    if (storedImages.has(source)) return storedImages.get(source);
    if (/^(?:data:|madopic-image:)/i.test(source)) return source;
    return new URL(source, window.location.href).href;
}

function collectMarkdownArchiveImages(markdown, parse, storedImages) {
    const tree = parse(markdown);
    const definitions = new Map();
    const usedDefinitions = new Set();
    const edits = [];
    const images = new Map();
    const visit = (node, callback) => {
        callback(node);
        node.children?.forEach(child => visit(child, callback));
    };
    visit(tree, node => {
        if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    });
    const image = source => {
        let key;
        try { key = markdownArchiveImageKey(source, storedImages); }
        catch (_) { key = source; }
        if (!images.has(key)) images.set(key, { source, key, index: images.size + 1 });
        return images.get(key);
    };
    visit(tree, node => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (!Number.isInteger(start) || !Number.isInteger(end)) return;
        if (node.type === 'image' || node.type === 'imageReference') {
            const definition = node.type === 'image' ? node : definitions.get(node.identifier);
            if (!definition?.url) return;
            if (node.type === 'imageReference') {
                if (usedDefinitions.has(definition)) return;
                usedDefinitions.add(definition);
                edits.push({ start: definition.position.start.offset, end: definition.position.end.offset,
                    image: image(definition.url), label: definition.label || definition.identifier, title: definition.title });
            } else {
                edits.push({ start, end, image: image(definition.url), alt: node.alt || '', title: definition.title });
            }
        } else if (node.type === 'html' && /<img\b/i.test(node.value)) {
            // template 保持 HTML 离线，不加载图片，也不执行源文件中的脚本。
            const template = document.createElement('template');
            template.innerHTML = node.value;
            const references = Array.from(template.content.querySelectorAll('img[src]'))
                .filter(img => !img.closest('pre, code'))
                .map(img => ({ element: img, image: image(img.getAttribute('src')) }));
            if (references.length) edits.push({ start, end, template, references });
        }
    });
    return { edits, images: Array.from(images.values()) };
}

function markdownImageDataBlob(dataUrl) {
    const match = /^data:(image\/[^;,]+)([^,]*),([\s\S]*)$/i.exec(dataUrl);
    if (!match) throw new Error('图片数据格式无效');
    const bytes = /;base64/i.test(match[2])
        ? Uint8Array.from(atob(match[3].replace(/\s/g, '')), char => char.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(match[3]));
    return new Blob([bytes], { type: match[1] });
}

function markdownImageExtension(type) {
    const mime = type.toLowerCase().split(';')[0];
    const extensions = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
        'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/x-icon': 'ico',
        'image/vnd.microsoft.icon': 'ico'
    };
    if (!extensions[mime]) throw new Error('下载结果不是支持的图片格式');
    return extensions[mime];
}

async function loadMarkdownArchiveImage(key) {
    if (/^data:/i.test(key)) return markdownImageDataBlob(key);
    if (key.startsWith('madopic-image:')) throw new Error('本地图片数据已丢失，请重新插入');
    const url = new URL(key, window.location.href);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) throw new Error('不支持此图片地址');
    const candidates = [url.href];
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== window.location.origin) {
        candidates.push(corsProxyUrl(url.href));
    }
    let failure;
    for (const candidate of candidates) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(candidate, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
            if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
            const blob = await response.blob();
            markdownImageExtension(blob.type);
            if (!blob.size) throw new Error('图片内容为空');
            return blob;
        } catch (error) {
            failure = error;
        } finally {
            clearTimeout(timeout);
        }
    }
    throw failure;
}

function rewriteMarkdownArchiveImages(markdown, edits) {
    const escapeLabel = text => text.replace(/[\\[\]]/g, '\\$&').replace(/\r?\n/g, ' ');
    const escapeTitle = text => text.replace(/[\\"]/g, '\\$&').replace(/\r?\n/g, ' ');
    // 从后向前替换 AST 提供的源文位置，保留其他正文、公式、分页符和代码的原始内容。
    for (const edit of edits.slice().sort((a, b) => b.start - a.start)) {
        let replacement;
        if (edit.image?.path) {
            const title = edit.title ? ` "${escapeTitle(edit.title)}"` : '';
            replacement = edit.label !== undefined
                ? `[${escapeLabel(edit.label)}]: ${edit.image.path}${title}`
                : `![${escapeLabel(edit.alt)}](${edit.image.path}${title})`;
        } else if (edit.template) {
            let changed = false;
            for (const reference of edit.references) {
                if (!reference.image.path) continue;
                reference.element.setAttribute('src', reference.image.path);
                reference.element.removeAttribute('srcset');
                changed = true;
            }
            if (changed) replacement = edit.template.innerHTML;
        }
        if (replacement !== undefined) markdown = markdown.slice(0, edit.start) + replacement + markdown.slice(edit.end);
    }
    return markdown;
}

async function exportToMarkdown() {
    if (!beginExport()) return;
    // 在首次等待前固定全文和图片数据，导出期间继续编辑不会改变本次结果。
    const markdown = markdownInput.value;
    const storedImages = new Map(imageDataStore);
    const filename = `madopic-${getFormattedTimestamp()}-markdown.zip`;
    try {
        showNotification('正在打包 Markdown 和图片...', 'info');
        const [parse] = await Promise.all([loadMarkdownArchiveParser(), ensureZipExportLibLoaded()]);
        const { edits, images } = collectMarkdownArchiveImages(markdown, parse, storedImages);
        const zip = new JSZip();
        let next = 0;
        const worker = async () => {
            while (next < images.length) {
                const image = images[next++];
                try {
                    const blob = await loadMarkdownArchiveImage(image.key);
                    const extension = markdownImageExtension(blob.type);
                    const bytes = await blob.arrayBuffer();
                    image.path = `images/image-${String(image.index).padStart(3, '0')}.${extension}`;
                    zip.file(image.path, bytes);
                } catch (error) {
                    image.error = error.name === 'AbortError' ? '图片下载超时' : error.message;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(3, images.length) }, worker));
        zip.file('document.md', rewriteMarkdownArchiveImages(markdown, edits));
        const failures = images.filter(image => image.error);
        if (failures.length) {
            const details = failures.map(image => `${image.source.startsWith('data:') ? '内嵌图片' : image.source}\n原因：${image.error}`).join('\n\n');
            zip.file('export-notes.txt', `有 ${failures.length} 张图片未能打包，document.md 中保留了它们的原始引用。\n网络图片仍需联网访问；丢失的本地图片需要重新插入后再导出。\n\n${details}\n`);
        }
        const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        downloadBlob(archive, filename);
        showNotification(failures.length
            ? `Markdown 已导出；${failures.length} 张图片未打包，详见 export-notes.txt`
            : `Markdown 已导出，包含 ${images.length} 张图片！`, failures.length ? 'warning' : 'success');
    } catch (error) {
        console.error('Markdown 导出失败:', error);
        showNotification('Markdown 导出失败，请重试', 'error');
    } finally {
        endExport();
    }
}

async function exportToPNG() {
    if (!beginExport()) return;
    try {
        const snapshot = createExportSnapshot();
        const isXhs = snapshot.mode === 'xhs';
        showNotification(isXhs ? `正在生成全部 ${snapshot.pages.length} 页 PNG 压缩包...` : '正在生成图片...', 'info');
        await ensureCanvasExportLibLoaded();
        if (isXhs) await ensureZipExportLibLoaded();
        const zip = isXhs ? new JSZip() : null;
        let singleImage;
        const digits = Math.max(3, String(snapshot.pages.length).length);
        await forEachExportPage(snapshot, async (node, index) => {
            const blob = await renderExportPng(node, snapshot.mode);
            if (zip) {
                zip.file(`page-${String(index + 1).padStart(digits, '0')}.png`, blob);
            } else {
                singleImage = blob;
            }
        });
        if (zip) {
            const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
            downloadBlob(archive, `${snapshot.filename}.zip`);
            showNotification(`已导出全部 ${snapshot.pages.length} 页 PNG（ZIP 压缩包）！`, 'success');
        } else {
            downloadBlob(singleImage, `${snapshot.filename}.png`);
            showNotification('图片导出成功！', 'success');
        }
    } catch (error) {
        console.error('PNG 导出失败:', error);
        const message = error.name === 'SecurityError' ? 'PNG 导出失败：包含无法导出的跨域图片' : 'PNG 导出失败，请重试';
        showNotification(message, 'error');
    } finally {
        endExport();
    }
}

async function exportToPDF() {
    if (!beginExport()) return;
    try {
        const snapshot = createExportSnapshot();
        const isXhs = snapshot.mode === 'xhs';
        showNotification(`正在生成 ${snapshot.pages.length} 页可编辑 PDF...`, 'info');
        await ensurePdfExportLibsLoaded();
        if (isXhs) await ensurePdfMergeLibLoaded();
        const mergedPdf = isXhs ? await PDFLib.PDFDocument.create() : null;
        let singlePdf;
        let rasterPages = 0;
        await forEachExportPage(snapshot, async node => {
            await replaceEChartsWithImages(node);
            let pdf;
            try {
                pdf = await exportEditablePDF(node);
            } catch (error) {
                console.warn('可编辑 PDF 页面生成失败，回退为图片页面:', error);
                pdf = await exportRasterPDF(node);
                rasterPages++;
            }
            if (mergedPdf) {
                // 逐页合并，保留每页的文字层、字体和图片；不让 jsPDF 的 HTML 排版跨页覆盖。
                const pageDocument = await PDFLib.PDFDocument.load(pdf.output('arraybuffer'));
                const pages = await mergedPdf.copyPages(pageDocument, pageDocument.getPageIndices());
                pages.forEach(page => mergedPdf.addPage(page));
            } else {
                singlePdf = pdf;
            }
        });
        if (mergedPdf) {
            downloadBlob(new Blob([await mergedPdf.save()], { type: 'application/pdf' }), `${snapshot.filename}.pdf`);
        } else {
            singlePdf.save(`${snapshot.filename}.pdf`);
        }
        showNotification(rasterPages
            ? `PDF 已导出，共 ${snapshot.pages.length} 页，其中 ${rasterPages} 页使用兼容图片模式`
            : `可编辑 PDF 导出成功，共 ${snapshot.pages.length} 页！`, rasterPages ? 'warning' : 'success');
    } catch (error) {
        console.error('PDF 导出失败:', error);
        showNotification('PDF 导出失败，请重试', 'error');
    } finally {
        endExport();
    }
}

const PDF_EDITABLE_FONT_URL = 'https://raw.githubusercontent.com/lxgw/LxgwWenKaiGB/main/fonts/TTF/LXGWWenKaiGB-Regular.ttf';
let editablePdfFontPromise = null;

async function loadEditablePdfFont() {
    if (!editablePdfFontPromise) {
        editablePdfFontPromise = fetch(PDF_EDITABLE_FONT_URL, { cache: 'force-cache' })
            .then(response => {
                if (!response.ok) throw new Error(`中文字体加载失败（${response.status}）`);
                return response.arrayBuffer();
            })
            .then(arrayBufferToBase64)
            .catch(error => {
                editablePdfFontPromise = null;
                throw error;
            });
    }
    return editablePdfFontPromise;
}

function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunks = [];
    const chunkSize = 32768;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize)));
    }
    return btoa(chunks.join(''));
}

function setPdfExportPosition(node) {
    Object.assign(node.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        margin: '0',
        transform: 'none'
    });
}

function preparePdfBackgroundNode(sourceNode) {
    const node = sourceNode.cloneNode(true);
    node.querySelectorAll('.poster-corner').forEach(element => element.remove());
    setPdfExportPosition(node);
    node.querySelectorAll('*').forEach(element => {
        // 公式与图表保留为视觉底图；普通正文会由 PDF 文本层重新绘制。
        if (!element.closest('.katex, .mermaid-container, .echarts-container')) {
            element.style.setProperty('color', 'transparent', 'important');
            element.style.setProperty('text-shadow', 'none', 'important');
        }
    });
    // 公式通常继承段落颜色；隐藏正文后需显式恢复视觉元素的颜色。
    const visualSelector = '.katex, .mermaid-container, .echarts-container';
    const sourceVisuals = sourceNode.querySelectorAll(visualSelector);
    node.querySelectorAll(visualSelector).forEach((element, index) => {
        element.style.setProperty('color', getComputedStyle(sourceVisuals[index]).color, 'important');
    });
    return node;
}

function preparePdfTextNode(sourceNode) {
    const node = sourceNode.cloneNode(true);
    node.querySelectorAll('.poster-corner').forEach(element => element.remove());
    setPdfExportPosition(node);
    node.style.setProperty('background', 'transparent', 'important');
    node.style.setProperty('box-shadow', 'none', 'important');
    node.style.fontFamily = 'LXGWWenKaiGB';

    node.querySelectorAll('*').forEach(element => {
        element.style.setProperty('background', 'transparent', 'important');
        element.style.setProperty('box-shadow', 'none', 'important');
        element.style.setProperty('border-color', 'transparent', 'important');
        element.style.setProperty('outline', 'none', 'important');

        const isRasterVisual = element.matches('img, svg, canvas, video, iframe')
            || element.closest('.katex, .mermaid-container, .echarts-container');
        if (isRasterVisual) {
            element.style.setProperty('visibility', 'hidden', 'important');
        } else {
            element.style.setProperty('font-family', 'LXGWWenKaiGB', 'important');
        }
    });
    return node;
}

async function addPdfHeaderFooter(pdf, sourceNode, width, height) {
    if (!sourceNode.querySelector('.poster-corner')) return;
    const overlayNode = sourceNode.cloneNode(true);
    overlayNode.querySelector('.poster-content')?.remove();
    setPdfExportPosition(overlayNode);
    overlayNode.style.height = `${height}px`;
    overlayNode.style.setProperty('background', 'transparent', 'important');
    overlayNode.style.setProperty('border-color', 'transparent', 'important');
    overlayNode.style.setProperty('box-shadow', 'none', 'important');
    document.body.appendChild(overlayNode);
    let canvas;
    try {
        canvas = await html2canvas(overlayNode, {
            backgroundColor: null, scale: EXPORT_SCALE, width, height,
            windowWidth: width, windowHeight: height, logging: false
        });
        // 在正文文字层之后绘制，保证四角文字始终浮在正文之上，并保留其字体样式。
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, width, height, undefined, 'FAST');
    } finally {
        overlayNode.remove();
        if (canvas) canvas.width = canvas.height = 0;
    }
}

async function exportEditablePDF(sourceNode) {
    const fontBase64 = await loadEditablePdfFont();
    const rect = sourceNode.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);

    const backgroundNode = preparePdfBackgroundNode(sourceNode);
    document.body.appendChild(backgroundNode);
    let backgroundCanvas;
    try {
        backgroundCanvas = await html2canvas(backgroundNode, {
            backgroundColor: null,
            scale: 1,
            useCORS: true,
            allowTaint: false,
            logging: false,
            width,
            height,
            windowWidth: width,
            windowHeight: height
        });
    } finally {
        backgroundNode.remove();
    }

    const textNode = preparePdfTextNode(sourceNode);
    document.body.appendChild(textNode);
    try {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({
            orientation: width > height ? 'landscape' : 'portrait',
            unit: 'px',
            format: [width, height],
            hotfixes: ['px_scaling'],
            compress: true,
            putOnlyUsedFonts: true
        });

        pdf.addImage(backgroundCanvas.toDataURL('image/png'), 'PNG', 0, 0, width, height, undefined, 'FAST');
        pdf.addFileToVFS('LXGWWenKaiGB-Regular.ttf', fontBase64);
        pdf.addFont('LXGWWenKaiGB-Regular.ttf', 'LXGWWenKaiGB', 'normal');
        pdf.addFont('LXGWWenKaiGB-Regular.ttf', 'LXGWWenKaiGB', 'bold');
        pdf.setFont('LXGWWenKaiGB', 'normal');

        await pdf.html(textNode, {
            x: 0,
            y: 0,
            width,
            windowWidth: width,
            autoPaging: false,
            html2canvas: {
                backgroundColor: null,
                scale: 1,
                useCORS: true,
                allowTaint: false,
                logging: false
            }
        });

        await addPdfHeaderFooter(pdf, sourceNode, width, height);
        return pdf;
    } finally {
        textNode.remove();
    }
}

async function exportRasterPDF(exportNode) {
    const rect = exportNode.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    const canvas = await renderWithFallbackScales(
        exportNode,
        width,
        height,
        getExportScaleCandidates(EXPORT_SCALE)
    );
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
        orientation: width > height ? 'landscape' : 'portrait',
        unit: 'px',
        format: [width, height],
        hotfixes: ['px_scaling'],
        compress: true
    });
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, width, height, undefined, 'FAST');
    return pdf;
}

// 导出为独立可打开的 HTML 文件
async function exportToHTML() {
    if (currentMode === 'xhs' || !beginExport()) return;
    let exportNode = null;
    try {
        showNotification('正在生成 HTML...', 'info');

        // 并行拉取需要内联的样式
        const cssFetchPromise = Promise.all([
            fetchCssBySelector('link[href*="style.css"]'),
            fetchCssBySelector('link[rel="stylesheet"][href*="katex"]')
        ]);

        // 克隆并渲染离屏节点
        exportNode = await createExactExportNode();

        // 将 ECharts 图表替换为静态图片，确保离线可见
        await replaceEChartsWithImages(exportNode);

        // 收集样式（尽量内联，失败时保留外链兜底）
        const [localCss, katexCss] = await cssFetchPromise;

        // 组装完整 HTML
        const html = buildStandaloneHTML(exportNode, { localCss, katexCss });

        // 触发下载
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `madopic-${getFormattedTimestamp()}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showNotification('HTML 导出成功！', 'success');
    } catch (error) {
        console.error('HTML 导出失败:', error);
        showNotification('HTML 导出失败，请重试', 'error');
    } finally {
        disposeExportNode(exportNode);
        endExport();
    }
}

// 根据 <link> 选择器抓取 CSS 内容
async function fetchCssBySelector(selector) {
    try {
        const link = document.querySelector(selector);
        if (!link || !link.href) return { inline: '', href: '' };
        const href = link.href;
        const css = await fetchTextSafe(href);
        return { inline: css || '', href };
    } catch (_) {
        return { inline: '', href: '' };
    }
}

// 安全获取文本，失败返回空字符串
async function fetchTextSafe(url) {
    try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) return '';
        return await res.text();
    } catch (_) {
        return '';
    }
}

// 将克隆节点中的 ECharts 图表替换为 <img>（使用实例导出的 dataURL）
async function replaceEChartsWithImages(root) {
    const containers = root.querySelectorAll('.echarts-container');
    for (const container of containers) {
        try {
            // chartContainer 是我们在渲染时创建的内部 div，实例挂在其属性上
            const chartContainer = container.querySelector('div[id^="echarts-"]');
            let dataUrl = '';
            if (chartContainer && chartContainer._echartsInstance && typeof chartContainer._echartsInstance.getDataURL === 'function') {
                dataUrl = chartContainer._echartsInstance.getDataURL({ type: 'png', pixelRatio: 1, backgroundColor: '#ffffff' });
            } else {
                // 兜底：合并所有 canvas 层
                const canvases = container.querySelectorAll('canvas');
                if (canvases.length > 0) {
                    const base = canvases[0];
                    const temp = document.createElement('canvas');
                    temp.width = base.width;
                    temp.height = base.height;
                    const tctx = temp.getContext('2d');
                    canvases.forEach(c => {
                        try { tctx.drawImage(c, 0, 0); } catch (_) { }
                    });
                    dataUrl = temp.toDataURL('image/png');
                }
            }

            if (dataUrl) {
                const img = new Image();
                img.src = dataUrl;
                img.style.width = '100%';
                img.style.height = 'auto';
                // 用静态图替换整个容器内容
                container.innerHTML = '';
                container.appendChild(img);
            }
        } catch (_) {
            // 忽略单个失败，继续处理其他图表
        }
    }
}

// 构建可独立打开的 HTML 文本
function buildStandaloneHTML(exportNode, parts) {
    const { localCss, katexCss } = parts || {};
    const title = document.title || 'Madopic Export';

    // 处理样式注入策略：优先内联，失败时保留外链
    const cssBlocks = [];
    if (localCss && localCss.inline) {
        cssBlocks.push(`<style>\n${localCss.inline}\n</style>`);
    } else if (localCss && localCss.href) {
        cssBlocks.push(`<link rel="stylesheet" href="${localCss.href}">`);
    }

    if (katexCss && katexCss.inline) {
        cssBlocks.push(`<style>\n${katexCss.inline}\n</style>`);
    } else if (katexCss && katexCss.href) {
        cssBlocks.push(`<link rel="stylesheet" href="${katexCss.href}">`);
    }

    // 为导出页添加极简 reset，并强制覆盖离屏/滚动样式，确保可见与可滚动
    cssBlocks.push(`<style>\nhtml,body{margin:0;padding:0;background:#f3f4f6;}\nbody{overflow-y:auto !important;overflow-x:hidden;}\n#madopic-export-poster{position:relative !important;top:auto !important;left:auto !important;margin:40px auto !important;display:block !important;transform:none !important;height:auto !important;min-height:0 !important;overflow:visible !important;}\n#madopic-export-poster .poster-content{max-height:none !important;overflow:visible !important;}\n</style>`);

    const head = `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>${escapeHtml(title)}</title>\n${cssBlocks.join('\n')}\n</head>`;

    // 克隆节点，清理离屏相关 inline 样式
    const node = exportNode.cloneNode(true);
    try {
        node.style.position = '';
        node.style.top = '';
        node.style.left = '';
        node.style.margin = '40px auto';
        node.style.display = 'block';
        node.style.transform = '';
        // 若为固定比例模式（xhs/pyq），取消导出 HTML 的裁剪，保留完整内容
        node.style.height = '';
        node.style.minHeight = '';
        node.style.overflow = 'visible';
        const innerForHtml = node.querySelector('.poster-content');
        if (innerForHtml) {
            innerForHtml.style.maxHeight = '';
            innerForHtml.style.overflow = 'visible';
        }
    } catch (_) { }

    // 仅导出卡片区域，无需运行任何脚本
    const body = `<body>\n${node.outerHTML}\n</body>\n</html>`;

    return `${head}\n${body}`;
}

function escapeHtml(str) {
    try {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    } catch (_) {
        return '' + str;
    }
}

/**
 * 生成按优先级降序的导出 scale 备选列表。
 * 例如：首选 s，然后尝试 2、1.5、1.25、1。
 */
function getExportScaleCandidates(preferred) {
    const candidates = [preferred, 2, 1.5, 1.25, 1];
    const unique = [];
    for (const s of candidates) {
        if (Number.isFinite(s) && s > 0 && !unique.includes(s)) unique.push(s);
    }
    return unique.sort((a, b) => b - a);
}

/**
 * 尝试按多个缩放倍数依次渲染，直到成功为止。
 */
async function renderWithFallbackScales(node, targetWidth, targetHeight, scales) {
    let lastError = null;
    const padding = getComputedStyle(node).padding;
    for (const scale of scales) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const canvas = await html2canvas(node, {
                backgroundColor: null,
                scale,
                useCORS: true,
                allowTaint: false, // 改为 false，避免 canvas 被污染导致 toDataURL() 失败
                logging: false,
                width: targetWidth,
                height: targetHeight,
                windowWidth: targetWidth,
                windowHeight: targetHeight,
                scrollX: 0,
                scrollY: 0,
                imageTimeout: 15000,
                onclone: function (clonedDoc) {
                    const clonedTarget = clonedDoc.getElementById('madopic-export-poster');
                    if (clonedTarget) {
                        clonedTarget.style.setProperty('position', 'absolute', 'important');
                        clonedTarget.style.setProperty('top', '0', 'important');
                        clonedTarget.style.setProperty('left', '0', 'important');
                        clonedTarget.style.setProperty('margin', '0', 'important');
                        clonedTarget.style.setProperty('width', `${targetWidth}px`, 'important');
                        clonedTarget.style.setProperty('padding', padding, 'important');
                        clonedTarget.style.setProperty('box-sizing', 'border-box', 'important');
                    }
                    // 再次为克隆文档内的图片设置跨域/防盗链属性（双保险）
                    try {
                        clonedDoc.querySelectorAll('img').forEach((img) => {
                            if (!img.getAttribute('crossorigin')) img.setAttribute('crossorigin', 'anonymous');
                            if (!img.getAttribute('referrerpolicy')) img.setAttribute('referrerpolicy', 'no-referrer');
                            if (!img.getAttribute('decoding')) img.setAttribute('decoding', 'sync');
                            if (!img.getAttribute('loading')) img.setAttribute('loading', 'eager');
                        });
                    } catch (_) { }

                    // 特殊处理KaTeX数学公式元素
                    try {
                        const katexElements = clonedDoc.querySelectorAll('.katex, .katex-display, .katex-mathml');
                        katexElements.forEach(el => {
                            // 确保KaTeX元素的样式被正确保留
                            el.style.setProperty('font-family', 'KaTeX_Main, "Times New Roman", serif', 'important');
                            if (el.classList.contains('katex-display')) {
                                el.style.setProperty('display', 'block', 'important');
                                el.style.setProperty('text-align', 'center', 'important');
                            }
                        });
                    } catch (_) { }

                    // 特殊处理Mermaid图表SVG
                    try {
                        const mermaidSvgs = clonedDoc.querySelectorAll('.mermaid svg');
                        mermaidSvgs.forEach(svg => {
                            // 确保SVG有明确的尺寸和样式
                            if (!svg.getAttribute('width') && svg.getBoundingClientRect) {
                                const rect = svg.getBoundingClientRect();
                                if (rect.width > 0) svg.setAttribute('width', rect.width);
                                if (rect.height > 0) svg.setAttribute('height', rect.height);
                            }
                            svg.style.setProperty('display', 'block', 'important');
                            svg.style.setProperty('max-width', '100%', 'important');
                        });
                    } catch (_) { }

                    clonedDoc.documentElement.style.setProperty('overflow', 'hidden', 'important');
                    clonedDoc.body.style.setProperty('margin', '0', 'important');
                    clonedDoc.body.style.setProperty('padding', '0', 'important');
                }
            });
            if (scale !== scales[0]) {
                showNotification(`显存不足，已自动降至 ${Math.round(scale * 100)}% 清晰度导出`, 'warning');
            }
            return canvas;
        } catch (err) {
            lastError = err;
            // 继续尝试下一个较低的 scale
        }
    }
    throw lastError || new Error('所有缩放倍数均导出失败');
}

// ===== 通知系统 =====
function showNotification(message, type = 'info') {
    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    const content = document.createElement('div');
    content.className = 'notification-content';
    const icon = document.createElement('i');
    icon.className = `fas ${getNotificationIcon(type)}`;
    const text = document.createElement('span');
    text.textContent = message;
    content.append(icon, text);
    notification.appendChild(content);

    // 添加样式
    Object.assign(notification.style, {
        position: 'fixed',
        top: '80px',
        right: '20px',
        background: getNotificationColor(type),
        color: 'white',
        padding: '12px 20px',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
        zIndex: '10000',
        transform: 'translateX(100%)',
        transition: 'transform 0.3s ease',
        fontSize: '14px',
        fontWeight: '500'
    });

    // 如果存在缩放工具栏，则将通知定位到百分比（缩放工具栏）下方
    try {
        const anchor = document.querySelector('.preview-tools') || document.querySelector('.zoom-level');
        if (anchor && typeof anchor.getBoundingClientRect === 'function') {
            const rect = anchor.getBoundingClientRect();
            // fixed 定位采用视口坐标，直接使用 rect.bottom 即可
            const computedTop = Math.max(rect.bottom + 10, 10);
            notification.style.top = `${Math.round(computedTop)}px`;
        } else {
            // 略微下移默认位置，避免遮挡顶部工具栏
            notification.style.top = '120px';
        }
    } catch (e) {
        // 发生异常时退回到略低的默认位置
        notification.style.top = '120px';
    }

    content.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
    `;

    document.body.appendChild(notification);

    // 动画显示
    setTimeout(() => {
        notification.style.transform = 'translateX(0)';
    }, 100);

    // 自动隐藏
    setTimeout(() => {
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (notification.parentNode) {
                document.body.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

function getNotificationIcon(type) {
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        info: 'fa-info-circle',
        warning: 'fa-exclamation-triangle'
    };
    return icons[type] || icons.info;
}

function getNotificationColor(type) {
    const colors = {
        success: '#10b981',
        error: '#ef4444',
        info: '#3b82f6',
        warning: '#f59e0b'
    };
    return colors[type] || colors.info;
}

// ===== 预览翻页与键盘快捷键 =====
function isPreviewNavigationBlocked(event) {
    return currentMode !== 'xhs' || event.defaultPrevented || event.isComposing
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || overlay.classList.contains('active') || event.target?.isContentEditable
        || event.target?.closest?.('input, textarea, select, #documentSidebar, #exportMenu, #insertTemplates, [role="textbox"], [role="slider"], [role="combobox"], [role="spinbutton"]');
}

function handlePreviewPageKeydown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
        || isPreviewNavigationBlocked(event)) return;
    // 保留文字光标、表单控件和弹窗中的方向键操作。
    event.preventDefault();
    return changePreviewPage(['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
}

function handlePreviewPageWheel(event) {
    if (isPreviewNavigationBlocked(event) || previewPages.length <= 1
        || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    // 一次触控板手势只翻一页，忽略其后的惯性事件；停顿或反向滚动后可继续翻页。
    const direction = Math.sign(event.deltaY);
    const time = event.timeStamp;
    if (time - previewWheelGesture.time > 180 || direction !== previewWheelGesture.direction) {
        previewWheelGesture = { time, direction, delta: 0, paged: false };
    }
    previewWheelGesture.time = time;
    if (previewWheelGesture.paged) return;
    // WheelEvent 可使用像素、行或页作为单位。
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1;
    previewWheelGesture.delta += event.deltaY * unit;
    if (Math.abs(previewWheelGesture.delta) < 40) return;
    previewWheelGesture.paged = true;
    return changePreviewPage(direction);
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', handlePreviewPageKeydown);
    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey || e.metaKey) {
            switch (e.key) {
                case 'b':
                    e.preventDefault();
                    handleToolbarAction('bold');
                    break;
                case 'i':
                    e.preventDefault();
                    handleToolbarAction('italic');
                    break;
                case 's':
                    e.preventDefault();
                    exportToPNG();
                    break;
                case '=':
                case '+':
                    e.preventDefault();
                    zoomIn();
                    break;
                case '-':
                    e.preventDefault();
                    zoomOut();
                    break;
            }
        }

        // ESC 键关闭面板
        if (e.key === 'Escape') {
            closeAllPanels();
        }
    });
}

// ===== 错误处理 =====
window.addEventListener('error', function (e) {
    console.error('应用错误:', e.error);
    showNotification('应用出现错误，请刷新页面重试', 'error');
});

// 页面可见性改变时优化性能
document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
        // 页面隐藏时暂停某些操作
    } else {
        // 页面可见时恢复操作
        updatePreview();
    }
});

// 添加一些实用的格式化快捷方法
const MarkdownHelper = {
    // 插入表格
    insertTable: function (rows = 3, cols = 3) {
        const textarea = markdownInput;
        let table = '\n| ';

        // 表头
        for (let i = 0; i < cols; i++) {
            table += `列${i + 1} | `;
        }
        table += '\n| ';

        // 分隔线
        for (let i = 0; i < cols; i++) {
            table += '--- | ';
        }
        table += '\n';

        // 数据行
        for (let row = 0; row < rows - 1; row++) {
            table += '| ';
            for (let col = 0; col < cols; col++) {
                table += '数据 | ';
            }
            table += '\n';
        }

        const cursorPos = textarea.selectionStart;
        const beforeText = textarea.value.substring(0, cursorPos);
        const afterText = textarea.value.substring(cursorPos);

        applyEditorChange(
            beforeText + table + afterText,
            cursorPos + table.length,
            cursorPos + table.length,
            { focus: false }
        );
    },

    // 插入代码块
    insertCodeBlock: function (language = '') {
        const textarea = markdownInput;
        const codeBlock = `\n\`\`\`${language}\n// 在这里输入代码\nconsole.log('Hello World!');\n\`\`\`\n`;

        const cursorPos = textarea.selectionStart;
        const beforeText = textarea.value.substring(0, cursorPos);
        const afterText = textarea.value.substring(cursorPos);

        applyEditorChange(
            beforeText + codeBlock + afterText,
            cursorPos + 4 + language.length,
            cursorPos + 4 + language.length,
            { focus: false }
        );
    },

    // 通用的插入方法
    insertAtCursor: function (text) {
        const textarea = markdownInput;
        const cursorPos = textarea.selectionStart;
        const beforeText = textarea.value.substring(0, cursorPos);
        const afterText = textarea.value.substring(cursorPos);

        applyEditorChange(
            beforeText + text + afterText,
            cursorPos + text.length,
            cursorPos + text.length
        );
    },

    // 插入质能守恒公式
    insertEinsteinFormula: function () {
        const formula = `

## 质能守恒定律

$$E = mc^{2}$$

其中：
- $E$ 表示能量
- $m$ 表示质量  
- $c$ 表示光速

`;
        this.insertAtCursor(formula);
    },

    // 插入数学公式模板
    insertMathFormulas: function () {
        const formulas = `

## 常用数学公式

### 代数
**二次公式：** $x = \\frac{-b \\pm \\sqrt{b^{2} - 4ac}}{2a}$

**因式分解：** $a^{2} - b^{2} = (a+b)(a-b)$

### 微积分
**导数定义：** $f'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}$

**基本积分：** $\\int_a^b f(x)dx = F(b) - F(a)$

### 三角函数
**勾股定理：** $a^{2} + b^{2} = c^{2}$

**正弦定理：** $\\frac{a}{\\sin A} = \\frac{b}{\\sin B} = \\frac{c}{\\sin C}$

### 统计学
**均值：** $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$

**方差：** $\\sigma^{2} = \\frac{1}{n}\\sum_{i=1}^{n} (x_i - \\bar{x})^{2}$

`;
        this.insertAtCursor(formulas);
    },

    // 插入物理公式模板
    insertPhysicsFormulas: function () {
        const formulas = `

## 物理公式集合

### 经典力学
**牛顿第二定律：** $F = ma$

**万有引力定律：** $F = G\\frac{m_1 m_2}{r^{2}}$

**动能：** $E_k = \\frac{1}{2}mv^{2}$

**势能：** $E_p = mgh$

### 电磁学
**库仑定律：** $F = k\\frac{q_1 q_2}{r^{2}}$

**欧姆定律：** $V = IR$

**电功率：** $P = VI = I^{2}R = \\frac{V^{2}}{R}$

### 现代物理
**质能关系：** $E = mc^{2}$

**德布罗意波长：** $\\lambda = \\frac{h}{p}$

**海森堡不确定性原理：** $\\Delta x \\Delta p \\geq \\frac{\\hbar}{2}$

`;
        this.insertAtCursor(formulas);
    },

    // 插入化学公式模板
    insertChemistryFormulas: function () {
        const formulas = `

## 化学公式集合

### 基本化学反应
**燃烧反应：** $\\ce{CH4 + 2O2 -> CO2 + 2H2O}$

**酸碱中和：** $\\ce{HCl + NaOH -> NaCl + H2O}$

**氧化还原：** $\\ce{2Na + Cl2 -> 2NaCl}$

### 有机化学
**甲烷：** $\\ce{CH4}$

**乙醇：** $\\ce{C2H5OH}$

**葡萄糖：** $\\ce{C6H12O6}$

### 化学平衡
**平衡常数：** $K_c = \\frac{[C]^c[D]^d}{[A]^a[B]^b}$

**pH定义：** $pH = -\\log[H^+]$

### 理想气体
**理想气体定律：** $PV = nRT$

`;
        this.insertAtCursor(formulas);
    },

    // 插入流程图
    insertFlowchart: function () {
        const flowchart = `
\`\`\`mermaid
flowchart TD
    A[开始] --> B{判断条件}
    B -->|是| C[执行操作]
    B -->|否| D[其他操作]
    C --> E[结束]
    D --> E
\`\`\`
`;
        this.insertAtCursor(flowchart);
    },

    // 插入序列图
    insertSequenceDiagram: function () {
        const sequenceDiagram = `
\`\`\`mermaid
sequenceDiagram
    participant A as 用户
    participant B as 系统
    A->>B: 发送请求
    B-->>A: 返回响应
    A->>B: 确认收到
\`\`\`
`;
        this.insertAtCursor(sequenceDiagram);
    },

    // 插入甘特图
    insertGanttChart: function () {
        const ganttChart = `
\`\`\`mermaid
gantt
    title 项目进度计划
    dateFormat  YYYY-MM-DD
    section 阶段一
    任务1           :a1, 2024-01-01, 30d
    任务2           :after a1, 20d
    section 阶段二
    任务3           :2024-02-01, 25d
    任务4           :20d
\`\`\`
`;
        this.insertAtCursor(ganttChart);
    },

    // 插入饼图
    insertPieChart: function () {
        const pieChart = `
\`\`\`mermaid
pie title 数据分布
    "类别A" : 42.96
    "类别B" : 50.05
    "类别C" : 10.01
    "其他" : 5
\`\`\`
`;
        this.insertAtCursor(pieChart);
    },

    // 插入卡片
    insertCard: function () {
        const cardTemplate = `

:::card
**卡片标题**

这是一个精美的卡片内容区域。你可以在这里添加：

- 重要信息
- 产品特色
- 使用说明
- 任何想要突出显示的内容

支持 **粗体**、*斜体*、\`代码\` 和 [链接](https://example.com) 等格式。
:::

**不同类型的卡片示例：**

:::card info
**信息卡片**

这是一个信息类型的卡片，适合展示提示信息。
:::

:::card success
**成功卡片**

这是一个成功类型的卡片，适合展示成功状态。
:::

:::card warning
**警告卡片**

这是一个警告类型的卡片，适合展示注意事项。
:::

:::card error
**错误卡片**

这是一个错误类型的卡片，适合展示错误信息。
:::

`;
        this.insertAtCursor(cardTemplate);
    },

    // 插入ECharts图表模板
    insertEChartsTemplate: function () {
        const echartsTemplate = `

## ECharts 图表示例

### 饼图
\`\`\`echarts
{
  "title": {
    "text": "访问来源统计",
    "left": "center"
  },
  "tooltip": {
    "trigger": "item",
    "formatter": "{a} <br/>{b} : {c} ({d}%)"
  },
  "legend": {
    "orient": "vertical",
    "left": "left",
    "data": ["搜索引擎", "直接访问", "推荐", "其他", "社交平台"]
  },
  "series": [{
    "name": "访问来源",
    "type": "pie",
    "radius": "55%",
    "center": ["50%", "60%"],
    "data": [
      {"value": 10440, "name": "搜索引擎"},
      {"value": 4770, "name": "直接访问"},
      {"value": 2430, "name": "推荐"},
      {"value": 342, "name": "其他"},
      {"value": 18, "name": "社交平台"}
    ]
  }]
}
\`\`\`

### 柱状图
\`\`\`echarts
{
  "title": {
    "text": "月度销售数据",
    "left": "center"
  },
  "tooltip": {
    "trigger": "axis"
  },
  "xAxis": {
    "type": "category",
    "data": ["1月", "2月", "3月", "4月", "5月", "6月"]
  },
  "yAxis": {
    "type": "value"
  },
  "series": [{
    "name": "销售额",
    "type": "bar",
    "data": [120, 200, 150, 80, 70, 110],
    "itemStyle": {
      "color": "#5470c6"
    }
  }]
}
\`\`\`

`;
        this.insertAtCursor(echartsTemplate);
    }
};

// 图片处理相关函数
function insertImage() {
    const imageInput = document.getElementById('imageInput');
    imageInput.click();
}

function setupImageHandlers() {
    const imageInput = document.getElementById('imageInput');

    // 文件选择处理
    imageInput.addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (file && file.type.startsWith('image/')) {
            handleImageFile(file);
        }
        // 清空输入，允许选择同一文件
        e.target.value = '';
    });

    // 剪贴板粘贴图片处理
    markdownInput.addEventListener('paste', function (e) {
        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    handleImageFile(file);
                }
                break;
            }
        }
    });
}

function handleImageFile(file) {
    showNotification('正在处理图片...', 'info');

    convertImageToBase64(file)
        .then(base64 => {
            insertImageIntoMarkdown(base64, file.name);
            showNotification('图片插入成功！', 'success');
        })
        .catch(error => {
            console.error('图片处理失败:', error);
            showNotification('图片处理失败，请重试', 'error');
        });
}

function convertImageToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function (e) {
            resolve(e.target.result);
        };
        reader.onerror = function (error) {
            reject(error);
        };
        reader.readAsDataURL(file);
    });
}

function insertImageIntoMarkdown(base64, filename) {
    const textarea = markdownInput;
    const cursorPos = textarea.selectionStart;
    const beforeText = textarea.value.substring(0, cursorPos);
    const afterText = textarea.value.substring(cursorPos);

    // 使用稳定短引用，完整图片数据保存在内存与 IndexedDB 中
    const randomId = window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
    const imageReference = `madopic-image://${randomId}`;
    const imageMarkdown = `\n![${filename}](${imageReference})\n`;

    // 存储完整的图片数据供预览和导出使用
    storeImageData(imageReference, base64);

    // 插入到光标位置
    applyEditorChange(
        beforeText + imageMarkdown + afterText,
        cursorPos + imageMarkdown.length,
        cursorPos + imageMarkdown.length
    );
}

// 存储图片数据映射
function storeImageData(shortBase64, fullBase64) {
    imageDataStore.set(shortBase64, fullBase64);
    if (typeof indexedDB !== 'undefined') {
        ImagePersistence.save(shortBase64, fullBase64).catch((error) => {
            console.warn('图片持久化失败，将仅在当前页面保留:', error);
            if (!hasShownImagePersistenceWarning) {
                hasShownImagePersistenceWarning = true;
                showNotification('图片已插入，但浏览器无法持久保存；刷新后可能需要重新插入', 'warning');
            }
        });
    }
}

// 替换预览中的简化base64为完整base64
function replaceImageDataForPreview(content) {
    let result = content;
    imageDataStore.forEach((fullBase64, shortBase64) => {
        result = result.replace(new RegExp(escapeRegExp(shortBase64), 'g'), fullBase64);
    });
    return result;
}

// 转义正则表达式特殊字符
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 生成格式化的时间戳字符串 (YYYYMMDDHHMMSS)
function getFormattedTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

// 获取当前配置（便于调试与外部接入）
function getCurrentMadopicConfig() {
    return {
        width: currentWidth,
        padding: currentPadding,
        fontSize: currentFontSize,
        background: markdownPoster.style.background,
        exportScale: EXPORT_SCALE
    };
}

// 导出全局对象供调试使用
window.MadopicApp = {
    updatePreview,
    exportToPNG,
    exportToPDF,
    exportToMarkdown,
    applyBackground,
    MarkdownHelper,
    showNotification,
    insertImage,
    handleImageFile,
    getCurrentMadopicConfig,
    mathRenderer,
    diagramRenderer,
    echartsRenderer,
    cardRenderer
};

/**
 * 裁剪画布四周完全透明的像素，去除导出后可能出现的空白边缘。
 * 返回新的裁剪画布；若无需裁剪则返回 null。
 */
function trimTransparentEdges(sourceCanvas) {
    const ctx = sourceCanvas.getContext('2d');
    const { width, height } = sourceCanvas;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    let top = 0;
    let bottom = height - 1;
    let left = 0;
    let right = width - 1;
    const isRowTransparent = (y) => {
        const base = y * width * 4;
        for (let x = 0; x < width; x++) {
            if (data[base + x * 4 + 3] !== 0) return false;
        }
        return true;
    };
    const isColTransparent = (x, t, b) => {
        for (let y = t; y <= b; y++) {
            const idx = (y * width + x) * 4 + 3;
            if (data[idx] !== 0) return false;
        }
        return true;
    };

    while (top <= bottom && isRowTransparent(top)) top++;
    while (bottom >= top && isRowTransparent(bottom)) bottom--;
    while (left <= right && isColTransparent(left, top, bottom)) left++;
    while (right >= left && isColTransparent(right, top, bottom)) right--;

    // 若全透明或无需要裁剪
    if (top === 0 && left === 0 && right === width - 1 && bottom === height - 1) return null;
    if (top > bottom || left > right) return null;

    const newWidth = right - left + 1;
    const newHeight = bottom - top + 1;
    const trimmed = document.createElement('canvas');
    trimmed.width = newWidth;
    trimmed.height = newHeight;
    const tctx = trimmed.getContext('2d');
    tctx.drawImage(sourceCanvas, left, top, newWidth, newHeight, 0, 0, newWidth, newHeight);
    return trimmed;
}

// ===== 撤销/重做快捷键 =====
document.addEventListener('keydown', (e) => {
    // Ctrl+Z 撤销
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        const state = undoRedoManager.undo();
        if (state !== null && markdownInput) {
            undoRedoManager.isUndoRedo = true;
            markdownInput.value = state;
            undoRedoManager.isUndoRedo = false;
            updatePreview();
        }
    }
    // Ctrl+Y 或 Ctrl+Shift+Z 重做
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        const state = undoRedoManager.redo();
        if (state !== null && markdownInput) {
            undoRedoManager.isUndoRedo = true;
            markdownInput.value = state;
            undoRedoManager.isUndoRedo = false;
            updatePreview();
        }
    }
});

// 保存输入状态到撤销栈（防抖）
const pushUndoState = debounce(() => {
    if (markdownInput) {
        undoRedoManager.push(markdownInput.value);
    }
}, 500);

// ===== 拖拽图片插入 =====
function setupDragDropImage() {
    if (!markdownInput) return;

    markdownInput.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        markdownInput.classList.add('drag-over');
    });

    markdownInput.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        markdownInput.classList.remove('drag-over');
    });

    markdownInput.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        markdownInput.classList.remove('drag-over');

        const files = e.dataTransfer.files;
        for (const file of files) {
            if (file.type.startsWith('image/')) {
                await handleImageFile(file);
            }
        }
    });
}

// ===== 触屏双指缩放 =====
function setupPinchZoom() {
    const previewContainer = document.getElementById('previewContainer');
    if (!previewContainer) return;

    let initialDistance = 0;
    let initialZoom = 100;

    previewContainer.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            initialDistance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            initialZoom = currentZoom;
        }
    }, { passive: true });

    previewContainer.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
            const currentDistance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const scale = currentDistance / initialDistance;
            let newZoom = Math.round(initialZoom * scale);
            newZoom = Math.max(25, Math.min(200, newZoom));
            if (newZoom !== currentZoom) {
                currentZoom = newZoom;
                const previewContent = document.querySelector('.preview-content');
                if (previewContent) {
                    previewContent.style.transform = `scale(${currentZoom / 100})`;
                }
                const zoomLevel = document.querySelector('.zoom-level');
                if (zoomLevel) {
                    zoomLevel.textContent = `${currentZoom}%`;
                }
            }
        }
    }, { passive: true });
}

// ===== 汉堡菜单（移动端响应式） =====
function setupHamburgerMenu() {
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const toolbarRight = document.getElementById('toolbarRight');
    if (!hamburgerBtn || !toolbarRight) return;

    hamburgerBtn.addEventListener('click', () => {
        toolbarRight.classList.toggle('mobile-open');
        hamburgerBtn.classList.toggle('active');
        if (toolbarRight.classList.contains('mobile-open') && window.innerWidth <= 1200) {
            setDocumentSidebarOpen(false);
        }
        if (!toolbarRight.classList.contains('mobile-open')) setExportMenuOpen(false);
    });

    // 点击菜单项后自动关闭
    toolbarRight.addEventListener('click', (e) => {
        const button = e.target.closest('.btn');
        if (button && button.id !== 'exportMenuBtn' && !button.disabled) {
            toolbarRight.classList.remove('mobile-open');
            hamburgerBtn.classList.remove('active');
        }
    });
}

// ===== 文档侧边栏 =====
function setDocumentSidebarOpen(open) {
    document.getElementById('documentSidebar').hidden = !open;
    document.getElementById('documentsBtn').setAttribute('aria-expanded', String(open));
    document.getElementById('documentSidebarBackdrop').hidden = !open || window.innerWidth > 1200;
    if (open && window.innerWidth <= 1200) {
        document.getElementById('toolbarRight').classList.remove('mobile-open');
        document.getElementById('hamburgerBtn').classList.remove('active');
        setExportMenuOpen(false);
    }
}

function renderDocumentList() {
    if (!documentLibrary) return;
    const list = document.getElementById('documentList');
    list.replaceChildren();
    for (const record of documentLibrary.list()) {
        const button = document.createElement('button');
        button.className = 'document-item';
        button.type = 'button';
        button.dataset.documentId = record.id;
        button.setAttribute('aria-current', String(record.id === documentLibrary.activeId));
        const title = document.createElement('span');
        title.className = 'document-item-title';
        title.textContent = documentLibrary.title(record);
        const date = document.createElement('small');
        date.textContent = new Date(record.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        button.append(title, date);
        list.appendChild(button);
    }
    document.getElementById('documentCount').textContent = `${documentLibrary.records.size} 篇`;
    if (documentLibrary.active) document.getElementById('documentName').placeholder = documentLibrary.title(documentLibrary.active);
}

function setupDocumentSidebar() {
    const sidebar = document.getElementById('documentSidebar');
    document.getElementById('documentsBtn').addEventListener('click', () => setDocumentSidebarOpen(sidebar.hidden));
    document.getElementById('closeDocumentsBtn').addEventListener('click', () => setDocumentSidebarOpen(false));
    document.getElementById('documentSidebarBackdrop').addEventListener('click', () => setDocumentSidebarOpen(false));
    const perform = async action => {
        if (!documentLibrary) return;
        try {
            // 切换之前同步输入，覆盖尚未完成的预览去抖。
            await documentLibrary.save(markdownInput.value);
            await action();
            if (window.innerWidth <= 1200) setDocumentSidebarOpen(false);
        } catch (error) {
            showNotification('文档未能保存，已保留当前内容，请重试或导出 Markdown', 'error');
        }
    };
    document.getElementById('newDocumentBtn').addEventListener('click', () => perform(() => documentLibrary.create()));
    document.getElementById('documentList').addEventListener('click', event => {
        const button = event.target.closest('[data-document-id]');
        if (button) perform(() => documentLibrary.select(button.dataset.documentId));
    });
    document.getElementById('documentName').addEventListener('input', event => {
        documentLibrary?.save(markdownInput.value, event.target.value.trim().slice(0, 80)).catch(() => {});
        renderHeaderFooter(markdownPoster, headerFooterDraft || currentHeaderFooter);
    });
    document.getElementById('retryDocumentSave').addEventListener('click', () => perform(() => documentLibrary.flush()));
    window.addEventListener('pagehide', () => autoSave(markdownInput.value));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') autoSave(markdownInput.value);
    });
    window.addEventListener('resize', () => setDocumentSidebarOpen(!sidebar.hidden));
}

async function initializeDocumentLibrary() {
    const draft = loadDraft();
    try {
        const database = await ImagePersistence.open();
        documentLibrary = new MadopicDocumentLibrary(database, {
            onChange: renderDocumentList,
            onStatus: text => {
                document.getElementById('documentSaveStatus').textContent = text;
                document.getElementById('retryDocumentSave').hidden = !text.startsWith('保存失败');
            },
            onLoad: record => {
                markdownInput.value = record.content;
                currentPreviewPage = 0;
                undoRedoManager.history = [];
                undoRedoManager.index = -1;
                undoRedoManager.push(record.content);
                document.getElementById('documentName').value = record.name;
                try { localStorage.setItem('madopic_active_document', record.id); } catch (_) { }
                updatePreview();
            }
        });
        let activeId;
        try { activeId = localStorage.getItem('madopic_active_document'); } catch (_) { }
        await documentLibrary.initialize(draft ?? markdownInput.value, activeId, draft !== null);
        // 只有数据库事务成功后才删除旧草稿；空文档也会完整迁移。
        try { localStorage.removeItem(AUTOSAVE_KEY); } catch (_) { }
        document.getElementById('newDocumentBtn').disabled = false;
        document.getElementById('documentName').disabled = false;
        setDocumentSidebarOpen(window.innerWidth > 1200);
    } catch (error) {
        documentLibrary = null;
        if (draft !== null) markdownInput.value = draft;
        document.getElementById('documentSaveStatus').textContent = '文档库不可用，使用本地草稿';
        showNotification('浏览器文档库暂不可用，正文将保留为本地草稿', 'warning');
    } finally {
        markdownInput.readOnly = false;
    }
}

// ===== 设置恢复 =====
function restoreSettings() {
    const settings = loadSettings();
    let shouldRefreshPreview = false;

    // 恢复设置
    if (settings) {
        currentHeaderFooter = normalizeHeaderFooterSettings(settings.headerFooter);
        renderHeaderFooter(markdownPoster);
        if (settings.background === 'custom' || Object.hasOwn(backgroundPresets, settings.background)) {
            currentBackground = settings.background;
        }
        const custom = settings.customBackground || {};
        for (const color of ['colorStart', 'colorEnd']) {
            if (/^#[0-9a-f]{6}$/i.test(custom[color])) currentCustomBackground[color] = custom[color];
        }
        if (['135deg', '45deg', '0deg', '90deg', '180deg', '270deg'].includes(custom.direction)) {
            currentCustomBackground.direction = custom.direction;
        }
        applyBackground(getBackgroundCSS());
        if (/^#[0-9a-f]{6}$/i.test(settings.cardColor)) currentCardColor = settings.cardColor;
        applyCardColor(currentCardColor);
        if (Number.isFinite(settings.fontSize)) {
            currentFontSize = settings.fontSize;
            const fontSizeSlider = document.getElementById('fontSizeSlider');
            const fontSizeValue = document.getElementById('fontSizeValue');
            if (fontSizeSlider) fontSizeSlider.value = currentFontSize;
            if (fontSizeValue) fontSizeValue.textContent = `${currentFontSize}px`;
            applyFontSize(currentFontSize);
            shouldRefreshPreview = true;
        }
        if (Number.isFinite(settings.padding)) {
            currentPadding = settings.padding;
            const paddingSlider = document.getElementById('paddingSlider');
            const paddingValue = document.getElementById('paddingValue');
            if (paddingSlider) paddingSlider.value = currentPadding;
            if (paddingValue) paddingValue.textContent = `${currentPadding}px`;
            applyPadding(currentPadding);
            shouldRefreshPreview = true;
        }
        if (Number.isFinite(settings.width)) {
            currentWidth = settings.width;
            const widthSlider = document.getElementById('widthSlider');
            const widthValue = document.getElementById('widthValue');
            if (widthSlider) widthSlider.value = currentWidth;
            if (widthValue) widthValue.textContent = `${currentWidth}px`;
            applyWidth(currentWidth);
            shouldRefreshPreview = true;
        }
        if (settings.mode && ['free', 'xhs', 'pyq'].includes(settings.mode)) {
            setMode(settings.mode);
            shouldRefreshPreview = true;
        }
    }

    if (shouldRefreshPreview) {
        updateLineNumbers();
        updatePreview();
    }
}

// ===== 初始化所有优化功能 =====
async function initOptimizations() {
    // 先恢复本地图片映射，避免草稿首次渲染出现失效的短引用
    try {
        await ImagePersistence.loadAll();
    } catch (error) {
        console.warn('本地图片存储不可用，将使用内存模式:', error);
    }

    // 设置保持全局，正文从文档库恢复（旧版本 localStorage 草稿自动迁移）。
    restoreSettings();
    await initializeDocumentLibrary();

    // 初始化撤销栈
    if (markdownInput) {
        undoRedoManager.push(markdownInput.value);

        // 监听输入事件，记录撤销状态
        markdownInput.addEventListener('input', () => {
            pushUndoState();
        });
    }

    // 设置拖拽图片
    setupDragDropImage();

    // 设置触屏缩放
    setupPinchZoom();

    // 设置汉堡菜单
    setupHamburgerMenu();

    console.log('Madopic 优化功能已初始化');
}
