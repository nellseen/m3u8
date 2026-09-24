import fs from 'fs';
import path from 'path';
import { logger } from '../logger.ts';
import { DownloadTask, TaskSubDirectories } from '../types.ts';

/**
 * Creates isolated subdirectory workspace structure for each job:
 * /tmp/downloader/<job-id>/
 *   manifest/      -> M3U8 master/variant playlists
 *   cookies/       -> session cookies & storage tokens
 *   headers/       -> request header dump & configurations
 *   thumbnail/     -> extracted posters & frame captures
 *   partial/       -> partial video chunks & segment downloads
 *   final/         -> final merged/remuxed video before delivery
 *   logs/          -> job-specific execution trace & engine logs
 *   source/        -> source html & page snapshot
 *   download/      -> raw engine output
 *   processed/     -> 720p normalized media
 *
 * Ensures no two jobs share the same temporary files.
 */
export function createTaskDirectories(
  baseTempDir: string,
  taskId: string
): { tempDir: string; subDirs: TaskSubDirectories } {
  const tempDir = path.join(baseTempDir, taskId);
  const subDirs: TaskSubDirectories = {
    manifest: path.join(tempDir, 'manifest'),
    cookies: path.join(tempDir, 'cookies'),
    headers: path.join(tempDir, 'headers'),
    thumbnail: path.join(tempDir, 'thumbnail'),
    partial: path.join(tempDir, 'partial'),
    final: path.join(tempDir, 'final'),
    logs: path.join(tempDir, 'logs'),
    source: path.join(tempDir, 'source'),
    download: path.join(tempDir, 'download'),
    processed: path.join(tempDir, 'processed'),
  };

  for (const dir of Object.values(subDirs)) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return { tempDir, subDirs };
}

/**
 * Writes an isolated job artifact directly inside the job's dedicated workspace directory
 */
export function writeTaskWorkspaceArtifact(
  task: DownloadTask,
  type: keyof TaskSubDirectories,
  filename: string,
  content: string | Buffer
): string {
  const targetDir = task.subDirs?.[type] || path.join(task.tempDir, String(type));
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const filePath = path.join(targetDir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Returns a dedicated path inside the job's temporary workspace
 */
export function getTaskWorkspacePath(
  task: DownloadTask,
  type: keyof TaskSubDirectories,
  filename: string
): string {
  const targetDir = task.subDirs?.[type] || path.join(task.tempDir, String(type));
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  return path.join(targetDir, filename);
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
