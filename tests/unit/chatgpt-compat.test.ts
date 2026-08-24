import { describe, it, expect } from 'vitest';
import {
  CHATGPT_SEARCH_LIMIT,
  CHATGPT_TOOL_DEFINITIONS,
  CHATGPT_TOOL_NAMES,
  decodeLocationId,
  encodeLocationId,
  formatFetchResult,
  formatSearchResults,
  locationUrl
} from '../../src/server/chatgptCompat.js';
import type { GeocodingResult } from '../../src/services/geocoding.js';

function geocodingResult(overrides: Partial<GeocodingResult> = {}): GeocodingResult {
  return {
    name: 'Seattle',
    display_name: 'Seattle, Washington, United States',
    latitude: 47.6062,
    longitude: -122.3321,
    confidence: 'high',
    source: 'nominatim',
    ...overrides
  };
}

describe('ChatGPT compatibility tool definitions', () => {
  it('exposes exactly the two tools the deep-research contract requires', () => {
    expect(CHATGPT_TOOL_NAMES).toEqual(['search', 'fetch']);
    expect(CHATGPT_TOOL_DEFINITIONS.search.inputSchema.required).toEqual(['query']);
    expect(CHATGPT_TOOL_DEFINITIONS.fetch.inputSchema.required).toEqual(['id']);
  });
});

describe('location id round-trip', () => {
  it('round-trips coordinates and a label', () => {
    const id = encodeLocationId(47.6062, -122.3321, 'Seattle, Washington');

    expect(decodeLocationId(id)).toEqual({
      latitude: 47.6062,
      longitude: -122.3321,
      label: 'Seattle, Washington'
    });
  });

  it('survives a label containing the separators', () => {
    const label = 'Weird, Place: 1/2';
    const decoded = decodeLocationId(encodeLocationId(1, 2, label));

    expect(decoded.label).toBe(label);
    expect(decoded.latitude).toBe(1);
    expect(decoded.longitude).toBe(2);
  });

  it('omits the label segment when there is none', () => {
    expect(encodeLocationId(10, 20)).toBe('geo:10,20');
    expect(decodeLocationId('geo:10,20')).toEqual({ latitude: 10, longitude: 20 });
  });

  it('accepts a bare coordinate pair from a client that skipped search', () => {
    expect(decodeLocationId('47.6062,-122.3321')).toEqual({
      latitude: 47.6062,
      longitude: -122.3321
    });
  });

  it('rounds coordinates so ids stay stable', () => {
    expect(encodeLocationId(47.60623456, -122.33217891)).toBe('geo:47.60623,-122.33218');
  });

  it('rejects ids that are not coordinates', () => {
    expect(() => decodeLocationId('')).toThrow(/requires an "id"/);
    expect(() => decodeLocationId(undefined)).toThrow(/requires an "id"/);
    expect(() => decodeLocationId(42)).toThrow(/requires an "id"/);
    expect(() => decodeLocationId('geo:not,numbers')).toThrow(/Unrecognized location id/);
    expect(() => decodeLocationId('../../etc/passwd')).toThrow(/Unrecognized location id/);
  });

  it('rejects out-of-range coordinates', () => {
    expect(() => decodeLocationId('geo:91,0')).toThrow(/atitude/);
    expect(() => decodeLocationId('geo:0,181')).toThrow(/ongitude/);
  });
});

describe('formatSearchResults', () => {
  it('emits the {results:[{id,title,url}]} envelope', () => {
    const payload = JSON.parse(formatSearchResults([geocodingResult()]));

    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toEqual({
      id: 'geo:47.6062,-122.3321:Seattle%2C%20Washington%2C%20United%20States',
      title: 'Seattle, Washington, United States',
      url: locationUrl(47.6062, -122.3321)
    });
  });

  it('caps the number of results', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      geocodingResult({ latitude: i, display_name: `Place ${i}` })
    );

    expect(JSON.parse(formatSearchResults(many)).results).toHaveLength(CHATGPT_SEARCH_LIMIT);
  });

  it('emits an empty result list rather than failing when nothing matched', () => {
    expect(JSON.parse(formatSearchResults([]))).toEqual({ results: [] });
  });
});

describe('formatFetchResult', () => {
  it('emits the {id,title,text,url,metadata} envelope', () => {
    const payload = JSON.parse(formatFetchResult({
      id: 'geo:47.6062,-122.3321',
      title: 'Seattle',
      text: '# Weather\n\nSunny.',
      latitude: 47.6062,
      longitude: -122.3321
    }));

    expect(payload.id).toBe('geo:47.6062,-122.3321');
    expect(payload.title).toBe('Seattle');
    expect(payload.text).toContain('Sunny.');
    expect(payload.url).toContain('openstreetmap.org');
    expect(payload.metadata).toEqual({
      latitude: '47.6062',
      longitude: '-122.3321',
      source: 'weather-mcp'
    });
  });
});
