import { describe, expect, it } from 'vitest';
import { buildGreeting } from './hello.js';

describe('buildGreeting', () => {
  it('未提供名字时默认问候 World', () => {
    expect(buildGreeting(undefined)).toBe('Hello, World!');
  });

  it('使用传入的名字', () => {
    expect(buildGreeting('Trae')).toBe('Hello, Trae!');
  });

  it('去除名字两端空白', () => {
    expect(buildGreeting('  Trae  ')).toBe('Hello, Trae!');
  });

  it('名字为空白时回退到 World', () => {
    expect(buildGreeting('   ')).toBe('Hello, World!');
  });

  it('支持自定义问候语', () => {
    expect(buildGreeting('Trae', { greeting: 'Hi' })).toBe('Hi, Trae!');
  });

  it('问候语为空白时回退到默认问候语', () => {
    expect(buildGreeting('Trae', { greeting: '  ' })).toBe('Hello, Trae!');
  });

  it('支持大写输出', () => {
    expect(buildGreeting('Trae', { uppercase: true })).toBe('HELLO, TRAE!');
  });
});
