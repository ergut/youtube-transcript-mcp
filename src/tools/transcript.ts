import {
  normalizeYouTubeUrl,
  extractVideoId,
  isValidYouTubeUrl,
} from '../utils/url-normalize';
import {
  getCachedTranscript,
  setCachedTranscript,
  incrementVideoRequestCount,
  trackDailyRequests,
} from '../utils/cache';
import {
  getTranscript as fetchTranscriptFromYouTube,
  handleYouTubeErrors,
} from '../lib/youtube';
import { logRequest as logAnalyticsError } from '../utils/analytics';

// Define the MCP Tool Specification
export const getTranscriptToolSpec = {
  name: 'get_transcript',
  description: 'Extract transcript from YouTube video URL',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'YouTube video URL (any format)',
      },
      language: {
        type: 'string',
        description: "Optional language code for the transcript (e.g., 'en', 'es'). Defaults to 'en'.",
        optional: true,
      }
    },
    required: ['url'],
  },
};

/**
 * Main function to get a YouTube transcript.
 * It handles URL validation, normalization, caching, fetching, and analytics.
 * This function is called by the MCP server's tool handler in src/index.ts.
 * @param url The YouTube URL string.
 * @param env The worker environment object (must contain TRANSCRIPT_CACHE).
 * @param language The desired language code (defaults to 'en').
 * @returns The transcript text as a string.
 * @throws Error if the URL is invalid, or if fetching/processing fails.
 */
export async function getTranscript(url: string, env: any, language: string = 'en'): Promise<string> {
  // 1. Validate URL
  if (!isValidYouTubeUrl(url)) {
    throw new Error('Invalid YouTube URL provided.');
  }

  const normalizedUrl = normalizeYouTubeUrl(url);
  const videoId = extractVideoId(normalizedUrl);

  if (!videoId) {
    throw new Error('Could not extract video ID from the URL.');
  }

  // Analytics: Track overall daily requests and per-video requests.
  // These are fire-and-forget promises.
  if (env.TRANSCRIPT_CACHE) {
    trackDailyRequests(env).catch(err => console.error("Failed to track daily requests:", err));
    incrementVideoRequestCount(env, videoId).catch(err => console.error("Failed to increment video request count:", err));
  } else {
    console.warn("TRANSCRIPT_CACHE not available for analytics tracking in getTranscript.");
  }

  // 3. Check cache for existing transcript (success or error string)
  try {
    const cachedData = await getCachedTranscript(env, videoId, language);
    if (cachedData) {
      console.log(`Cache hit for ${videoId} (lang: ${language})`);
      // Check if the cached data is a known error message string.
      const isCachedError = cachedData.startsWith('Error:') || 
                             cachedData.includes('No transcript available') || 
                             cachedData.includes('Service temporarily busy') ||
                             cachedData.includes('Video not found or private') || 
                             cachedData.includes('Transcripts are disabled');
      if (isCachedError) {
        throw new Error(cachedData);
      }
      return cachedData;
    }
  } catch (cacheError: any) {
    if (cacheError.message.startsWith('Error:')) {
        throw cacheError;
    }
    console.error(`Cache read error for ${videoId} (lang: ${language}): ${cacheError.message}. Proceeding to fetch.`);
  }

  // 4. If not cached, fetch from YouTube
  console.log(`Cache miss for ${videoId} (lang: ${language}). Fetching from YouTube...`);
  let transcriptText: string;
  let fetchWasSuccessful = false;

  try {
    transcriptText = await fetchTranscriptFromYouTube(videoId, language);
    fetchWasSuccessful = true;
  } catch (error: any) {
    console.error(`Fetching transcript for ${videoId} (lang: ${language}) failed: ${error.message}`);
    transcriptText = handleYouTubeErrors(error);
    
    // Log this specific error type for analytics
    if (env.TRANSCRIPT_CACHE) {
        const errorName = (error.name && error.name !== 'Error') ? error.name : 'FetchError'; 
        logAnalyticsError(env, videoId, false, errorName).catch(err => console.error("Failed to log analytics error:", err));
    }
  }

  // 5. Cache result (success or the user-friendly error message)
  if (env.TRANSCRIPT_CACHE) {
    try {
        await setCachedTranscript(env, videoId, language, transcriptText, !fetchWasSuccessful);
    } catch (cacheWriteError: any) {
        console.error(`Cache write error for ${videoId} (lang: ${language}): ${cacheWriteError.message}`);
    }
  }

  // 6. Return transcript or throw error
  if (!fetchWasSuccessful) {
    throw new Error(transcriptText);
  }

  return transcriptText;
}