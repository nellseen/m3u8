import fs from 'fs';
import path from 'path';
import { logger } from '../logger.ts';
import { DownloadTask, TaskSubDirectories } from '../types.ts';

/**
 * Creates isolated subdirectory structure for each job:
 * temp/<job-id>/
 *   source/
 *   download/
 *   processed/
 *   thumbnail/
 *   logs/
 */
export function createTaskDirectories(
  baseTempDir: string,
  taskId: string
): { tempDir: string; subDirs: TaskSubDirectories } {
  const tempDir = path.join(baseTempDir, taskId);
  const subDirs: TaskSubDirectories = {
    source: path.join(tempDir, 'source'),
    download: path.join(tempDir, 'download'),
    processed: path.join(tempDir, 'processed'),
    thumbnail: path.join(tempDir, 'thumbnail'),
    logs: path.join(tempDir, 'logs'),
  };

  for (const dir of Object.values(subDirs)) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return { tempDir, subDirs };
}

/**
 * Gracefully terminates subprocesses with SIGTERM then SIGKILL fallback to eliminate zombie/orphan processes.
 */
export function killTaskProcesses(task: DownloadTask): void {
  if (task.subprocesses && task.subprocesses.length > 0) {
    const pids = [...task.subprocesses];
    task.subprocesses = [];

    for (const pid of pids) {
      try {
        // Attempt graceful SIGTERM first
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          process.kill(pid, 'SIGTERM');
        }
      } catch {
        // Process might have already exited
      }

      // Hard SIGKILL fallback
      try {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        // Process already terminated
      }
    }
  }
}

/**
 * Cleans up temporary files and directories allocated specifically to this task.
 */
export async function cleanupTaskTemp(task: DownloadTask): Promise<void> {
  try {
    // Kill any remaining subprocesses
    killTaskProcesses(task);

    // Remove temp directory if it exists and safely matches task id
    if (task.tempDir && fs.existsSync(task.tempDir)) {
      if (task.tempDir.includes(task.id)) {
        fs.rmSync(task.tempDir, { recursive: true, force: true });
        logger.debug(`Cleaned up isolated temp directory for task ${task.id}: ${task.tempDir}`);
      }
    }
  } catch (err) {
    logger.warn(`Failed to clean temp directory for task ${task.id}:`, err);
  }
}

export function ensureDirectories(...dirs: string[]): void {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
