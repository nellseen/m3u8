import fs from 'fs';
import { logger } from '../logger.ts';
import { DownloadTask } from '../types.ts';

export async function cleanupTaskTemp(task: DownloadTask): Promise<void> {
  try {
    // Kill any remaining child processes
    killTaskProcesses(task);

    // Remove temp directory if it exists and matches standard pattern
    if (task.tempDir && fs.existsSync(task.tempDir)) {
      // Safety check: ensure tempDir ends with task id to prevent deleting root or parents
      if (task.tempDir.includes(task.id)) {
        fs.rmSync(task.tempDir, { recursive: true, force: true });
        logger.debug(`Cleaned up temp dir for task ${task.id}: ${task.tempDir}`);
      }
    }
  } catch (err) {
    logger.warn(`Failed to clean temp directory for task ${task.id}:`, err);
  }
}

export function killTaskProcesses(task: DownloadTask): void {
  if (task.subprocesses && task.subprocesses.length > 0) {
    for (const pid of task.subprocesses) {
      try {
        process.kill(-pid, 'SIGKILL'); // Kill process group
      } catch {
        try {
          process.kill(pid, 'SIGKILL'); // Direct pid
        } catch {
          // Process already exited
        }
      }
    }
    task.subprocesses = [];
  }
}

export function ensureDirectories(...dirs: string[]): void {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
