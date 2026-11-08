import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from './program.js';

describe('scs hello', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('打印默认问候语', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'scs', 'hello', 'Trae']);

    expect(log).toHaveBeenCalledWith('Hello, Trae!');
  });

  it('组合 -g 与 -u 选项', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'scs', 'hello', 'Trae', '-g', 'Hi', '-u']);

    expect(log).toHaveBeenCalledWith('HI, TRAE!');
  });

  it('非交互环境下省略名字时使用 World', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'scs', 'hello']);

    expect(log).toHaveBeenCalledWith('Hello, World!');
  });
});
