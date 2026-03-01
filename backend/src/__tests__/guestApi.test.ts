import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * vi.mock is hoisted above const declarations by vitest's transformer, so
 * top-level vi.fn() variables would be undefined inside the factory.
 * vi.hoisted() runs before hoisting, making mockGet/mockRequest available
 * both inside the vi.mock factory and in the test body.
 */
const { mockGet, mockRequest } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockRequest: vi.fn(),
}));

vi.mock('http', () => ({
  default: {
    get: mockGet,
    request: mockRequest,
  },
}));

import { fetchGuest, sendMessage } from '../guestApi';

/**
 * Builds a mock http.get handler that immediately resolves with the given
 * statusCode, body string, and optional response headers.
 */
function makeGetResponse(statusCode: number, body: string, headers: Record<string, string> = {}) {
  return (_url: string, cb: Function) => {
    const res = {
      statusCode,
      headers,
      on: (event: string, handler: Function) => {
        if (event === 'data') handler(body);
        if (event === 'end') handler();
      },
    };
    cb(res);
    return { on: vi.fn() };
  };
}

/**
 * Builds a mock http.request handler that immediately resolves with the given
 * statusCode, body string, and optional response headers. The returned request
 * object exposes no-op write/end methods so the caller doesn't throw.
 */
function makePostResponse(statusCode: number, body: string, headers: Record<string, string> = {}) {
  const res = {
    statusCode,
    headers,
    on: (event: string, handler: Function) => {
      if (event === 'data') handler(body);
      if (event === 'end') handler();
    },
  };
  return (_options: object, cb: Function) => {
    cb(res);
    return {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Each test uses a unique guestId so the module-level in-memory cache
  // never masks failures between test cases.
});

describe('fetchGuest', () => {
  /**
   * Happy path: a 200 response with valid JSON should parse and return
   * a GuestInfo object with all four fields populated.
   */
  it('returns guest info on 200', async () => {
    const body = JSON.stringify({ first_name: 'Alice', last_name: 'Smith', email: 'a@b.com', phone: '123' });
    mockGet.mockImplementation(makeGetResponse(200, body));

    const result = await fetchGuest('guest-200');
    expect(result).toEqual({ first_name: 'Alice', last_name: 'Smith', email: 'a@b.com', phone: '123' });
  });

  /**
   * A 404 means the guest does not exist in the Guest API. The function
   * should return null immediately without any retry attempts.
   */
  it('returns null on 404 without retrying', async () => {
    mockGet.mockImplementation(makeGetResponse(404, 'Not Found'));

    const result = await fetchGuest('guest-404');
    expect(result).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  /**
   * A 429 response indicates rate limiting. The function should read the
   * Retry-After header, wait the specified duration, then retry. Fake timers
   * are used to avoid real delays in the test suite.
   */
  it('retries on 429 respecting Retry-After header', async () => {
    vi.useFakeTimers();

    const body = JSON.stringify({ first_name: 'Bob', last_name: 'Jones', email: 'b@c.com', phone: '456' });
    mockGet
      .mockImplementationOnce(makeGetResponse(429, '', { 'retry-after': '1' }))
      .mockImplementationOnce(makeGetResponse(200, body));

    const fetchPromise = fetchGuest('guest-429');
    await vi.runAllTimersAsync();
    const result = await fetchPromise;

    expect(result).toEqual({ first_name: 'Bob', last_name: 'Jones', email: 'b@c.com', phone: '456' });
    expect(mockGet).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  /**
   * Persistent 5xx errors should be retried with exponential backoff up to
   * MAX_RETRIES times (5), then return null. Total call count = 6 (1 + 5).
   */
  it('returns null after exhausting retries on 500', async () => {
    vi.useFakeTimers();

    mockGet.mockImplementation(makeGetResponse(500, 'Server Error'));

    const fetchPromise = fetchGuest('guest-500');
    await vi.runAllTimersAsync();
    const result = await fetchPromise;

    expect(result).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(6); // 1 initial + 5 retries
    vi.useRealTimers();
  });
});

describe('sendMessage', () => {
  /**
   * Happy path: a 200 response means the message was delivered successfully.
   */
  it('returns 200 on success', async () => {
    mockRequest.mockImplementation(makePostResponse(200, 'OK'));

    const result = await sendMessage('guest-msg-200', 'Hello');
    expect(result).toEqual({ statusCode: 200 });
  });

  /**
   * A 404 means the guest does not exist. This is a permanent failure and
   * the function should return immediately without retrying.
   */
  it('returns 404 without retrying for non-existent guest', async () => {
    mockRequest.mockImplementation(makePostResponse(404, 'Not Found'));

    const result = await sendMessage('guest-msg-404', 'Hello');
    expect(result).toEqual({ statusCode: 404 });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  /**
   * A 400 means the request payload was invalid (e.g. missing message field).
   * This is a permanent client error and should not be retried.
   */
  it('returns 400 without retrying on bad request', async () => {
    mockRequest.mockImplementation(makePostResponse(400, 'Bad Request'));

    const result = await sendMessage('guest-msg-400', '');
    expect(result).toEqual({ statusCode: 400 });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  /**
   * A 429 indicates rate limiting. The function should wait the Retry-After
   * duration and retry. Fake timers prevent real delays in the test suite.
   */
  it('retries on 429 then succeeds', async () => {
    vi.useFakeTimers();

    mockRequest
      .mockImplementationOnce(makePostResponse(429, '', { 'retry-after': '1' }))
      .mockImplementationOnce(makePostResponse(200, 'OK'));

    const sendPromise = sendMessage('guest-msg-429', 'Hello');
    await vi.runAllTimersAsync();
    const result = await sendPromise;

    expect(result).toEqual({ statusCode: 200 });
    expect(mockRequest).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
