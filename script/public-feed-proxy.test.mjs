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
  PPOM_SECRET_KEY: process.env.PPOM_SECRET_KEY,
};

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function jsonFetchResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {
      get: () => null,
    },
  };
}

function textFetchResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
    headers: {
      get: () => null,
    },
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
    process.env.PPOM_SECRET_KEY = "ppom-secret";
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

  it("exposes PPOM metadata from the authenticated WooCommerce product feed", async () => {
    const fetchMock = vi.fn(async (url) => {
      const requestUrl = String(url);

      if (requestUrl.includes("/wp-json/wc/v3/products?")) {
        return jsonFetchResponse([
          {
            id: 114601,
            name: "Bogo Pizza Duo and Coca Cola",
            price: "349",
            regular_price: "349",
            sale_price: "349",
            images: [],
            categories: [{ id: 22, name: "Royal Pizza Promotions", slug: "promotions" }],
            meta_data: [{ key: "_product_meta_id", value: "626" }],
          },
        ]);
      }

      throw new Error(`Unexpected request ${requestUrl}`);
    });
    global.fetch = fetchMock;
    const response = createResponse();

    await handlePublicFeedProxyRequest(
      createRequest({ method: "GET", url: "/api/menu/products?per_page=1&page=1" }),
      response,
    );

    expect(response.status).toBe(200);
    expect(response.json()[0]).toEqual(
      expect.objectContaining({
        id: 114601,
        ppom_meta_ids: ["626"],
        ppom_lookup_known: true,
      }),
    );
  });

  it("serves bulk PPOM option sets once per unique meta id", async () => {
    const fetchMock = vi.fn(async (url) => {
      const requestUrl = String(url);

      if (requestUrl.includes("/wp-json/ppom/v1/get/id/4")) {
        return jsonFetchResponse({
          status: true,
          meta_id: 4,
          ppom_fields: [
            {
              title: "Pizza Size",
              type: "radio",
              data_name: "pizza_size",
              options: [{ option: "10 Inch", id: "10", price: "" }],
            },
          ],
        });
      }

      if (requestUrl.includes("/wp-json/wc/v3/products/705")) {
        return jsonFetchResponse({
          id: 705,
          permalink: "https://example.test/product/pizza",
        });
      }

      if (requestUrl === "https://example.test/product/pizza") {
        return textFetchResponse("<html><script>var ppom_input_vars = {};</script></html>");
      }

      throw new Error(`Unexpected request ${requestUrl}`);
    });
    global.fetch = fetchMock;
    const response = createResponse();

    await handlePublicFeedProxyRequest(
      createRequest({
        method: "GET",
        url: "/api/menu/option-sets?sets=4:705,4:102212",
      }),
      response,
    );

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      optionSets: {
        "ppom:4": {
          metaId: "4",
          representativeProductId: "705",
          ppom_fields: [
            {
              title: "Pizza Size",
              type: "radio",
              data_name: "pizza_size",
              options: [{ option: "10 Inch", id: "10", price: "" }],
            },
          ],
        },
      },
      errors: {},
    });
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/wp-json/ppom/v1/get/id/4"),
      ),
    ).toHaveLength(1);
  });

  it("falls back to rendered product page PPOM fields when PPOM REST option sets are unavailable", async () => {
    const productPageHtml = `
      <div id="ppom-box-626" class="ppom-wrapper">
        <input type="hidden" name="ppom[fields][id]" value="626">
        <input
          type="radio"
          name="ppom[fields][jun26_01_select_8_pizza]"
          class="radio ppom-input ppom-required"
          value="Double Cheese"
          data-price=""
          data-optionid="1"
          data-label="Double Cheese"
          data-title="Select 8&quot; Pizza"
          data-data_name="jun26_01_select_8_pizza"
          checked="checked"
        >
        <input
          type="radio"
          name="ppom[fields][jun26_01_select_8_pizza]"
          class="radio ppom-input ppom-required"
          value="Garlic Cheese"
          data-price="20"
          data-optionid="2"
          data-label="Garlic Cheese"
          data-title="Select 8&quot; Pizza"
          data-data_name="jun26_01_select_8_pizza"
        >
      </div>
    `;
    const fetchMock = vi.fn(async (url) => {
      const requestUrl = String(url);

      if (requestUrl.includes("/wp-json/ppom/v1/get/id/626")) {
        return jsonFetchResponse({ message: "No route was found" }, 404);
      }

      if (requestUrl.includes("/wp-json/wc/v3/products/114601")) {
        return jsonFetchResponse({
          id: 114601,
          permalink: "https://example.test/product/bogo",
        });
      }

      if (requestUrl === "https://example.test/product/bogo") {
        return textFetchResponse(productPageHtml);
      }

      throw new Error(`Unexpected request ${requestUrl}`);
    });
    global.fetch = fetchMock;
    const response = createResponse();

    await handlePublicFeedProxyRequest(
      createRequest({
        method: "GET",
        url: "/api/menu/option-sets?sets=626:114601",
      }),
      response,
    );

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      optionSets: {
        "ppom:626": {
          metaId: "626",
          representativeProductId: "114601",
          ppom_fields: [
            {
              title: 'Select 8" Pizza',
              type: "radio",
              data_name: "jun26_01_select_8_pizza",
              required: true,
              options: [
                { option: "Double Cheese", id: "1", price: "", selected: true },
                { option: "Garlic Cheese", id: "2", price: "20" },
              ],
            },
          ],
        },
      },
      errors: {},
    });
  });
});
