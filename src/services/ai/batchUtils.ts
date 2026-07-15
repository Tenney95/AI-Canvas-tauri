export interface SettledBatch<T> {
  results: T[];
  failedCount: number;
}

/** Execute independent tasks with a small worker pool and preserve partial successes. */
export async function runBatchTasks<T>(
  taskCount: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<SettledBatch<T>> {
  if (taskCount <= 0) return { results: [], failedCount: 0 };

  const settled: Array<PromiseSettledResult<T> | undefined> = new Array(taskCount);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), taskCount);

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < taskCount) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        settled[index] = { status: 'fulfilled', value: await task(index) };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(workers);
  const results: T[] = [];
  let failedCount = 0;
  for (const item of settled) {
    if (item?.status === 'fulfilled') results.push(item.value);
    else failedCount += 1;
  }
  return { results, failedCount };
}
