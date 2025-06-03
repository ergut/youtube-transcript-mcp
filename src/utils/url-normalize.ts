import Url from 'url-parse';

/**
 * Checks if the given URL is a valid YouTube video URL.
 * Handles various YouTube domain formats (youtube.com, youtu.be, m.youtube.com, international domains)
 * and path formats (/watch, /live, /embed, /shorts).
 * @param url The URL to validate.
 * @returns True if the URL is a valid YouTube video URL, false otherwise.
 */
export function isValidYouTubeUrl(url: string): boolean {
  if (!url) {
    return false;
  }

  const parsedUrl = new Url(url, true) as Url<any>; // true to parse query string

  const validHostnames = [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be',
    // Common international domains (this list can be expanded)
    'youtube.co.uk',
    'youtube.de',
    'youtube.fr',
    'youtube.jp',
    'youtube.ca',
    'youtube.es',
    'youtube.br',
    'youtube.com.br',
    'youtube.co.in',
    'youtube.co.kr',
  ];

  // Remove 'www.' for simpler hostname matching
  const hostname = parsedUrl.hostname.startsWith('www.')
    ? parsedUrl.hostname.substring(4)
    : parsedUrl.hostname;

  if (!validHostnames.includes(hostname)) {
    return false;
  }

  const videoId = extractVideoIdFromParsedUrl(parsedUrl);
  return !!videoId; // If we can extract a video ID, consider it valid for our purposes
}

/**
 * Extracts the YouTube video ID from a pre-parsed URL object.
 * This is an internal helper function.
 * @param parsedUrl The parsed URL object from url-parse.
 * @returns The YouTube video ID, or null if not found.
 */
function extractVideoIdFromParsedUrl(parsedUrl: Url<any>): string | null {
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query; // Parsed query object

  if (parsedUrl.hostname === 'youtu.be') {
    // For youtu.be URLs, the ID is the first part of the path
    const videoId = pathname.split('/')[1];
    return videoId || null;
  }

  if (pathname.startsWith('/watch') && query.v) {
    return Array.isArray(query.v) ? query.v[0] : query.v;
  }
  if (pathname.startsWith('/live/')) {
    const parts = pathname.split('/');
    return parts[2] || null;
  }
  if (pathname.startsWith('/embed/')) {
    const parts = pathname.split('/');
    return parts[2] || null;
  }
  if (pathname.startsWith('/shorts/')) {
    const parts = pathname.split('/');
    return parts[2] || null;
  }
  // Check for video ID in query parameters for root paths on m.youtube.com etc.
  // e.g. https://m.youtube.com/?v=VIDEO_ID (less common but possible)
  if (query.v && (pathname === '/' || pathname === '' )) {
     return Array.isArray(query.v) ? query.v[0] : query.v;
  }


  return null;
}

/**
 * Extracts the clean YouTube video ID from a URL.
 * @param url The YouTube URL.
 * @returns The video ID, or null if the URL is invalid or ID cannot be found.
 */
export function extractVideoId(url: string): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsedUrl = new Url(url, true) as Url<any>; // Added <any> for query type
    return extractVideoIdFromParsedUrl(parsedUrl);
  } catch (e) {
    // url-parse might throw on severely malformed URLs
    return null;
  }
}

/**
 * Removes tracking parameters and normalizes the query string for a YouTube URL.
 * This function primarily aims to get the base URL with only the video ID.
 * For non-video URLs or URLs where a video ID isn't primary, its behavior might be simple.
 * @param url The YouTube URL string.
 * @returns A cleaner URL string, typically with only the video ID parameter if applicable.
 */
export function cleanTrackingParams(url: string): string {
  if (!url) {
    return url; // Return original if empty or null
  }
  try {
    const parsedUrl = new Url(url, true) as Url<any>; // Added <any> for query type
    const videoId = extractVideoIdFromParsedUrl(parsedUrl);

    if (videoId) {
      // If it's a known video URL structure, normalize to the standard watch?v= format
      // This inherently cleans other params for these structures.
      if (parsedUrl.hostname === 'youtu.be' ||
          parsedUrl.pathname.startsWith('/live/') ||
          parsedUrl.pathname.startsWith('/embed/') ||
          parsedUrl.pathname.startsWith('/shorts/')) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }

      // For /watch URLs, rebuild with only 'v'
      if (parsedUrl.pathname.startsWith('/watch')) {
        const protocol = parsedUrl.protocol || 'https';
        return `${protocol}//www.youtube.com/watch?v=${videoId}`;
      }
    }

    // Fallback for other URLs or if videoId couldn't be cleanly extracted
    // by the logic above, but we still want to try cleaning.
    // Rebuild the URL with only essential parameters (if any).
    // For YouTube, 'v' is the primary one we care about for video pages.
    // This part might be too aggressive or not aggressive enough depending on
    // the types of "other" YouTube URLs one might encounter.
    // Given the project's focus on video transcripts, this is a reasonable default.

    let newQuery: Record<string, any> = {}; // Changed to Record<string, any>
    if (parsedUrl.query && parsedUrl.query.v) { // Added check for parsedUrl.query existence
      newQuery = { v: parsedUrl.query.v };
    }
    // Potentially add other "essential" params if needed in the future.

    parsedUrl.set('query', newQuery);
    // Ensure standard hostname for consistency if it was an m.youtube.com or other variant
    if (parsedUrl.hostname && parsedUrl.hostname.includes('youtube.')) { // Added check for parsedUrl.hostname existence
        parsedUrl.set('hostname', 'www.youtube.com');
    }
    // Ensure https
    parsedUrl.set('protocol', 'https');


    return parsedUrl.toString();

  } catch (e) {
    // If parsing fails, return the original URL
    return url;
  }
}


/**
 * Normalizes a YouTube URL to the format: `https://www.youtube.com/watch?v=VIDEO_ID`.
 * @param url The YouTube URL to normalize.
 * @returns The normalized URL, or the original URL if it cannot be normalized or is invalid.
 *          Consider throwing an error for truly invalid URLs if stricter handling is needed.
 */
export function normalizeYouTubeUrl(url: string): string {
  const videoId = extractVideoId(url);
  if (videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  // As per instructions: "Return clear error messages for invalid URLs"
  // Throwing an error is a way to provide a clear message.
  // Alternatively, could return a specific string like "invalid_youtube_url"
  // or follow Postel's law and return the original URL if unnormalizable.
  // The requirement "Always normalize to: https://www.youtube.com/watch?v=VIDEO_ID"
  // implies that if it can't, it's an issue.
  // For now, returning original URL if video ID not found.
  // This can be made stricter by throwing an error.
  console.warn(`Could not normalize URL, video ID not found: ${url}`);
  return url; // Or throw new Error(`Invalid or non-video YouTube URL: ${url}`);
}

// Example Usage (can be removed or kept for testing)
/*
const urlsToTest = [
  'http://www.youtube.com/watch?v=VIDEO_ID&feature=feedrec_grec_index',
  'http://www.youtube.com/user/USERNAME#p/a/u/1/VIDEO_ID',
  'http://www.youtube.com/v/VIDEO_ID?fs=1&hl=en_US&rel=0',
  'http://www.youtube.com/watch?v=VIDEO_ID#t=0m10s',
  'http://www.youtube.com/embed/VIDEO_ID?rel=0',
  'http://www.youtube.com/live/VIDEO_ID?si=TRACKING_PARAM',
  'https://www.youtube.com/watch?v=VIDEO_ID&t=123s&si=TRACKING_PARAM',
  'https://youtu.be/VIDEO_ID?si=TRACKING_PARAM',
  'https://m.youtube.com/watch?v=VIDEO_ID',
  'https://youtube.com/watch?v=VIDEO_ID',
  'youtube.com/shorts/VIDEO_ID',
  'https://www.youtube.com/playlist?list=PLAYLIST_ID&v=VIDEO_ID_IN_PLAYLIST', // Should extract VIDEO_ID_IN_PLAYLIST
  'https://youtube.co.uk/watch?v=VIDEO_ID',
  'https://youtube.de/watch?v=VIDEO_ID',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL মাসুদ_অবুঝ_মন&index=1&ab_channel=RickAstley', // complex list param
  'https://www.youtube.com/watch?app=desktop&v=VIDEO_ID',
  'https://m.youtube.com/watch?app=desktop&v=VIDEO_ID'
];

urlsToTest.forEach(testUrl => {
  console.log(`Original: ${testUrl}`);
  console.log(`Valid?: ${isValidYouTubeUrl(testUrl)}`);
  const videoId = extractVideoId(testUrl);
  console.log(`Video ID: ${videoId}`);
  if (videoId) {
    console.log(`Normalized: ${normalizeYouTubeUrl(testUrl)}`);
    console.log(`Cleaned: ${cleanTrackingParams(testUrl)}`);
  }
  console.log('---');
});
*/

// Handling edge cases from requirements:
// - Validate YouTube URL format (covered by isValidYouTubeUrl, extractVideoId implicitly)
// - Return clear error messages for invalid URLs (normalizeYouTubeUrl logs a warning, can be changed to throw error)
// - Handle edge cases (private videos, age-restricted content):
//   These are more about content accessibility than URL structure.
//   The normalization will still produce a valid URL structure for them.
//   The actual fetching in `youtube.ts` (Phase 3) would encounter errors for these.
//   The `isValidYouTubeUrl` checks the *format*, not content availability.
