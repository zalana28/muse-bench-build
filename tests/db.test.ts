import { describe, expect, it } from 'vitest';
import { translatePlaceholders } from '../src/db';

describe('translatePlaceholders (? -> $n untuk Postgres)', () => {
  it('tanpa placeholder tidak berubah', () => {
    expect(translatePlaceholders('SELECT 1')).toBe('SELECT 1');
  });

  it('satu placeholder', () => {
    expect(translatePlaceholders('SELECT * FROM users WHERE id = ?')).toBe(
      'SELECT * FROM users WHERE id = $1',
    );
  });

  it('banyak placeholder dinomori berurutan', () => {
    expect(
      translatePlaceholders('INSERT INTO t (a, b, c) VALUES (?, ?, ?)'),
    ).toBe('INSERT INTO t (a, b, c) VALUES ($1, $2, $3)');
  });

  it('placeholder di klausa berbeda tetap berurutan', () => {
    expect(
      translatePlaceholders(
        'SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
      ),
    ).toBe(
      'SELECT * FROM tasks WHERE project_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3',
    );
  });
});
