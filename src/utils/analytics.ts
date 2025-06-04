// Assuming TRANSCRIPT_CACHE is bound in the environment (env.TRANSCRIPT_CACHE)

const ANALYTICS_TTL_SECONDS = 60 * 60 * 24; // 24 hours for general stats
const POPULAR_VIDEOS_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days for popular videos list

// --- Key Generation Functions ---
function getDailyRequestsKey(date: string): string { // date in YYYY-MM-DD format
  return `analytics:requests:${date}`;
}

function getDailyErrorsKey(date: string, errorType?: string): string { // date in YYYY-MM-DD
  return `analytics:errors:${date}${errorType ? ':' + errorType : ':general'}`;
}

function getVideoRequestsKey(videoId: string): string {
  return `analytics:videos:${videoId}`; // Already used in cache.ts, but good to have a helper here too
}

function getPopularVideosWeeklyKey(): string {
  // Simple weekly key based on ISO week number
  const now = new Date();
  const year = now.getUTCFullYear();
  const firstDayOfYear = new Date(Date.UTC(year, 0, 1));
  const days = Math.floor((now.getTime() - firstDayOfYear.getTime()) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.ceil((days + firstDayOfYear.getUTCDay() + 1) / 7);
  return `analytics:popular:weekly:${year}-W${String(weekNumber).padStart(2, '0')}`;
}

// --- Core Analytics Functions ---

/**
 * Logs a request, incrementing relevant counters for daily requests, video-specific requests,
 * and error types if applicable.
 * @param env The Worker environment containing the KV namespace.
 * @param videoId The YouTube video ID involved in the request.
 * @param success Whether the request was successful (resulted in a transcript).
 * @param errorType Optional string describing the type of error if success is false.
 */
export async function logRequest(
  env: any,
  videoId: string,
  success: boolean,
  errorType?: string
): Promise<void> {
  if (!env.TRANSCRIPT_CACHE) {
    console.warn('TRANSCRIPT_CACHE not bound, skipping analytics logging.');
    return;
  }

  const today = new Date();
  const dateKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;

  if (!success) {
    const dailyErrKey = getDailyErrorsKey(dateKey, errorType || 'unknown');
    try {
      const currentErrors = await env.TRANSCRIPT_CACHE.get(dailyErrKey);
      const newErrorCount = currentErrors ? parseInt(currentErrors, 10) + 1 : 1;
      if(!isNaN(newErrorCount)) {
        await env.TRANSCRIPT_CACHE.put(dailyErrKey, newErrorCount.toString(), { expirationTtl: ANALYTICS_TTL_SECONDS * 2 });
      } else {
        await env.TRANSCRIPT_CACHE.put(dailyErrKey, "1", { expirationTtl: ANALYTICS_TTL_SECONDS * 2 });
      }
    } catch (e: any) {
      console.error(`Error updating daily error count (${dailyErrKey}): ${e.message}`);
    }
  }
}

/**
 * Retrieves daily statistics for requests and errors.
 * @param env The Worker environment containing the KV namespace.
 * @param date The date string in 'YYYY-MM-DD' format.
 * @returns An object with total requests and error counts (by type).
 */
export async function getDailyStats(env: any, date: string): Promise<{ requests: number; errors: Record<string, number>; totalErrors: number }> {
  if (!env.TRANSCRIPT_CACHE) {
    console.warn('TRANSCRIPT_CACHE not bound, cannot get daily stats.');
    return { requests: 0, errors: {}, totalErrors: 0 };
  }

  let requestCount = 0;
  const dailyReqKey = getDailyRequestsKey(date);
  try {
    const reqVal = await env.TRANSCRIPT_CACHE.get(dailyReqKey);
    requestCount = reqVal ? parseInt(reqVal, 10) : 0;
    if (isNaN(requestCount)) requestCount = 0;
  } catch (e: any) {
    console.error(`Error fetching daily request count (${dailyReqKey}): ${e.message}`);
  }

  const errors: Record<string, number> = {};
  let totalErrors = 0;
  try {
    const listOptions: KVNamespaceListOptions = { prefix: `analytics:errors:${date}:` };
    const errorKeysResult = await env.TRANSCRIPT_CACHE.list(listOptions);
    
    for (const key of errorKeysResult.keys) {
      const errorType = key.name.substring(`analytics:errors:${date}:`.length);
      const errVal = await env.TRANSCRIPT_CACHE.get(key.name);
      const count = errVal ? parseInt(errVal, 10) : 0;
      if (!isNaN(count)) {
        errors[errorType] = count;
        totalErrors += count;
      } else {
        errors[errorType] = 0;
      }
    }
    // Note: simplified for MVP; does not handle pagination for error types if many unique error types exist.
  } catch (e: any) {
    console.error(`Error fetching daily error stats for date ${date}: ${e.message}`);
  }

  return { requests: requestCount, errors, totalErrors };
}

/**
 * Retrieves a list of popular videos based on request counts.
 * This function reads a pre-compiled list from KV.
 * @param env The Worker environment containing the KV namespace.
 * @param limit The maximum number of popular videos to return.
 * @returns An array of popular videos with their counts.
 */
export async function getPopularVideos(
  env: any,
  limit: number
): Promise<Array<{ videoId: string; count: number }>> {
  if (!env.TRANSCRIPT_CACHE) {
    console.warn('TRANSCRIPT_CACHE not bound, cannot get popular videos.');
    return [];
  }

  const popularKey = getPopularVideosWeeklyKey();
  try {
    const popularData = await env.TRANSCRIPT_CACHE.get(popularKey);
    if (popularData) {
      const videos = JSON.parse(popularData) as Array<{ videoId: string; count: number }>;
      return videos.slice(0, limit);
    }
  } catch (e: any) {
    console.error(`Error fetching or parsing popular videos (${popularKey}): ${e.message}`);
  }
  return [];
}

/**
 * Updates the list of weekly popular videos by scanning video request counts.
 * WARNING: This function can be resource-intensive with many unique video IDs in KV.
 * It's intended to be run periodically (e.g., via a cron trigger), not on every user request.
 * @param env The Worker environment containing the KV namespace.
 * @param topN The number of top videos to store in the popular list.
 */
export async function updatePopularVideosList(env: any, topN: number = 20): Promise<void> {
    if (!env.TRANSCRIPT_CACHE) {
        console.warn('TRANSCRIPT_CACHE not bound, cannot update popular videos.');
        return;
    }

    console.log('Attempting to update popular videos list...');
    const videoCounts: Array<{ videoId: string; count: number }> = [];
    let currentCursor: string | undefined = undefined;

    try {
        do {
            const listResult: KVNamespaceListResult<unknown> = await env.TRANSCRIPT_CACHE.list({
                prefix: 'analytics:videos:',
                cursor: currentCursor,
                limit: 1000, // Max 1000, adjust as needed
            });

            for (const key of listResult.keys) {
                const videoId = key.name.substring('analytics:videos:'.length);
                const countStr = await env.TRANSCRIPT_CACHE.get(key.name);
                const count = countStr ? parseInt(countStr, 10) : 0;
                if (!isNaN(count) && count > 0) {
                    videoCounts.push({ videoId, count });
                }
            }
            
            if (listResult.list_complete) {
                currentCursor = undefined; // No more keys
            } else {
                currentCursor = listResult.cursor; 
            }

        } while (currentCursor);

        videoCounts.sort((a, b) => b.count - a.count);
        const topVideos = videoCounts.slice(0, topN);

        if (topVideos.length > 0) {
            const popularKey = getPopularVideosWeeklyKey();
            await env.TRANSCRIPT_CACHE.put(popularKey, JSON.stringify(topVideos), {
                expirationTtl: POPULAR_VIDEOS_TTL_SECONDS
            });
            console.log(`Updated popular videos list (${popularKey}) with ${topVideos.length} videos.`);
        } else {
            console.log('No video data found to update popular videos list.');
        }

    } catch (error: any) {
        console.error('Error updating popular videos list:', error.message);
    }
}
