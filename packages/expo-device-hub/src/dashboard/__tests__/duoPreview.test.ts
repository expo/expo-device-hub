import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DUO_PREVIEW,
  DUO_CACHE_SCREEN_ON_FOLD_STORAGE_KEY,
  DUO_PREVIEW_MODE_STORAGE_KEY,
  DUO_PREVIEW_SIZE_STORAGE_KEY,
  createDashboardStore,
  persistDuoPreview,
  readDuoPreview,
} from '../dashboardStore';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('iPhone Duo preview preferences', () => {
  test('default to serve-sim: 3D, live panels while folding, and a model that fills its stage', () => {
    expect(readDuoPreview(memoryStorage())).toEqual(DEFAULT_DUO_PREVIEW);
    expect(DEFAULT_DUO_PREVIEW).toEqual({ mode: '3d', cacheScreenOnFold: false, sizeMode: 'fill' });
  });

  test('read back what was persisted and treat anything but 2D or physical as the default', () => {
    const storage = memoryStorage();
    persistDuoPreview(storage, { mode: '2d', cacheScreenOnFold: true, sizeMode: 'physical' });
    expect(storage.values.get(DUO_PREVIEW_MODE_STORAGE_KEY)).toBe('2d');
    expect(storage.values.get(DUO_CACHE_SCREEN_ON_FOLD_STORAGE_KEY)).toBe('true');
    expect(storage.values.get(DUO_PREVIEW_SIZE_STORAGE_KEY)).toBe('physical');
    expect(readDuoPreview(storage)).toEqual({ mode: '2d', cacheScreenOnFold: true, sizeMode: 'physical' });
    expect(
      readDuoPreview(
        memoryStorage({
          [DUO_PREVIEW_MODE_STORAGE_KEY]: 'flat',
          [DUO_CACHE_SCREEN_ON_FOLD_STORAGE_KEY]: 'yes',
          [DUO_PREVIEW_SIZE_STORAGE_KEY]: 'huge',
        }),
      ),
    ).toEqual(DEFAULT_DUO_PREVIEW);
  });

  test('a change writes only its own choice, so another tab keeps the others, as in serve-sim', () => {
    const storage = memoryStorage({ [DUO_PREVIEW_MODE_STORAGE_KEY]: '2d' });
    persistDuoPreview(storage, { sizeMode: 'physical' });
    expect(storage.values.get(DUO_PREVIEW_MODE_STORAGE_KEY)).toBe('2d');
    expect(storage.values.has(DUO_CACHE_SCREEN_ON_FOLD_STORAGE_KEY)).toBe(false);
    expect(storage.values.get(DUO_PREVIEW_SIZE_STORAGE_KEY)).toBe('physical');
  });

  test('survive a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readDuoPreview(broken)).toEqual(DEFAULT_DUO_PREVIEW);
    expect(() => persistDuoPreview(broken, DEFAULT_DUO_PREVIEW)).not.toThrow();
  });

  test('the store merges partial updates so one control never resets another', () => {
    const store = createDashboardStore();
    expect(store.getState().duoPreview).toEqual(DEFAULT_DUO_PREVIEW);
    store.getState().setDuoPreview({ mode: '2d' });
    store.getState().setDuoPreview({ sizeMode: 'physical' });
    expect(store.getState().duoPreview).toEqual({ mode: '2d', cacheScreenOnFold: false, sizeMode: 'physical' });
  });
});
