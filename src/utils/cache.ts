// KV Namespace binding, e.g., from wrangler.toml: TRANSCRIPT_CACHE
// Ensure this is bound in your Cloudflare Worker environment.

const SUCCESSFUL_TRANSCRIPT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const ERROR_RESPONSE_TTL_SECONDS = 60 * 5; // 5 minutes

function getTranscriptCacheKey(videoId: string, language: string): string {
  return `transcript:${videoId}:${language}`;
}

/**
 * Retrieves a cached transcript from KV.
 * @param env The Worker environment object containing the KV namespace.
 * @param videoId The YouTube video ID.
 * @param language The language code for the transcript.
 * @returns The cached transcript text, or null if not found.
 */
export async function getCachedTranscript(
  env: any, 
  videoId: string, 
  language: string
): Promise<string | null> {
  if (!env.TRANSCRIPT_CACHE) {
    console.warn('TRANSCRIPT_CACHE namespace not bound in environment.');
    return null;
  }
  const cacheKey = getTranscriptCacheKey(videoId, language);
  try {
    return await env.TRANSCRIPT_CACHE.get(cacheKey);
  } catch (e: any) {
    console.error(`Error getting from KV (${cacheKey}): ${e.message}`);
    return null;
  }
}

/**
 * Stores a transcript (or an error message) in KV with appropriate TTL.
 * @param env The Worker environment object containing the KV namespace.
 * @param videoId The YouTube video ID.
 * @param language The language code for the transcript.
 * @param data The transcript text or error message to cache.
 * @param isError True if the data being cached is an error message, false otherwise.
 */
export async function setCachedTranscript(
  env: any,
  videoId: string,
  language: string,
  data: string,
  isError: boolean
): Promise<void> {
  if (!env.TRANSCRIPT_CACHE) {
    console.warn('TRANSCRIPT_CACHE namespace not bound in environment.');
    return;
  }
  const cacheKey = getTranscriptCacheKey(videoId, language);
  const ttl = isError ? ERROR_RESPONSE_TTL_SECONDS : SUCCESSFUL_TRANSCRIPT_TTL_SECONDS;
  try {
    await env.TRANSCRIPT_CACHE.put(cacheKey, data, { expirationTtl: ttl });
  } catch (e: any) {
    console.error(`Error putting to KV (${cacheKey}): ${e.message}`);
  }
}

// --- Analytics Caching Functions ---

function getVideoAnalyticsCacheKey(videoId: string): string {
  return `analytics:videos:${videoId}`;
}

function getDailyRequestsAnalyticsCacheKey(): string {
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = (today.getUTCMonth() + 1).toString().padStart(2, '0'); // Months are 0-indexed
  const day = today.getUTCDate().toString().padStart(2, '0');
  return `analytics:requests:${year}-${month}-${day}`;
}

/**
 * Increments the request count for a specific video ID in KV.
 * @param env The Worker environment object containing the KV namespace.
 * @param videoId The YouTube video ID.
 */
export async function incrementVideoRequestCount(env: any, videoId: string): Promise<void> {
  if (!env.TRANSCRIPT_CACHE) {
    console.warn('TRANSCRIPT_CACHE namespace not bound for analytics.');
    return;
  }
  const cacheKey = getVideoAnalyticsCacheKey(videoId);
  try {
    const currentValue = await env.TRANSCRIPT_CACHE.get(cacheKey);
    const count = currentValue ? parseInt(currentValue, 10) : 0;
    if (isNaN(count)) {
        console.warn(`Invalid count for ${cacheKey}: ${currentValue}. Resetting to 1.`);
        await env.TRANSCRIPT_CACHE.put(cacheKey, '1');
    } else {
        await env.TRANSCRIPT_CACHE.put(cacheKey, (count + 1).toString());
    }
  } catch (e: any) {
    console.error(`Error incrementing video request count (${cacheKey}): ${e.message}`);
  }
}

/**
 * Tracks the daily request count in KV.
 * @param env The Worker environment object containing the KV namespace.
 */
export async function trackDailyRequests(env: any): Promise<void> {
  if (!env.TRANSCRIPT_CACHE) {
    console.warn('TRANSCRIPT_CACHE namespace not bound for analytics.');
    return;
  }
  const cacheKey = getDailyRequestsAnalyticsCacheKey();
  try {
    const currentValue = await env.TRANSCRIPT_CACHE.get(cacheKey);
    const count = currentValue ? parseInt(currentValue, 10) : 0;
    if (isNaN(count)) {
        console.warn(`Invalid count for ${cacheKey}: ${currentValue}. Resetting to 1.`);
        await env.TRANSCRIPT_CACHE.put(cacheKey, '1');
    } else {
        await env.TRANSCRIPT_CACHE.put(cacheKey, (count + 1).toString());
    }
  } catch (e: any) {
    console.error(`Error tracking daily requests (${cacheKey}): ${e.message}`);
  }
}
