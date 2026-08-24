/**
 * ChatGPT `search` / `fetch` compatibility layer.
 *
 * ChatGPT's deep-research connector only calls two tools by contract: `search`,
 * which returns a list of `{id, title, url}` documents, and `fetch`, which
 * expands one id into `{id, title, text, url, metadata}`. Both are returned as a
 * JSON string inside a normal MCP text content block.
 *
 * Mapping that onto this server: a "document" is a place, `search` geocodes the
 * query, and `fetch` renders that place's weather summary. The layer is opt-in
 * (WEATHER_CHATGPT_COMPAT=true) so the tool list Claude sees is unchanged by
 * default — these two tools are strictly worse than the native ones for a client
 * that can call them.
 */

import type { GeocodingResult } from '../services/geocoding.js';
import { validateLatitude, validateLongitude } from '../utils/validation.js';

/** Maximum places a single `search` call returns. */
export const CHATGPT_SEARCH_LIMIT = 10;

/**
 * Tool definitions, shaped like the entries in TOOL_DEFINITIONS so they can be
 * appended to the tools/list response unchanged.
 */
export const CHATGPT_TOOL_DEFINITIONS = {
  search: {
    name: 'search' as const,
    description: 'Search for places by name and return matching locations as documents. Each result id can be passed to the fetch tool to retrieve that location\'s current weather, forecast and active alerts. Use this when the user names a place in words (e.g. "Seattle", "Paris, France", "Lake Tahoe").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string' as const,
          description: 'Place name to search for, e.g. "Seattle, WA" or "Paris, France".'
        }
      },
      required: ['query']
    }
  },
  fetch: {
    name: 'fetch' as const,
    description: 'Retrieve the full weather report for a location id returned by the search tool: current conditions, multi-day forecast and any active weather alerts. Accepts an id from search, or a plain "latitude,longitude" pair.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string' as const,
          description: 'Location id from a search result, or "latitude,longitude" (e.g. "47.6062,-122.3321").'
        }
      },
      required: ['id']
    }
  }
};

/** Tool names this layer adds. */
export const CHATGPT_TOOL_NAMES: readonly string[] = Object.keys(CHATGPT_TOOL_DEFINITIONS);

export interface DecodedLocationId {
  latitude: number;
  longitude: number;
  /** Display name carried through from the search result, when present. */
  label?: string;
}

/** Round coordinates to ~1 m so ids stay short and stable. */
function roundCoordinate(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * Build the opaque id ChatGPT round-trips between `search` and `fetch`.
 *
 * The label is encoded so a comma or colon in a place name cannot break parsing.
 */
export function encodeLocationId(latitude: number, longitude: number, label?: string): string {
  const base = `geo:${roundCoordinate(latitude)},${roundCoordinate(longitude)}`;
  return label ? `${base}:${encodeURIComponent(label)}` : base;
}

const LOCATION_ID_PATTERN = /^(?:geo:)?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?::(.*))?$/;

/**
 * Parse an id produced by {@link encodeLocationId}, or a bare "lat,lon" pair.
 *
 * @throws Error when the id is not a coordinate pair or the coordinates are out of range.
 */
export function decodeLocationId(id: unknown): DecodedLocationId {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('fetch requires an "id" from a search result, or "latitude,longitude".');
  }

  const match = LOCATION_ID_PATTERN.exec(id.trim());
  if (!match) {
    throw new Error(`Unrecognized location id. Use an id from the search tool, or "latitude,longitude".`);
  }

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  validateLatitude(latitude);
  validateLongitude(longitude);

  const label = match[3] ? safeDecode(match[3]) : undefined;
  return label ? { latitude, longitude, label } : { latitude, longitude };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is the caller's problem, not a reason to fail the request.
    return value;
  }
}

/** Human-visible citation target for a coordinate. */
export function locationUrl(latitude: number, longitude: number): string {
  const lat = roundCoordinate(latitude);
  const lon = roundCoordinate(longitude);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=10/${lat}/${lon}`;
}

/**
 * Render geocoding hits as the JSON payload `search` must return.
 */
export function formatSearchResults(results: GeocodingResult[]): string {
  return JSON.stringify({
    results: results.slice(0, CHATGPT_SEARCH_LIMIT).map(result => ({
      id: encodeLocationId(result.latitude, result.longitude, result.display_name),
      title: result.display_name,
      url: locationUrl(result.latitude, result.longitude)
    }))
  });
}

/**
 * Render a weather report as the JSON payload `fetch` must return.
 */
export function formatFetchResult(params: {
  id: string;
  title: string;
  text: string;
  latitude: number;
  longitude: number;
}): string {
  return JSON.stringify({
    id: params.id,
    title: params.title,
    text: params.text,
    url: locationUrl(params.latitude, params.longitude),
    metadata: {
      latitude: String(roundCoordinate(params.latitude)),
      longitude: String(roundCoordinate(params.longitude)),
      source: 'weather-mcp'
    }
  });
}
