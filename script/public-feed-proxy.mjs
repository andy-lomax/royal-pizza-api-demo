#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  appAddressPayload,
  appShippingAddressPayload,
  buildWooCustomerUpdatePayload,
  normalizeWooCustomerProfile,
} from "./account-profile-sync.mjs";
import {
  loadAccountSessions,
  saveAccountSessions,
} from "./account-session-store.mjs";
import { notifyAcceptedOrder } from "./order-notifications.mjs";

const port = Number(process.env.PUBLIC_FEED_PROXY_PORT || process.env.PORT || 8091);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeTempDir = process.env.VERCEL || process.env.RENDER ? "/tmp" : projectRoot;
const accountSessionFile = path.join(
  runtimeTempDir,
  ".royal-pizza-account-sessions.local.json",
);
const allowedPrefixes = [
  "/wp-json/wc/store/v1/",
  "/wp-json/wcsdm-ml/v1/",
];
const accountSessions = loadAccountSessions(accountSessionFile);

function parseEnvValue(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if ((quote === "'" || quote === '"') && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadLocalEnv() {
  try {
    const env = fs.readFileSync(path.join(projectRoot, ".env"), "utf8");

    for (const line of env.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();

      if (!key || process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = parseEnvValue(trimmed.slice(separatorIndex + 1));
    }
  } catch {
    // The proxy can still serve public feeds without local secrets.
  }
}

function sendJson(response, status, body, extraHeaders = {}, method = "GET") {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Authorization",
    ...extraHeaders,
    "Content-Type": "application/json",
  });
  response.end(method === "HEAD" ? undefined : JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function requireEnv(key) {
  const value = process.env[key];

  if (!value) {
    throw new Error(`${key} is required for the local WooCommerce menu feed.`);
  }

  return value;
}

function siteUrl() {
  return (process.env.WORDPRESS_SITE_URL || "https://www.royalpizza.co.th").replace(
    /\/+$/,
    "",
  );
}

function textValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === "string" ? value.trim() : "";
}

function emailValue(value) {
  return textValue(value).toLowerCase();
}

function numberParam(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function numericText(value) {
  const normalized = textValue(value).replace(/[^\d.-]/g, "");

  if (!normalized) {
    return "";
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : "";
}

function bearerToken(request) {
  const authorization = request.headers.authorization ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

function sessionCustomer(request) {
  const token = bearerToken(request);
  const session = token ? accountSessions.get(token) : undefined;

  return session?.customer;
}

function persistAccountSessions() {
  try {
    saveAccountSessions(accountSessionFile, accountSessions);
  } catch (error) {
    console.warn(
      `Could not persist local account sessions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function createSession({ customer, jwtToken = "" }) {
  const token = `rp_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 12)}`;

  accountSessions.set(token, { customer, jwtToken });
  persistAccountSessions();
  return token;
}

function normalizeWooCustomer(customer, fallback = {}) {
  return normalizeWooCustomerProfile(customer, fallback);
}

async function jwtLogin({ email, password }) {
  const upstreamResponse = await fetch(new URL("/wp-json/jwt-auth/v1/token", siteUrl()), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: email,
      password,
    }),
  });
  const body = await upstreamResponse.json().catch(() => ({}));

  if (!upstreamResponse.ok || !body?.token) {
    throw new Error(textValue(body?.message) || "The email or password was not recognised.");
  }

  return {
    token: textValue(body.token),
    email: emailValue(body.user_email) || email,
    firstName: textValue(body.user_display_name).split(" ")[0] || "",
    lastName: textValue(body.user_display_name).split(" ").slice(1).join(" "),
  };
}

async function fetchWooCustomerByEmail(email) {
  const url = new URL("/wp-json/wc/v3/customers", siteUrl());
  url.searchParams.set("email", email);
  url.searchParams.set("per_page", "1");

  const upstreamResponse = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: menuFeedAuthorization(),
    },
  });
  const body = await upstreamResponse.json().catch(() => []);

  if (!upstreamResponse.ok) {
    throw new Error(textValue(body?.message) || "Could not load WooCommerce customer.");
  }

  return Array.isArray(body) ? body[0] : undefined;
}

async function fetchWooCustomerById(customerId) {
  const upstreamResponse = await fetch(
    new URL(`/wp-json/wc/v3/customers/${encodeURIComponent(customerId)}`, siteUrl()),
    {
      headers: {
        Accept: "application/json",
        Authorization: menuFeedAuthorization(),
      },
    },
  );
  const body = await upstreamResponse.json().catch(() => ({}));

  if (!upstreamResponse.ok) {
    throw new Error(textValue(body?.message) || "Could not load WooCommerce customer.");
  }

  return body;
}

function normalizeWooOrder(order) {
  return {
    id: Number(order?.id) || 0,
    number: textValue(order?.number) || String(order?.id ?? ""),
    date: textValue(order?.date_created),
    status: textValue(order?.status),
    total: `฿${numericText(order?.total) || "0"}`,
    items: Array.isArray(order?.line_items)
      ? order.line_items.map((item) => textValue(item?.name)).filter(Boolean)
      : [],
    deliveryType:
      textValue(order?.shipping_lines?.[0]?.method_title) ||
      textValue(order?.meta_data?.find((meta) => meta?.key === "delivery_type")?.value) ||
      "Delivery",
    billingAddress: appAddressPayload(order?.billing ?? {}),
    shippingAddress: appShippingAddressPayload(order?.shipping ?? {}),
  };
}

function wordpressAccountAuthorization() {
  return `Basic ${Buffer.from(
    `${requireEnv("WORDPRESS_USERNAME")}:${requireEnv("WORDPRESS_APP_PASSWORD")}`,
  ).toString("base64")}`;
}

function unavailableLoyaltyPoints(message) {
  return {
    value: 0,
    label: "",
    poolId: "",
    available: false,
    message,
  };
}

function normalizeMyRewardsPoints(body, poolId) {
  if (body?.available === false) {
    return unavailableLoyaltyPoints(
      textValue(body?.message) || "MyRewards points are not available yet.",
    );
  }

  const rawValue = numericText(body?.value);

  if (!rawValue) {
    return unavailableLoyaltyPoints("MyRewards points are not available yet.");
  }

  const value = Number(rawValue);
  const label = textValue(body?.label) || `${value.toLocaleString("en-US")} Royal Points`;

  return {
    value,
    label,
    poolId: textValue(body?.id) || poolId,
    available: true,
    message: "",
  };
}

async function fetchMyRewardsPoints(customer) {
  const email = emailValue(customer?.email);

  if (!email) {
    return unavailableLoyaltyPoints("Customer email is required for loyalty points.");
  }

  const url = new URL("/wp-json/wcsdm-ml/v1/loyalty-points", siteUrl());
  url.searchParams.set("email", email);

  if (process.env.MYREWARDS_POINTS_POOL_ID) {
    url.searchParams.set("stack", process.env.MYREWARDS_POINTS_POOL_ID);
  }

  const upstreamResponse = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: wordpressAccountAuthorization(),
    },
  });
  const body = await upstreamResponse.json().catch(() => ({}));

  if (upstreamResponse.status === 403 || upstreamResponse.status === 404) {
    return unavailableLoyaltyPoints(
      textValue(body?.message) || "MyRewards points are not available yet.",
    );
  }

  if (!upstreamResponse.ok) {
    return unavailableLoyaltyPoints(
      textValue(body?.message) || "Could not load MyRewards points.",
    );
  }

  return normalizeMyRewardsPoints(body, textValue(body?.poolId));
}

async function fetchWooOrders(params) {
  const url = new URL("/wp-json/wc/v3/orders", siteUrl());
  url.searchParams.set("per_page", "20");
  url.searchParams.set("orderby", "date");
  url.searchParams.set("order", "desc");

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, String(value));
    }
  }

  const upstreamResponse = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: menuFeedAuthorization(),
    },
  });
  const body = await upstreamResponse.json().catch(() => []);

  if (!upstreamResponse.ok) {
    throw new Error(textValue(body?.message) || "Could not load WooCommerce orders.");
  }

  return Array.isArray(body) ? body.map(normalizeWooOrder) : [];
}

async function fetchWooCustomerOrders(customer) {
  const orderGroups = [];

  if (customer.id) {
    orderGroups.push(await fetchWooOrders({ customer: customer.id }));
  }

  if (customer.email) {
    orderGroups.push(await fetchWooOrders({ search: customer.email }));
  }

  const mergedOrders = new Map();

  for (const order of orderGroups.flat()) {
    if (order.id) {
      mergedOrders.set(order.id, order);
    }
  }

  return [...mergedOrders.values()];
}

async function createWooCustomer({ firstName, lastName, email, phone, password }) {
  const upstreamResponse = await fetch(new URL("/wp-json/wc/v3/customers", siteUrl()), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: menuFeedAuthorization(),
    },
    body: JSON.stringify({
      email,
      first_name: firstName,
      last_name: lastName,
      username: email,
      password,
      billing: {
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        country: "TH",
      },
      shipping: {
        first_name: firstName,
        last_name: lastName,
        country: "TH",
      },
    }),
  });
  const body = await upstreamResponse.json().catch(() => ({}));

  if (!upstreamResponse.ok) {
    throw new Error(textValue(body?.message) || "Could not create WooCommerce customer.");
  }

  return body;
}

async function updateWooCustomer(customer) {
  const customerId = Number(customer?.id) || 0;

  if (!customerId) {
    throw new Error("WooCommerce customer ID is required to save account details.");
  }

  const upstreamResponse = await fetch(
    new URL(`/wp-json/wc/v3/customers/${encodeURIComponent(customerId)}`, siteUrl()),
    {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: menuFeedAuthorization(),
      },
      body: JSON.stringify(buildWooCustomerUpdatePayload(customer)),
    },
  );
  const body = await upstreamResponse.json().catch(() => ({}));

  if (!upstreamResponse.ok) {
    throw new Error(textValue(body?.message) || "Could not save WooCommerce customer.");
  }

  return body;
}

async function serveAccountEndpoint(request, response, requestUrl) {
  if (requestUrl.pathname === "/api/auth/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    const email = textValue(body.email);
    const password = textValue(body.password);

    if (!email || !password) {
      sendJson(response, 400, { message: "Email and password are required." }, {}, request.method);
      return true;
    }

    try {
      const jwt = await jwtLogin({ email, password });
      const wooCustomer = await fetchWooCustomerByEmail(jwt.email);
      const customer = normalizeWooCustomer(wooCustomer, jwt);
      const sessionToken = createSession({ customer, jwtToken: jwt.token });

      sendJson(response, 200, { sessionToken, customer }, {}, request.method);
    } catch (error) {
      sendJson(
        response,
        401,
        {
          message: error instanceof Error ? error.message : "Could not sign in.",
        },
        {},
        request.method,
      );
    }
    return true;
  }

  if (requestUrl.pathname === "/api/auth/register" && request.method === "POST") {
    const body = await readJsonBody(request);
    const email = textValue(body.email);
    const password = textValue(body.password);

    if (!email || !password) {
      sendJson(response, 400, { message: "Email and password are required." }, {}, request.method);
      return true;
    }

    try {
      const wooCustomer = await createWooCustomer({
        firstName: textValue(body.firstName),
        lastName: textValue(body.lastName),
        email,
        phone: textValue(body.phone),
        password,
      });
      const customer = {
        ...normalizeWooCustomer(wooCustomer, {
          email,
          firstName: textValue(body.firstName),
          lastName: textValue(body.lastName),
          phone: textValue(body.phone),
        }),
        emailVerified: false,
      };
      const sessionToken = createSession({ customer });

      sendJson(response, 200, { sessionToken, customer }, {}, request.method);
    } catch (error) {
      sendJson(
        response,
        400,
        {
          message: error instanceof Error ? error.message : "Could not create account.",
        },
        {},
        request.method,
      );
    }
    return true;
  }

  if (requestUrl.pathname === "/api/auth/forgot-password" && request.method === "POST") {
    await readJsonBody(request);
    sendJson(response, 200, { ok: true }, {}, request.method);
    return true;
  }

  if (requestUrl.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = bearerToken(request);

    if (token) {
      accountSessions.delete(token);
      persistAccountSessions();
    }

    sendJson(response, 200, { ok: true }, {}, request.method);
    return true;
  }

  if (requestUrl.pathname === "/api/account/me" && request.method === "GET") {
    const customer = sessionCustomer(request);

    if (!customer) {
      sendJson(response, 401, { message: "Account session required." }, {}, request.method);
      return true;
    }

    sendJson(response, 200, { customer }, {}, request.method);
    return true;
  }

  if (requestUrl.pathname === "/api/account/me" && request.method === "PATCH") {
    const customer = sessionCustomer(request);

    if (!customer) {
      sendJson(response, 401, { message: "Account session required." }, {}, request.method);
      return true;
    }

    const body = await readJsonBody(request);
    const requestedCustomer = { ...customer, ...body };

    try {
      const wooCustomer = await updateWooCustomer(requestedCustomer);
      const nextCustomer = normalizeWooCustomer(wooCustomer, requestedCustomer);

      accountSessions.set(bearerToken(request), { customer: nextCustomer });
      persistAccountSessions();
      sendJson(response, 200, { customer: nextCustomer }, {}, request.method);
    } catch (error) {
      sendJson(
        response,
        502,
        {
          message:
            error instanceof Error ? error.message : "Could not save account details.",
        },
        {},
        request.method,
      );
    }
    return true;
  }

  if (
    requestUrl.pathname === "/api/account/notification-device" &&
    request.method === "PUT"
  ) {
    const customer = sessionCustomer(request);

    if (!customer) {
      sendJson(response, 401, { message: "Account session required." }, {}, request.method);
      return true;
    }

    const body = await readJsonBody(request);
    const notificationDeviceId = textValue(body.notificationDeviceId);

    if (!notificationDeviceId) {
      sendJson(
        response,
        400,
        { message: "Notification device ID is required." },
        {},
        request.method,
      );
      return true;
    }

    const requestedCustomer = { ...customer, notificationDeviceId };

    try {
      const wooCustomer = await updateWooCustomer(requestedCustomer);
      const nextCustomer = normalizeWooCustomer(wooCustomer, requestedCustomer);

      accountSessions.set(bearerToken(request), { customer: nextCustomer });
      persistAccountSessions();
      sendJson(response, 200, { customer: nextCustomer }, {}, request.method);
    } catch (error) {
      sendJson(
        response,
        502,
        {
          message:
            error instanceof Error
              ? error.message
              : "Could not save notification device ID.",
        },
        {},
        request.method,
      );
    }
    return true;
  }

  if (requestUrl.pathname === "/api/account/orders" && request.method === "GET") {
    const customer = sessionCustomer(request);

    if (!customer) {
      sendJson(response, 401, { message: "Account session required." }, {}, request.method);
      return true;
    }

    try {
      const orders = await fetchWooCustomerOrders(customer);

      sendJson(response, 200, { orders }, {}, request.method);
    } catch (error) {
      sendJson(
        response,
        502,
        {
          message:
            error instanceof Error ? error.message : "Could not load customer orders.",
        },
        {},
        request.method,
      );
    }
    return true;
  }

  if (requestUrl.pathname === "/api/account/loyalty-points" && request.method === "GET") {
    const customer = sessionCustomer(request);

    if (!customer) {
      sendJson(response, 401, { message: "Account session required." }, {}, request.method);
      return true;
    }

    try {
      const loyaltyPoints = await fetchMyRewardsPoints(customer);

      sendJson(response, 200, { loyaltyPoints }, {}, request.method);
    } catch (error) {
      sendJson(
        response,
        200,
        {
          loyaltyPoints: unavailableLoyaltyPoints(
            error instanceof Error ? error.message : "Could not load MyRewards points.",
          ),
        },
        {},
        request.method,
      );
    }
    return true;
  }

  return false;
}

async function serveOrderStatusWebhook(request, response) {
  const order = await readJsonBody(request);
  const result = await notifyAcceptedOrder({
    order,
    fetchCustomerById: fetchWooCustomerById,
    fetchCustomerByEmail: fetchWooCustomerByEmail,
  });

  sendJson(response, 200, result, {}, request.method);
}

function menuFeedAuthorization() {
  return `Basic ${Buffer.from(
    `${requireEnv("WOOCOMMERCE_CONSUMER_KEY")}:${requireEnv(
      "WOOCOMMERCE_CONSUMER_SECRET",
    )}`,
  ).toString("base64")}`;
}

function buildWooProductsUrl({ categoryId, page, perPage }) {
  const url = new URL("/wp-json/wc/v3/products", siteUrl());

  url.searchParams.set("status", "publish");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set(
    "_fields",
    [
      "id",
      "name",
      "sku",
      "status",
      "short_description",
      "description",
      "on_sale",
      "price",
      "regular_price",
      "sale_price",
      "images",
      "categories",
    ].join(","),
  );

  if (categoryId) {
    url.searchParams.set("category", categoryId);
  }

  return url;
}

function buildWooProductUrl(productId) {
  const url = new URL(
    `/wp-json/wc/v3/products/${encodeURIComponent(productId)}`,
    siteUrl(),
  );

  url.searchParams.set("_fields", ["id", "permalink"].join(","));

  return url;
}

function buildWooCategoriesUrl({ page, perPage }) {
  const url = new URL("/wp-json/wc/v3/products/categories", siteUrl());

  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set(
    "_fields",
    ["id", "name", "slug", "count", "menu_order"].join(","),
  );

  return url;
}

function buildWooCouponsUrl(code) {
  const url = new URL("/wp-json/wc/v3/coupons", siteUrl());

  url.searchParams.set("code", code);
  url.searchParams.set("per_page", "1");
  url.searchParams.set(
    "_fields",
    [
      "code",
      "amount",
      "discount_type",
      "date_expires",
      "usage_count",
      "usage_limit",
      "minimum_amount",
      "maximum_amount",
      "product_ids",
      "excluded_product_ids",
      "individual_use",
    ].join(","),
  );

  return url;
}

function buildWooCountryUrl(country) {
  return new URL(
    `/wp-json/wc/v3/data/countries/${encodeURIComponent(country || "TH")}`,
    siteUrl(),
  );
}

function normalizeWooProduct(product) {
  const price = numericText(product.price);
  const regularPrice = numericText(product.regular_price) || price;
  const salePrice = numericText(product.sale_price) || price || regularPrice;

  return {
    id: product.id,
    name: product.name,
    sku: product.sku ?? "",
    status: product.status,
    short_description: product.short_description ?? "",
    description: product.description ?? "",
    on_sale: Boolean(product.on_sale),
    prices: {
      price: price || salePrice || regularPrice,
      regular_price: regularPrice,
      sale_price: salePrice,
      currency_code: "THB",
      currency_minor_unit: 0,
    },
    images: Array.isArray(product.images)
      ? product.images.map((image) => ({
          src: image?.src ?? "",
          thumbnail: image?.thumbnail ?? image?.src ?? "",
        }))
      : [],
    categories: Array.isArray(product.categories)
      ? product.categories.map((category) => ({
          id: category?.id,
          name: category?.name,
          slug: category?.slug,
        }))
      : [],
  };
}

function normalizeWooCategory(category) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    count: category.count,
    menu_order: category.menu_order,
  };
}

async function fetchWooProductPermalink(productId) {
  const upstreamResponse = await fetch(buildWooProductUrl(productId), {
    headers: {
      Accept: "application/json",
      Authorization: menuFeedAuthorization(),
    },
  });

  if (!upstreamResponse.ok) {
    throw new Error(
      `WooCommerce product request failed with HTTP ${upstreamResponse.status}.`,
    );
  }

  const product = await upstreamResponse.json();
  return textValue(product?.permalink);
}

async function fetchWooProductsPage({ categoryId, page, perPage }) {
  const upstreamResponse = await fetch(
    buildWooProductsUrl({ categoryId, page, perPage }),
    {
      headers: {
        Accept: "application/json",
        Authorization: menuFeedAuthorization(),
      },
    },
  );

  if (!upstreamResponse.ok) {
    throw new Error(
      `WooCommerce products request failed with HTTP ${upstreamResponse.status}.`,
    );
  }

  const body = await upstreamResponse.json();

  if (!Array.isArray(body)) {
    throw new Error("WooCommerce products response was not an array.");
  }

  return {
    products: body
      .filter((product) => product?.status === "publish")
      .map(normalizeWooProduct),
    total: upstreamResponse.headers.get("x-wp-total") ?? String(body.length),
    totalPages: upstreamResponse.headers.get("x-wp-totalpages") ?? "1",
  };
}

async function fetchWooCategoriesPage({ page, perPage }) {
  const upstreamResponse = await fetch(buildWooCategoriesUrl({ page, perPage }), {
    headers: {
      Accept: "application/json",
      Authorization: menuFeedAuthorization(),
    },
  });

  if (!upstreamResponse.ok) {
    throw new Error(
      `WooCommerce categories request failed with HTTP ${upstreamResponse.status}.`,
    );
  }

  const body = await upstreamResponse.json();

  if (!Array.isArray(body)) {
    throw new Error("WooCommerce categories response was not an array.");
  }

  return {
    categories: body.map(normalizeWooCategory),
    total: upstreamResponse.headers.get("x-wp-total") ?? String(body.length),
    totalPages: upstreamResponse.headers.get("x-wp-totalpages") ?? "1",
  };
}

async function fetchWooCoupon(code) {
  const upstreamResponse = await fetch(buildWooCouponsUrl(code), {
    headers: {
      Accept: "application/json",
      Authorization: menuFeedAuthorization(),
    },
  });

  if (!upstreamResponse.ok) {
    throw new Error(
      `WooCommerce coupon request failed with HTTP ${upstreamResponse.status}.`,
    );
  }

  const body = await upstreamResponse.json();

  if (!Array.isArray(body)) {
    throw new Error("WooCommerce coupon response was not an array.");
  }

  return body[0] ?? null;
}

async function fetchWooCountryRegions(country) {
  const upstreamResponse = await fetch(buildWooCountryUrl(country), {
    headers: {
      Accept: "application/json",
      Authorization: menuFeedAuthorization(),
    },
  });

  if (!upstreamResponse.ok) {
    throw new Error(
      `WooCommerce country regions request failed with HTTP ${upstreamResponse.status}.`,
    );
  }

  const body = await upstreamResponse.json();
  const states = Array.isArray(body?.states) ? body.states : [];

  return states.flatMap((state) => {
    const code = textValue(state?.code);
    const name = textValue(state?.name);

    return code && name ? [{ code, name }] : [];
  });
}

async function serveCheckoutRegions(request, response, requestUrl) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { message: "Checkout regions require GET." }, {}, request.method);
    return;
  }

  const country = textValue(requestUrl.searchParams.get("country")) || "TH";
  const regions = await fetchWooCountryRegions(country);

  sendJson(response, 200, { country, regions }, {}, request.method);
}

function couponProductIds(value) {
  return Array.isArray(value)
    ? value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];
}

function couponAppliesToCart(coupon, cart) {
  const includedProductIds = couponProductIds(coupon.product_ids);
  const excludedProductIds = couponProductIds(coupon.excluded_product_ids);
  const cartProductIds = cart.map((line) => Number(line.product_id ?? line.productId));

  if (
    excludedProductIds.length > 0 &&
    cartProductIds.some((productId) => excludedProductIds.includes(productId))
  ) {
    return false;
  }

  return (
    includedProductIds.length === 0 ||
    cartProductIds.some((productId) => includedProductIds.includes(productId))
  );
}

function couponDiscountTotal(coupon, subtotal) {
  const amount = Number(numericText(coupon.amount));

  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }

  if (coupon.discount_type === "percent") {
    return Math.min(subtotal, Math.floor((subtotal * amount) / 100));
  }

  return Math.min(subtotal, amount);
}

async function serveCheckoutCoupon(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Coupon validation requires POST." }, {}, request.method);
    return;
  }

  const body = await readJsonBody(request);
  const code = textValue(body.code);
  const subtotal = Number(body.subtotal);
  const cart = Array.isArray(body.cart) ? body.cart : [];

  if (!code) {
    sendJson(
      response,
      400,
      { valid: false, code: "", discount_total: 0, message: "Enter a coupon code." },
      {},
      request.method,
    );
    return;
  }

  const coupon = await fetchWooCoupon(code);

  if (!coupon) {
    sendJson(
      response,
      404,
      {
        valid: false,
        code: code.toUpperCase(),
        discount_total: 0,
        message: "That coupon does not exist.",
      },
      {},
      request.method,
    );
    return;
  }

  const expiresAt = textValue(coupon.date_expires);
  const usageLimit = Number(coupon.usage_limit);
  const usageCount = Number(coupon.usage_count);
  const minimumAmount = Number(numericText(coupon.minimum_amount));
  const maximumAmount = Number(numericText(coupon.maximum_amount));
  const validSubtotal = Number.isFinite(subtotal) ? subtotal : 0;

  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    sendJson(
      response,
      400,
      {
        valid: false,
        code: textValue(coupon.code).toUpperCase(),
        discount_total: 0,
        message: "This coupon has expired.",
      },
      {},
      request.method,
    );
    return;
  }

  if (Number.isFinite(usageLimit) && usageLimit > 0 && usageCount >= usageLimit) {
    sendJson(
      response,
      400,
      {
        valid: false,
        code: textValue(coupon.code).toUpperCase(),
        discount_total: 0,
        message: "This coupon has already been used.",
      },
      {},
      request.method,
    );
    return;
  }

  if (Number.isFinite(minimumAmount) && minimumAmount > 0 && validSubtotal < minimumAmount) {
    sendJson(
      response,
      400,
      {
        valid: false,
        code: textValue(coupon.code).toUpperCase(),
        discount_total: 0,
        message: `Spend ฿${minimumAmount} or more to use this coupon.`,
      },
      {},
      request.method,
    );
    return;
  }

  if (Number.isFinite(maximumAmount) && maximumAmount > 0 && validSubtotal > maximumAmount) {
    sendJson(
      response,
      400,
      {
        valid: false,
        code: textValue(coupon.code).toUpperCase(),
        discount_total: 0,
        message: `This coupon can only be used up to ฿${maximumAmount}.`,
      },
      {},
      request.method,
    );
    return;
  }

  if (!couponAppliesToCart(coupon, cart)) {
    sendJson(
      response,
      400,
      {
        valid: false,
        code: textValue(coupon.code).toUpperCase(),
        discount_total: 0,
        message: "That coupon cannot be used with the items in your basket.",
      },
      {},
      request.method,
    );
    return;
  }

  sendJson(
    response,
    200,
    {
      valid: true,
      code: textValue(coupon.code).toUpperCase(),
      discount_total: couponDiscountTotal(coupon, validSubtotal),
      message: "Coupon applied.",
    },
    {},
    request.method,
  );
}

async function fetchAllWooCategories() {
  const categories = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await fetchWooCategoriesPage({ page, perPage: 100 });

    categories.push(...result.categories);
    totalPages = numberParam(result.totalPages, page);
    page += 1;
  } while (page <= totalPages);

  return categories
    .filter((category) => numberParam(category.count, 0) > 0)
    .sort((left, right) => {
      const leftOrder = numberParam(left.menu_order, 0);
      const rightOrder = numberParam(right.menu_order, 0);

      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      return textValue(left.name).localeCompare(textValue(right.name));
    });
}

async function serveMenuProducts(request, response, requestUrl) {
  const page = numberParam(requestUrl.searchParams.get("page"), 1);
  const perPage = Math.min(numberParam(requestUrl.searchParams.get("per_page"), 100), 100);
  const categoryId = textValue(requestUrl.searchParams.get("category"));
  const result = await fetchWooProductsPage({ categoryId, page, perPage });

  sendJson(
    response,
    200,
    result.products,
    {
      "Access-Control-Expose-Headers": "X-WP-Total, X-WP-TotalPages",
      "X-WP-Total": result.total,
      "X-WP-TotalPages": result.totalPages,
    },
    request.method,
  );
}

async function serveMenuCategories(request, response) {
  const categories = await fetchAllWooCategories();

  sendJson(
    response,
    200,
    categories,
    {
      "Access-Control-Expose-Headers": "X-WP-Total, X-WP-TotalPages",
      "X-WP-Total": String(categories.length),
      "X-WP-TotalPages": "1",
    },
    request.method,
  );
}

function ppomFieldsFromBody(body) {
  const data = body?.data && typeof body.data === "object" ? body.data : {};
  const fields = body?.ppom_fields ?? body?.fields ?? data.ppom_fields ?? data.fields;

  return Array.isArray(fields) ? fields : [];
}

function normalizePpomPageConditions(conditions) {
  if (!conditions || typeof conditions !== "object") {
    return undefined;
  }

  const rules = Array.isArray(conditions.rules)
    ? conditions.rules.flatMap((rule) => {
        const elements = textValue(rule?.elements);
        const operators = textValue(rule?.operators);

        if (!elements || !operators) {
          return [];
        }

        return [
          {
            elements,
            operators,
            element_values: textValue(rule?.element_values),
          },
        ];
      })
    : [];

  if (rules.length === 0) {
    return undefined;
  }

  return {
    visibility: textValue(conditions.visibility) || "Show",
    bound: textValue(conditions.bound) || "All",
    rules,
  };
}

function extractPpomInputVars(productPageHtml) {
  const match = productPageHtml.match(
    /var\s+ppom_input_vars\s*=\s*(\{[\s\S]*?\});\s*(?:\/\/# sourceURL|<\/script>)/,
  );

  if (!match) {
    return {};
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return {};
  }
}

function ppomConditionsByDataNameFromPage(productPageHtml) {
  const ppomInputVars = extractPpomInputVars(productPageHtml);
  const conditionsByDataName = new Map();

  if (
    ppomInputVars.conditions &&
    typeof ppomInputVars.conditions === "object" &&
    !Array.isArray(ppomInputVars.conditions)
  ) {
    for (const [dataName, conditions] of Object.entries(ppomInputVars.conditions)) {
      const normalizedConditions = normalizePpomPageConditions(conditions);

      if (normalizedConditions) {
        conditionsByDataName.set(dataName, normalizedConditions);
      }
    }
  }

  const inputs = Array.isArray(ppomInputVars.ppom_inputs)
    ? ppomInputVars.ppom_inputs
    : Array.isArray(ppomInputVars.field_meta)
      ? ppomInputVars.field_meta
      : [];

  for (const input of inputs) {
    const dataName = textValue(input?.data_name);
    const normalizedConditions = normalizePpomPageConditions(input?.conditions);

    if (dataName && normalizedConditions && textValue(input?.logic).toLowerCase() === "on") {
      conditionsByDataName.set(dataName, normalizedConditions);
    }
  }

  return conditionsByDataName;
}

async function fetchPpomProductPageConditions(productId) {
  const permalink = await fetchWooProductPermalink(productId);

  if (!permalink) {
    return new Map();
  }

  const upstreamResponse = await fetch(permalink, {
    headers: {
      Accept: "text/html",
    },
  });

  if (!upstreamResponse.ok) {
    throw new Error(
      `WooCommerce product page request failed with HTTP ${upstreamResponse.status}.`,
    );
  }

  return ppomConditionsByDataNameFromPage(await upstreamResponse.text());
}

async function enrichPpomProductOptionsWithPageConditions(body, productId) {
  try {
    const conditionsByDataName = await fetchPpomProductPageConditions(productId);

    if (conditionsByDataName.size === 0) {
      return body;
    }

    for (const field of ppomFieldsFromBody(body)) {
      const conditions = conditionsByDataName.get(textValue(field?.data_name));

      if (conditions) {
        field.conditions = conditions;
      }
    }
  } catch {
    return body;
  }

  return body;
}

async function proxyPpomProductOptions(request, response, productId) {
  const secretKey = process.env.PPOM_SECRET_KEY;

  if (!secretKey) {
    sendJson(response, 500, { error: "PPOM proxy is not configured." });
    return;
  }

  const upstreamUrl = new URL(
    "/wp-json/ppom/v1/get/product",
    "https://www.royalpizza.co.th",
  );
  upstreamUrl.searchParams.set("product_id", productId);
  upstreamUrl.searchParams.set("secret_key", secretKey);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
      },
    });
    const body = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      response.writeHead(upstreamResponse.status, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Accept, Content-Type",
        "Content-Type":
          upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    const jsonBody = await enrichPpomProductOptionsWithPageConditions(
      JSON.parse(body),
      productId,
    );

    sendJson(response, 200, jsonBody, {}, request.method);
  } catch (error) {
    sendJson(response, 502, {
      error: error instanceof Error ? error.message : "PPOM options proxy failed.",
    });
  }
}

async function proxyPublicFeed(request, response, upstreamPath, search) {
  const upstreamUrl = new URL(upstreamPath, "https://www.royalpizza.co.th");
  upstreamUrl.search = search;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
      },
    });
    const body = await upstreamResponse.text();

    response.writeHead(upstreamResponse.status, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Access-Control-Expose-Headers": "X-WP-Total, X-WP-TotalPages",
      "Content-Type":
        upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
      "X-WP-Total": upstreamResponse.headers.get("x-wp-total") ?? "",
      "X-WP-TotalPages": upstreamResponse.headers.get("x-wp-totalpages") ?? "",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    sendJson(response, 502, {
      error: error instanceof Error ? error.message : "Public feed proxy failed.",
    });
  }
}

loadLocalEnv();

export async function handlePublicFeedProxyRequest(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type, Authorization",
    });
    response.end();
    return;
  }

  if (!["GET", "HEAD", "POST", "PATCH", "PUT"].includes(request.method ?? "") || !request.url) {
    sendJson(response, 405, { error: "Request method is not supported." });
    return;
  }

  const requestUrl = new URL(request.url, `http://localhost:${port}`);

  if (requestUrl.pathname === "/" || requestUrl.pathname === "/health") {
    sendJson(
      response,
      200,
      {
        ok: true,
        service: "royal-pizza-api",
      },
      {},
      request.method,
    );
    return;
  }

  if (requestUrl.pathname.startsWith("/api/auth/") || requestUrl.pathname.startsWith("/api/account/")) {
    if (await serveAccountEndpoint(request, response, requestUrl)) {
      return;
    }
  }

  if (requestUrl.pathname === "/api/woocommerce/order-status" && request.method === "POST") {
    try {
      await serveOrderStatusWebhook(request, response);
    } catch (error) {
      sendJson(
        response,
        502,
        {
          sent: false,
          message:
            error instanceof Error
              ? error.message
              : "Order status notification failed.",
        },
        {},
        request.method,
      );
    }

    return;
  }

  if (requestUrl.pathname === "/api/checkout/coupon") {
    try {
      await serveCheckoutCoupon(request, response);
    } catch (error) {
      sendJson(
        response,
        502,
        {
          valid: false,
          code: "",
          discount_total: 0,
          message:
            error instanceof Error ? error.message : "WooCommerce coupon validation failed.",
        },
        {},
        request.method,
      );
    }

    return;
  }

  if (requestUrl.pathname === "/api/checkout/regions") {
    try {
      await serveCheckoutRegions(request, response, requestUrl);
    } catch (error) {
      sendJson(
        response,
        502,
        {
          country: textValue(requestUrl.searchParams.get("country")) || "TH",
          regions: [],
          message:
            error instanceof Error ? error.message : "WooCommerce checkout regions failed.",
        },
        {},
        request.method,
      );
    }

    return;
  }

  const menuFeedMatch = requestUrl.pathname.match(/^\/api\/menu\/(categories|products)\/?$/);

  if (menuFeedMatch) {
    try {
      if (menuFeedMatch[1] === "categories") {
        await serveMenuCategories(request, response);
      } else {
        await serveMenuProducts(request, response, requestUrl);
      }
    } catch (error) {
      sendJson(
        response,
        502,
        {
          error:
            error instanceof Error ? error.message : "WooCommerce menu feed failed.",
        },
        {},
        request.method,
      );
    }

    return;
  }

  const productOptionsMatch = requestUrl.pathname.match(
    /^\/api\/menu\/products\/(\d+)\/options\/?$/,
  );

  if (productOptionsMatch) {
    await proxyPpomProductOptions(request, response, productOptionsMatch[1]);
    return;
  }

  if (!allowedPrefixes.some((prefix) => requestUrl.pathname.startsWith(prefix))) {
    sendJson(response, 404, { error: "Unsupported public feed path." });
    return;
  }

  await proxyPublicFeed(request, response, requestUrl.pathname, requestUrl.search);
}

export default handlePublicFeedProxyRequest;

function startPublicFeedProxyServer() {
  const server = http.createServer(handlePublicFeedProxyRequest);

  server.on("error", (error) => {
    if ("code" in error && error.code === "EADDRINUSE") {
      console.log(`Public feed proxy already listening on http://localhost:${port}`);
      process.exit(0);
    }

    throw error;
  });

  server.listen(port, () => {
    console.log(`Public feed proxy listening on http://localhost:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPublicFeedProxyServer();
}
