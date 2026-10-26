import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process'

/**
 * The sanctioned way main starts a program (lint rule `slate/child-process-through-proc`): a file
 * and an argument array, never a shell. Options cannot carry `shell`, in the type and at run time,
 * so an argument is never parsed as shell syntax whatever the caller passes.
 */
export type RunOptions = Omit<ExecFileOptions, 'shell'>
export type SpawnProgramOptions = Omit<SpawnOptions, 'shell'>

/** A shell binary, by its file name on any platform. */
export const SHELL_PROGRAM = /(^|[\\/])(sh|bash|zsh|dash|ksh|mksh|fish|csh|tcsh|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)$/i
/** A flag that makes a shell run its next argument as a command line. */
const COMMAND_FLAG = /^(-[a-zA-Z]*c[a-zA-Z]*|\/c|\/k|-command|-encodedcommand)$/i

/** Refuses a shell asked to run a command string: that is `shell: true` by another name. */
function refuseShellCommand(file: string, args: readonly string[]): void {
  if (SHELL_PROGRAM.test(file) && args.some((a) => COMMAND_FLAG.test(a))) {
    throw new Error(`proc refuses to run a shell with a command string (${file} ${args.find((a) => COMMAND_FLAG.test(a)) ?? ''}): run the program itself with an argument array`)
  }
}

function withoutShell<T extends object>(options: T): T {
  const { shell: _shell, ...rest } = options as T & { shell?: unknown }
  return { ...rest, shell: false } as T
}

/** Runs `file` with `args` to completion; rejects on a non-zero exit with stderr in the message. */
export function runFile(file: string, args: readonly string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    refuseShellCommand(file, args)
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { ...withoutShell(options), encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
}

/** Starts a long-lived program; the caller owns the returned process. */
export function spawnProgram(file: string, args: readonly string[], options: SpawnProgramOptions = {}): ChildProcess {
  refuseShellCommand(file, args)
  return spawn(file, [...args], withoutShell(options))
}
