import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RENDER = "1";

const { handlePublicFeedProxyRequest } = await import("./public-feed-proxy.mjs");

const originalFetch = global.fetch;
const originalEnv = {
  WORDPRESS_SITE_URL: process.env.WORDPRESS_SITE_URL,
  WOOCOMMERCE_CONSUMER_KEY: process.env.WOOCOMMERCE_CONSUMER_KEY,
  WOOCOMMERCE_CONSUMER_SECRET: process.env.WOOCOMMERCE_CONSUMER_SECRET,
  WORDPRESS_USERNAME: process.env.WORDPRESS_USERNAME,
  WORDPRESS_APP_PASSWORD: process.env.WORDPRESS_APP_PASSWORD,
};

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function jsonFetchResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function createRequest({ method = "GET", url = "/", body = {} } = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];

  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function createResponse() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? "";
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

describe("public feed proxy account endpoints", () => {
  beforeEach(() => {
    process.env.WORDPRESS_SITE_URL = "https://example.test";
    process.env.WOOCOMMERCE_CONSUMER_KEY = "ck_read";
    process.env.WOOCOMMERCE_CONSUMER_SECRET = "cs_read";
    process.env.WORDPRESS_USERNAME = "admin@example.test";
    process.env.WORDPRESS_APP_PASSWORD = "wp-app-password";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("retries account creation with WordPress app-password auth when WooCommerce keys cannot create customers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonFetchResponse(
          { message: "Sorry, you are not allowed to create resources." },
          403,
        ),
      )
      .mockResolvedValueOnce(
        jsonFetchResponse(
          {
            id: 123,
            email: "andy@example.test",
            first_name: "Andy",
            last_name: "Lomax",
            billing: {
              first_name: "Andy",
              last_name: "Lomax",
              email: "andy@example.test",
              phone: "+44 7832 878369",
              country: "TH",
            },
            shipping: {
              first_name: "Andy",
              last_name: "Lomax",
              country: "TH",
            },
          },
          201,
        ),
      );
    global.fetch = fetchMock;
    const response = createResponse();

    await handlePublicFeedProxyRequest(
      createRequest({
        method: "POST",
        url: "/api/auth/register",
        body: {
          firstName: "Andy",
          lastName: "Lomax",
          email: "andy@example.test",
          phone: "+44 7832 878369",
          password: "secret-password",
        },
      }),
      response,
    );

    expect(response.status).toBe(200);
    expect(response.json().sessionToken).toMatch(/^rps_/);
    expect(response.json().customer).toMatchObject({
      id: 123,
      email: "andy@example.test",
      firstName: "Andy",
      lastName: "Lomax",
      phone: "+44 7832 878369",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      basicAuth("ck_read", "cs_read"),
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
      basicAuth("admin@example.test", "wp-app-password"),
    );
  });
});
