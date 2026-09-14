// 多文档正文存放在 IndexedDB；界面和应用设置由主程序管理。
class MadopicDocumentLibrary {
    constructor(database, { onChange = () => {}, onStatus = () => {}, onLoad = () => {} } = {}) {
        this.database = database;
        this.onChange = onChange;
        this.onStatus = onStatus;
        this.onLoad = onLoad;
        this.records = new Map();
        this.pending = new Map();
        this.dirty = new Set();
        this.activeId = null;
        this.busy = false;
    }

    title(record) {
        return MadopicDocumentLibrary.title(record);
    }

    static title(record) {
        const firstLine = record.content.split(/\r?\n/).find(line => line.trim()) || '';
        return record.name || firstLine.replace(/^\s*#{1,6}\s+/, '').trim().slice(0, 40) || '未命名文档';
    }

    get active() { return this.records.get(this.activeId); }

    list() { return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt); }

    async initialize(initialContent, preferredId, migrateLegacyDraft = false) {
        const records = await new Promise((resolve, reject) => {
            const request = this.database.transaction('documents', 'readonly').objectStore('documents').getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        records.forEach(record => this.records.set(record.id, record));
        if (!records.length || (migrateLegacyDraft && !records.some(record => record.content === initialContent))) {
            const record = this.makeRecord(initialContent);
            await this.write(record);
            this.records.set(record.id, record);
            preferredId = record.id;
        }
        this.activate(this.records.has(preferredId) ? preferredId : this.list()[0].id);
    }

    makeRecord(content = '') {
        const now = Date.now();
        return {
            id: globalThis.crypto?.randomUUID?.() || `${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
            name: '', content, createdAt: now, updatedAt: now
        };
    }

    write(record) {
        // 立即开启事务；IndexedDB 按创建顺序提交读写事务，旧保存不会覆盖新内容。
        return new Promise((resolve, reject) => {
            const transaction = this.database.transaction('documents', 'readwrite');
            transaction.objectStore('documents').put(record);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('文档保存失败'));
            transaction.onabort = () => reject(transaction.error || new Error('文档保存已中止'));
        });
    }

    save(content, name = this.active?.name || '') {
        if (!this.active) return Promise.resolve();
        const current = this.active;
        if (current.content === content && current.name === name && (!this.dirty.has(current.id) || this.pending.has(current.id))) {
            return this.pending.get(current.id) || Promise.resolve();
        }
        const record = { ...current, content, name, updatedAt: Date.now() };
        this.records.set(record.id, record);
        this.dirty.add(record.id);
        this.onStatus('正在保存…');
        const pending = this.write(record).then(() => {
            if (this.pending.get(record.id) !== pending) return;
            this.pending.delete(record.id);
            this.dirty.delete(record.id);
            this.onChange();
            if (this.activeId === record.id) this.onStatus('已保存到浏览器');
        }, error => {
            if (this.pending.get(record.id) === pending) {
                this.pending.delete(record.id);
                if (this.activeId === record.id) this.onStatus('保存失败，请重试');
            }
            throw error;
        });
        this.pending.set(record.id, pending);
        // 输入事件不会等待 Promise；失败状态仍由 flush 阻止丢失内容的切换。
        pending.catch(() => {});
        return pending;
    }

    async flush() {
        if (this.active && this.dirty.has(this.activeId) && !this.pending.has(this.activeId)) {
            await this.save(this.active.content);
        }
        await this.pending.get(this.activeId);
    }

    activate(id) {
        this.activeId = id;
        this.onLoad(this.active);
        this.onChange();
        this.onStatus('已保存到浏览器');
    }

    async select(id) {
        if (this.busy || !this.records.has(id)) return;
        if (id === this.activeId) return this.flush();
        this.busy = true;
        try {
            await this.flush();
            this.activate(id);
        } finally {
            this.busy = false;
        }
    }

    async create() {
        if (this.busy) return;
        this.busy = true;
        try {
            await this.flush();
            const record = this.makeRecord();
            await this.write(record);
            this.records.set(record.id, record);
            this.activate(record.id);
        } finally {
            this.busy = false;
        }
    }
}
