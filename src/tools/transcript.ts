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

// Define the MCP Tool Handler Function
// The actual name for export might be 'handler' or similar depending on MCP SDK,
// or this function will be wrapped/called by the main MCP server logic.
// For now, naming it descriptively.
export async function getTranscriptHandler(input: { url: string; language?: string }, env: any) {
  const { url, language = 'en' } = input;

  // 1. Validate and normalize URL
  if (!isValidYouTubeUrl(url)) {
    // Track attempt even for invalid URLs, if desired (e.g. for bad actor patterns)
    // For now, focusing on valid video processing for analytics.
    return {
      content: [{
        type: 'text',
        text: 'Error: Invalid YouTube URL provided.',
      }],
      isError: true,
    };
  }

  const normalizedUrl = normalizeYouTubeUrl(url); // Already handles various formats
  const videoId = extractVideoId(normalizedUrl); // Extract after normalization for consistency

  if (!videoId) {
    // This case should ideally be caught by isValidYouTubeUrl, but as a safeguard:
    return {
      content: [{
        type: 'text',
        text: 'Error: Could not extract video ID from the URL.',
      }],
      isError: true,
    };
  }

  // 6. Track analytics (increment counters *before* potential cache hit for overall requests)
  // Note: trackDailyRequests and incrementVideoRequestCount are fire-and-forget
  if (env.TRANSCRIPT_KV) { // Ensure KV is available for analytics
    trackDailyRequests(env).catch(console.error);
    incrementVideoRequestCount(env, videoId).catch(console.error);
  }


  // 3. Check cache for existing transcript (success or error)
  try {
    const cachedData = await getCachedTranscript(env, videoId, language);
    if (cachedData) {
      console.log(`Cache hit for ${videoId} (lang: ${language})`);
      // Determine if the cached data was an error message or actual transcript
      // For simplicity, assuming if it's cached, it's in the correct final format.
      // A more robust way would be to store objects in cache: {isError: boolean, data: string}
      // Based on current cache.ts, it stores string directly.
      // We need to infer if it's an error. A simple heuristic:
      const isLikelyError = cachedData.startsWith('Error:') || 
                             cachedData.startsWith('No transcript') || 
                             cachedData.startsWith('Service temporarily busy') ||
                             cachedData.startsWith('Video not found');
      return {
        content: [{ type: 'text', text: cachedData }],
        isError: isLikelyError, 
      };
    }
  } catch (cacheError: any) {
    console.error(`Cache read error for ${videoId}: ${cacheError.message}`);
    // Proceed to fetch, but log cache error.
  }

  // 4. If not cached, fetch from YouTube
  console.log(`Cache miss for ${videoId} (lang: ${language}). Fetching from YouTube...`);
  let transcriptText: string;
  let fetchError = false;

  try {
    transcriptText = await fetchTranscriptFromYouTube(videoId, language);
  } catch (error: any) {
    console.error(`Fetching transcript for ${videoId} failed: ${error.message}`);
    transcriptText = handleYouTubeErrors(error); // Get user-friendly error message
    fetchError = true;
  }

  // 5. Cache result (success or failure)
  try {
    // `transcriptText` here is either the actual transcript or a user-friendly error message
    await setCachedTranscript(env, videoId, language, transcriptText, fetchError);
  } catch (cacheError: any) {
    console.error(`Cache write error for ${videoId}: ${cacheError.message}`);
    // If caching fails, the user still gets the result from this request.
  }
  
  // 7. Return transcript or error message (already handled this step by step)
  return {
    content: [{
      type: 'text',
      text: transcriptText,
    }],
    isError: fetchError,
  };
}

// Example of how this might be registered or used in index.ts (conceptual)
/*
import { McpServer, Tool } from '@modelcontextprotocol/sdk'; // Fictional import
import { getTranscriptToolSpec, getTranscriptHandler } from './tools/transcript';

const transcriptTool: Tool = {
  specification: getTranscriptToolSpec,
  handler: async (input: any, context: any) => { // context might hold 'env'
    return getTranscriptHandler(input, context.env);
  }
};

// In your main server setup:
// server.registerTool(transcriptTool);
*/
