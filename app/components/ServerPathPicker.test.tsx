// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pickServerPath } from './ServerPathPicker';

const home = {
  path: '/Users/me',
  parent: '/Users',
  separator: '/',
  entries: [{ name: 'Models', dir: true }, { name: 'engine', dir: false }],
  places: [{ name: 'Home', path: '/Users/me' }, { name: 'Big', path: '/Volumes/Big' }],
};
const models = { ...home, path: '/Users/me/Models', parent: '/Users/me', entries: [] };

const asked: string[] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  asked.length = 0;
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    asked.push(init?.method === 'POST' ? `POST ${url} ${init.body}` : url);
    if (url.startsWith('/v1/fs/folder')) return Response.json({ path: '/Users/me/New' });
    const path = new URL(url, 'http://studio').searchParams.get('path');
    if (path === '/gone') return Response.json({ error: 'open /gone: No such file or directory' }, { status: 400 });
    if (path === '/Users/me/Models' || path === '/Users/me/New') return Response.json({ ...models, path });
    return Response.json(home);
  }));
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (text: string) => [...document.querySelectorAll('button')].find((each) => each.textContent?.trim() === text)!;

it('opens a folder, goes into a subfolder and hands back its path', async () => {
  let chosen: Promise<string | null> = Promise.resolve(null);
  await act(async () => { chosen = pickServerPath({ title: 'Folder for the models' }); });
  await settle();
  expect(asked[0]).toBe('/v1/fs/list?');
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Folder for the models');
  await act(async () => { button('Models').click(); });
  await settle();
  expect(asked.at(-1)).toBe('/v1/fs/list?path=%2FUsers%2Fme%2FModels');
  await act(async () => { button('Choose this folder').click(); });
  expect(await chosen).toBe('/Users/me/Models');
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(localStorage.getItem('studio:server-picker:last')).toBe('/Users/me/Models');
});

it('asks for files too when picking a file, and needs one chosen', async () => {
  let chosen: Promise<string | null> = Promise.resolve(null);
  await act(async () => { chosen = pickServerPath({ title: 'Engine', kind: 'file' }); });
  await settle();
  expect(asked[0]).toBe('/v1/fs/list?files=true');
  const choose = button('Choose file');
  expect(choose.disabled).toBe(true);
  await act(async () => { button('engine').click(); });
  expect(choose.disabled).toBe(false);
  await act(async () => { choose.click(); });
  expect(await chosen).toBe('/Users/me/engine');
});

it('cancels with Escape', async () => {
  let chosen: Promise<string | null> = Promise.resolve(null);
  await act(async () => { chosen = pickServerPath({ title: 'Anything' }); });
  await settle();
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(await chosen).toBeNull();
});

it('starts at home when the remembered folder is gone, and makes a new folder', async () => {
  localStorage.setItem('studio:server-picker:last', '/gone');
  let chosen: Promise<string | null> = Promise.resolve(null);
  await act(async () => { chosen = pickServerPath({ title: 'Somewhere' }); });
  await settle();
  expect(asked.slice(0, 2)).toEqual(['/v1/fs/list?path=%2Fgone', '/v1/fs/list?']);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { button('New folder').click(); });
  const name = document.querySelector<HTMLInputElement>('input[placeholder="Folder name"]')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(name, 'New');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { button('Make').click(); });
  await settle();
  expect(asked).toContain('POST /v1/fs/folder {"path":"/Users/me","name":"New"}');
  await act(async () => { button('Choose this folder').click(); });
  expect(await chosen).toBe('/Users/me/New');
});
