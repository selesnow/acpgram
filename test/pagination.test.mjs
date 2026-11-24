import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clamp, clampPage, pageInfo, pageNav, pageRow, pagesOf } from '../src/pagination.mjs';

test('pagesOf: хотя бы одна страница', () => {
  assert.equal(pagesOf(0, 10), 1);
  assert.equal(pagesOf(1, 10), 1);
  assert.equal(pagesOf(10, 10), 1);
  assert.equal(pagesOf(11, 10), 2);
  assert.equal(pagesOf('21', 10), 3);
});

test('clamp: страница в границах реестра', () => {
  assert.equal(clamp(-1, 3), 0);
  assert.equal(clamp(1, 3), 1);
  assert.equal(clamp(9, 3), 2);
  assert.equal(clamp(undefined, 3), 0);
  assert.equal(clamp(4, 0), 0);
});

test('pageInfo и clampPage: номер и число страниц', () => {
  assert.deepEqual(pageInfo(25, 10, 9), { page: 2, pages: 3 });
  assert.deepEqual(pageInfo(0, 10, 5), { page: 0, pages: 1 });
  assert.deepEqual(clampPage('2', 25, 10), { page: 2, pages: 3 });
});

test('pageRow: ◀ n/m ▶ на средней странице', () => {
  const data = (p) => `list:${p}`;
  assert.deepEqual(pageRow(1, 3, data), [
    { text: '◀', callback_data: 'list:0' },
    { text: '2/3', callback_data: 'nav:n' },
    { text: '▶', callback_data: 'list:2' },
  ]);
});

test('pageRow: стрелки только в доступные стороны', () => {
  const data = (p) => `list:${p}`;
  assert.deepEqual(pageRow(0, 3, data), [
    { text: '1/3', callback_data: 'nav:n' },
    { text: '▶', callback_data: 'list:1' },
  ]);
  assert.deepEqual(pageRow(2, 3, data), [
    { text: '◀', callback_data: 'list:1' },
    { text: '3/3', callback_data: 'nav:n' },
  ]);
});

test('pageRow: без центра только стрелки', () => {
  const data = (p) => `gt:r:1:${p}`;
  assert.deepEqual(pageRow(0, 2, data, { center: false, prev: false, next: true }), [{ text: '▶', callback_data: 'gt:r:1:1' }]);
  assert.deepEqual(pageRow(1, 2, data, false), [{ text: '◀', callback_data: 'gt:r:1:0' }]);
});

test('pageNav: пусто для одной страницы, ряд для нескольких', () => {
  const data = (p) => `list:${p}`;
  assert.deepEqual(pageNav(0, 1, data), []);
  assert.deepEqual(pageNav(0, 2, data), [[{ text: '1/2', callback_data: 'nav:n' }, { text: '▶', callback_data: 'list:1' }]]);
});
