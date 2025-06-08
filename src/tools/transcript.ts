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
  description: 'Extract transcript from YouTube video URL with automatic language detection',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'YouTube video URL (any format)',
      },
      language: {
        type: 'string',
        description: "Optional language code for the transcript (e.g., 'en', 'tr'). If not available, will automatically fall back to the best available language. Defaults to 'auto' for automatic detection.",
        optional: true,
      }
    },
    required: ['url'],
  },
};

/**
 * Enhanced transcript function with automatic language detection and fallback
 */
export async function getTranscript(url: string, env: any, language: string = 'auto'): Promise<string> {
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
  if (env.TRANSCRIPT_CACHE) {
    trackDailyRequests(env).catch(err => console.error("Failed to track daily requests:", err));
    incrementVideoRequestCount(env, videoId).catch(err => console.error("Failed to increment video request count:", err));
  } else {
    console.warn("TRANSCRIPT_CACHE not available for analytics tracking in getTranscript.");
  }

  // Handle auto detection or specific language request
  if (language === 'auto') {
    return await getTranscriptWithAutoDetection(videoId, env);
  } else {
    return await getTranscriptWithFallback(videoId, env, language);
  }
}

/**
 * Attempts to get transcript with automatic language detection
 * Tries common languages in order: en, original video language (if detectable), others
 */
async function getTranscriptWithAutoDetection(videoId: string, env: any): Promise<string> {
  const languagesToTry = ['en', 'es', 'fr', 'de', 'tr', 'pt', 'ja', 'ko', 'zh', 'it', 'ru', 'ar'];

  let lastError: any;
  let availableLanguages: string[] = [];

  for (const lang of languagesToTry) {
    try {
      console.log(`Trying auto-detection for ${videoId} with language: ${lang}`);

      // Check cache first
      const cachedData = await getCachedTranscript(env, videoId, lang);
      if (cachedData && !cachedData.startsWith('Error:')) {
        console.log(`Auto-detection: Found cached transcript in ${lang}`);
        return cachedData;
      }

      // Try fetching
      const transcript = await fetchTranscriptFromYouTube(videoId, lang);

      // Cache and return successful result
      if (env.TRANSCRIPT_CACHE) {
        await setCachedTranscript(env, videoId, lang, transcript, false);
      }

      console.log(`Auto-detection: Successfully found transcript in ${lang}`);
      return `[Auto-detected language: ${lang}]\n\n${transcript}`;

    } catch (error: any) {
      lastError = error;
      console.log(`Auto-detection: ${lang} failed - ${error.message}`);

      // If it's not a language availability issue, break early
      if (!isLanguageRelatedError(error)) {
        break;
      }

      availableLanguages.push(`${lang}: ${error.message}`);
    }
  }

  // If we get here, none of the languages worked
  const errorMessage = availableLanguages.length > 0
    ? `No transcript available in any tested language. Tried: ${availableLanguages.join(', ')}`
    : handleYouTubeErrors(lastError);

  throw new Error(errorMessage);
}

/**
 * Attempts to get transcript in requested language with English fallback
 */
async function getTranscriptWithFallback(videoId: string, env: any, requestedLanguage: string): Promise<string> {
  try {
    // First try the requested language
    console.log(`Attempting ${videoId} in requested language: ${requestedLanguage}`);

    // Check cache first
    const cachedData = await getCachedTranscript(env, videoId, requestedLanguage);
    if (cachedData) {
      if (cachedData.startsWith('Error:')) {
        throw new Error(cachedData);
      }
      return cachedData;
    }

    // Try fetching in requested language
    const transcript = await fetchTranscriptFromYouTube(videoId, requestedLanguage);

    // Cache and return successful result
    if (env.TRANSCRIPT_CACHE) {
      await setCachedTranscript(env, videoId, requestedLanguage, transcript, false);
    }

    return transcript;

  } catch (error: any) {
    console.log(`Requested language ${requestedLanguage} failed: ${error.message}`);

    // If it's a language-related error and not English, try English fallback
    if (isLanguageRelatedError(error) && requestedLanguage !== 'en') {
      console.log(`Attempting English fallback for ${videoId}`);

      try {
        // Check English cache
        const cachedEnglish = await getCachedTranscript(env, videoId, 'en');
        if (cachedEnglish && !cachedEnglish.startsWith('Error:')) {
          return `[Requested language '${requestedLanguage}' not available, showing English instead]\n\n${cachedEnglish}`;
        }

        // Try fetching English
        const englishTranscript = await fetchTranscriptFromYouTube(videoId, 'en');

        // Cache English result
        if (env.TRANSCRIPT_CACHE) {
          await setCachedTranscript(env, videoId, 'en', englishTranscript, false);
        }

        return `[Requested language '${requestedLanguage}' not available, showing English instead]\n\n${englishTranscript}`;

      } catch (englishError: any) {
        console.log(`English fallback also failed: ${englishError.message}`);

        // Cache the original error for the requested language
        if (env.TRANSCRIPT_CACHE) {
          const errorMessage = handleYouTubeErrors(error);
          await setCachedTranscript(env, videoId, requestedLanguage, `Error: ${errorMessage}`, true);
        }

        throw new Error(`Transcript not available in '${requestedLanguage}' and English fallback failed: ${handleYouTubeErrors(englishError)}`);
      }
    }

    // For non-language errors or if English was requested, just throw the original error
    if (env.TRANSCRIPT_CACHE) {
      const errorMessage = handleYouTubeErrors(error);
      await setCachedTranscript(env, videoId, requestedLanguage, `Error: ${errorMessage}`, true);
      logAnalyticsError(env, videoId, false, error.name || 'FetchError').catch(err => console.error("Failed to log analytics error:", err));
    }

    throw new Error(handleYouTubeErrors(error));
  }
}

/**
 * Checks if an error is related to language availability
 */
function isLanguageRelatedError(error: any): boolean {
  if (!error || !error.message) return false;

  const message = error.message.toLowerCase();
  return message.includes('language') ||
    message.includes('subtitle') ||
    message.includes('caption') ||
    message.includes('transcript') ||
    message.includes('not available') ||
    message.includes('no transcript found');
}