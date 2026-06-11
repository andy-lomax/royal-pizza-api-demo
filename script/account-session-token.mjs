import crypto from "node:crypto";

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function signPayload(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function publicCustomerSession(customer = {}) {
  return {
    id: numberValue(customer.id),
    email: textValue(customer.email),
    firstName: textValue(customer.firstName),
    lastName: textValue(customer.lastName),
    phone: textValue(customer.phone),
    ...(textValue(customer.notificationDeviceId)
      ? { notificationDeviceId: textValue(customer.notificationDeviceId) }
      : {}),
    billingAddress: customer.billingAddress ?? {},
    shippingAddress: customer.shippingAddress ?? {},
    emailVerified: Boolean(customer.emailVerified),
  };
}

export function createAccountSessionToken({ customer, secret, issuedAt = Date.now() }) {
  if (!secret) {
    throw new Error("Account session token secret is required.");
  }

  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      iat: issuedAt,
      customer: publicCustomerSession(customer),
    }),
  ).toString("base64url");
  const signature = signPayload(payload, secret);

  return `rps_${payload}.${signature}`;
}

export function restoreAccountSessionToken(token, { secret }) {
  if (!secret || !textValue(token).startsWith("rps_")) {
    return null;
  }

  const [payload, signature] = textValue(token).slice(4).split(".");

  if (!payload || !signature || !timingSafeEqual(signPayload(payload, secret), signature)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const customer = publicCustomerSession(decoded?.customer);

    return decoded?.v === 1 && customer.email ? { customer } : null;
  } catch {
    return null;
  }
}
