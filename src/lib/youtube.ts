import { YoutubeTranscript } from 'youtube-transcript';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000; // 1 second

// Custom error classes for more specific error handling
class VideoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoUnavailableError';
  }
}

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

class InvalidVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidVideoError';
  }
}

/**
 * Sanitizes transcript text by removing excessive newlines and trimming whitespace.
 * @param transcript The raw transcript text.
 * @returns Sanitized transcript text.
 */
export function sanitizeTranscriptText(transcript: string): string {
  if (!transcript) return '';
  return transcript.replace(/\n+/g, '\n').trim();
}

/**
 * Provides specific error messages based on the error type from YouTube transcript fetching.
 * @param error The error object caught during transcript fetching.
 * @returns A user-friendly error message string.
 */
export function handleYouTubeErrors(error: any): string {
  if (error instanceof VideoUnavailableError) {
    return 'No transcript available for this video.';
  }
  if (error instanceof RateLimitError) {
    return 'Service temporarily busy, try again in a few minutes.';
  }
  if (error instanceof NetworkError) {
    return 'Unable to fetch transcript, please try again.';
  }
  if (error instanceof InvalidVideoError) {
    return 'Video not found or private.';
  }
  // Fallback for generic errors from the library or unexpected issues
  if (error && error.message) {
    if (error.message.includes('not found or private') || error.message.includes('Invalid video ID')) {
      return 'Video not found or private.';
    }
    if (error.message.includes('transcripts disabled')) {
      return 'Transcripts are disabled for this video.';
    }
    if (error.message.includes('No transcript found')) {
        return 'No transcript available for this video.';
    }
  }
  console.error('Unhandled YouTube error:', error); // Log the original error for debugging
  return 'An unexpected error occurred while fetching the transcript.';
}

/**
 * Validates video availability by attempting to fetch a small piece of information
 * or checking if transcripts are enabled. For simplicity, we'll rely on the main
 * getTranscript function to implicitly validate, as youtube-transcript handles this.
 * This function can be expanded if a pre-check is strictly necessary.
 * For now, it will be a placeholder or integrated into the main fetch logic.
 * @param videoId The YouTube video ID.
 * @returns True if the video seems available for transcriptions, false otherwise.
 */
export async function validateVideoAvailability(videoId: string): Promise<boolean> {
  // The youtube-transcript library will throw an error if the video is unavailable
  // or transcripts are disabled. We can try a fetch and catch errors.
  try {
    // Attempt to fetch with a common language, assuming if this fails, it's unavailable.
    // This is a simplified check.
    await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
    return true;
  } catch (error: any) {
    // Check for specific error messages that indicate unavailability
    if (error.message && (error.message.includes('not found or private') || 
                         error.message.includes('transcripts disabled') ||
                         error.message.includes('No transcript found'))) {
      return false;
    }
    // Other errors might be network issues, etc., not strictly unavailability.
    // For the purpose of this function, we might assume it's available if not explicitly unavailable.
    // However, a more robust check would involve distinguishing error types better.
    // Given this function is mainly for pre-flight checks, if it throws an unknown error,
    // it's safer to assume potential unavailability for the check purpose.
    return false; 
  }
}

/**
 * Fetches the transcript for a given YouTube video ID with retry logic.
 * @param videoId The YouTube video ID.
 * @param language The desired language code (e.g., 'en', 'es'). Defaults to 'en'.
 * @returns The transcript text as a string.
 * @throws An error (VideoUnavailableError, RateLimitError, NetworkError, InvalidVideoError)
 *         if fetching fails after retries or if the video/transcript is not available.
 */
export async function getTranscript(videoId: string, language: string = 'en'): Promise<string> {
  let attempts = 0;
  let backoff = INITIAL_BACKOFF_MS;

  while (attempts < MAX_RETRIES) {
    try {
      const rawTranscript = await YoutubeTranscript.fetchTranscript(videoId, {
        lang: language,
      });
      
      // The library returns an array of objects, each with a 'text' field.
      // We need to concatenate these into a single string.
      const fullText = rawTranscript.map(item => item.text).join(' ');
      return sanitizeTranscriptText(fullText);

    } catch (error: any) {
      attempts++;
      console.warn(`Attempt ${attempts} failed for video ${videoId} (lang: ${language}): ${error.message}`);

      // Error interpretation logic based on youtube-transcript library specifics and common HTTP errors
      // This part might need refinement based on how youtube-transcript surfaces errors.
      if (error.message && (error.message.includes('timed out') || error.message.includes('network') || error.message.includes('ECONNRESET'))) {
        if (attempts >= MAX_RETRIES) throw new NetworkError(`Network error after ${attempts} attempts: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff *= 2; // Exponential backoff
        continue;
      }
      
      // Assuming 403 or messages like "too many requests" might indicate rate limiting
      // The `youtube-transcript` library might not give HTTP status codes directly.
      // We need to rely on its error messages.
      if (error.message && (error.message.toLowerCase().includes('too many requests') || error.message.includes('429') || error.message.includes('403')) ){
        if (attempts >= MAX_RETRIES) throw new RateLimitError(`Rate limited after ${attempts} attempts: ${error.message}`);
        // For rate limits, wait longer, e.g., fixed longer delay or larger backoff factor
        await new Promise(resolve => setTimeout(resolve, backoff * (attempts + 1))); // Longer backoff for rate limits
        backoff *= 2;
        continue;
      }
      
      if (error.message && (error.message.includes('No transcript found for this video') || 
                           error.message.includes('transcripts are disabled'))) {
        throw new VideoUnavailableError(`No transcript found for ${videoId} (lang: ${language}). Transcripts may be disabled.`);
      }

      if (error.message && (error.message.includes('This video is unavailable') || 
                           error.message.includes('Video not found or private') ||
                           error.message.includes('Invalid video ID'))) {
        throw new InvalidVideoError(`Video ${videoId} not found or is private.`);
      }

      // If it's an unknown error or the last attempt, rethrow it to be handled by the caller.
      if (attempts >= MAX_RETRIES) {
        console.error(`Final attempt failed for ${videoId}. Error: ${error.message}`);
        // Rethrow a generic error or a more specific one if identifiable
        throw new Error(`Failed to fetch transcript for ${videoId} after ${MAX_RETRIES} attempts: ${error.message}`);
      }
      
      // Default retry for other errors
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2;
    }
  }
  // Should not be reached if MAX_RETRIES is > 0, as loops either return or throw.
  // But as a safeguard or if MAX_RETRIES = 0:
  throw new Error(`Failed to fetch transcript for ${videoId} after ${MAX_RETRIES} attempts.`);
}
