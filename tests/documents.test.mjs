import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';

const context = vm.createContext({ crypto: globalThis.crypto, console });
vm.runInContext(readFileSync(new URL('../documents.js', import.meta.url), 'utf8'), context);
const Library = vm.runInContext('MadopicDocumentLibrary', context);
const indexedDB = new IDBFactory();
const database = await new Promise((resolve, reject) => {
  const request = indexedDB.open('madopic-test', 2);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('images', { keyPath: 'id' });
    request.result.createObjectStore('documents', { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const read = id => new Promise((resolve, reject) => {
  const request = database.transaction('documents', 'readonly').objectStore('documents').get(id);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const loaded = [];
const statuses = [];
const library = new Library(database, {
  onLoad: record => loaded.push(record.content),
  onStatus: status => statuses.push(status),
});

// Migration preserves empty drafts, and reopening must not recreate a default document.
await library.initialize('', null, true);
assert.equal(library.active.content, '');
const firstId = library.activeId;
assert.equal((await read(firstId)).content, '');
assert.equal(library.title(library.active), '未命名文档');
await library.save('# 第一篇\n\n![图片](madopic-image://persisted)', '笔记一');
await library.create();
const secondId = library.activeId;
assert.notEqual(firstId, secondId);
assert.equal(library.active.content, '');
await library.save('# 第二篇');
await library.select(firstId);
assert.equal(library.active.name, '笔记一');
assert.match(library.active.content, /madopic-image:\/\/persisted/);

// Multiple pending writes are ordered, and switching waits for the latest content.
const saves = [];
for (let i = 0; i < 12; i++) saves.push(library.save(`快速编辑 ${i}`));
await library.select(secondId);
await Promise.all(saves);
assert.equal((await read(firstId)).content, '快速编辑 11');
assert.equal(library.active.content, '# 第二篇');
assert.equal(library.dirty.size, 0);
assert.equal(statuses.at(-1), '已保存到浏览器');

const reopened = new Library(database);
await reopened.initialize('默认内容不能覆盖文档', firstId);
assert.equal(reopened.records.size, 2);
assert.equal(reopened.active.content, '快速编辑 11');
assert.equal(reopened.active.name, '笔记一');
await reopened.save('', '清空的笔记');
const afterClear = new Library(database);
await afterClear.initialize('默认示例', firstId);
assert.equal(afterClear.active.content, '', 'empty saved documents must stay empty after reload');
assert.equal(afterClear.title(afterClear.active), '清空的笔记');

// A fallback draft is recovered even when older documents already exist.
await afterClear.initialize('恢复的本地草稿', firstId, true);
assert.equal(afterClear.active.content, '恢复的本地草稿');
assert.equal(afterClear.records.size, 3);
const recoveredId = afterClear.activeId;
await afterClear.initialize('恢复的本地草稿', recoveredId, true);
assert.equal(afterClear.records.size, 3, 'retrying migration must not duplicate existing content');

// Failed transactions retain unsaved content and prevent switching until a retry succeeds.
const originalWrite = afterClear.write.bind(afterClear);
afterClear.write = () => Promise.reject(new Error('QuotaExceededError'));
await assert.rejects(afterClear.save('未保存的修改'), /QuotaExceededError/);
await assert.rejects(afterClear.select(secondId), /QuotaExceededError/);
assert.equal(afterClear.activeId, recoveredId);
assert.equal(afterClear.active.content, '未保存的修改');
afterClear.write = originalWrite;
await afterClear.flush();
await afterClear.select(secondId);
assert.equal((await read(recoveredId)).content, '未保存的修改');
assert.equal(afterClear.activeId, secondId);
database.close();
