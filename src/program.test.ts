import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from './program.js';

function captureLog(): () => string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return () => log.mock.calls.map((call) => call.join(' ')).join('\n');
}

describe('scs help', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('列出全部脚本与退出码约定', async () => {
    const output = captureLog();

    await createProgram().parseAsync(['node', 'scs', 'help']);

    const text = output();
    expect(text).toContain('scs time');
    expect(text).toContain('scs check observable');
    expect(text).toContain('scs check criteria-engine');
    expect(text).toContain('scs ledger gate');
    expect(text).toContain('scs ledger numbers');
    expect(text).toContain('退出码');
  });

  it('按命令名查看单个脚本的详细用法', async () => {
    const output = captureLog();

    await createProgram().parseAsync(['node', 'scs', 'help', 'check']);

    const text = output();
    expect(text).toContain('scs check observable');
    expect(text).toContain('--terms <file>');
    expect(text).not.toContain('scs time');
  });

  it('按两级路径查看子命令', async () => {
    const output = captureLog();

    await createProgram().parseAsync(['node', 'scs', 'help', 'ledger', 'gate']);

    const text = output();
    expect(text).toContain('scs ledger gate <progressPath>');
    expect(text).toContain('progress.md 路径');
    expect(text).not.toContain('scs ledger numbers');
  });

  it('未知命令输出提示并置退出码 1', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'scs', 'help', 'nope']);

    expect(error).toHaveBeenCalledWith('未知命令：nope');
    expect(process.exitCode).toBe(1);
  });
});

describe('hello 命令已移除', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('scs hello 不再被识别', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const program = createProgram();
    program.exitOverride();

    await expect(program.parseAsync(['node', 'scs', 'hello'])).rejects.toThrow();
  });
});
