import { describe, expect, it } from 'vitest';
import { formatTime } from './time.js';

describe('formatTime', () => {
  it('补零到 HH:MM:SS', () => {
    expect(formatTime(new Date(2026, 0, 2, 3, 4, 5))).toBe('03:04:05');
  });

  it('两位数原样输出', () => {
    expect(formatTime(new Date(2026, 9, 20, 14, 0, 0))).toBe('14:00:00');
  });

  it('输出恒为 8 个字符', () => {
    expect(formatTime(new Date(2026, 11, 31, 23, 59, 59))).toHaveLength(8);
  });
});
