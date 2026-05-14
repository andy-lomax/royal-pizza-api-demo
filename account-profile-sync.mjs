const notificationDeviceIdMetaKey = "royal_pizza_notification_device_id";

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function emailValue(value) {
  const trimmed = textValue(value).toLowerCase();

  return trimmed.includes("@") ? trimmed : "";
}

function numericValue(value) {
  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function metaValue(customer, key) {
  const entries = Array.isArray(customer?.meta_data) ? customer.meta_data : [];
  const match = entries.find((entry) => textValue(entry?.key) === key);

  return textValue(match?.value);
}

function countryCode(value) {
  const normalized = textValue(value).toLowerCase();

  if (!normalized || normalized === "thailand" || normalized === "th") {
    return "TH";
  }

  return textValue(value);
}

function countryName(value) {
  const normalized = textValue(value).toLowerCase();

  if (!normalized || normalized === "th" || normalized === "thailand") {
    return "Thailand";
  }

  return textValue(value);
}

export function appAddressPayload(address = {}) {
  const phone = textValue(address.phone);

  return {
    company: textValue(address.company),
    country: countryName(address.country),
    address1: textValue(address.address_1 ?? address.address1),
    address2: textValue(address.address_2 ?? address.address2),
    city: textValue(address.city),
    state: textValue(address.state),
    postcode: textValue(address.postcode),
    ...(phone ? { phone } : {}),
  };
}

export function appShippingAddressPayload(address = {}) {
  return {
    ...appAddressPayload(address),
    firstName: textValue(address.first_name ?? address.firstName),
    lastName: textValue(address.last_name ?? address.lastName),
  };
}

function addressHasContent(address = {}) {
  return Boolean(
    textValue(address.address1) ||
      textValue(address.address2) ||
      textValue(address.city) ||
      textValue(address.state) ||
      textValue(address.postcode),
  );
}

export function normalizeWooCustomerProfile(customer = {}, fallback = {}) {
  const billing = customer?.billing ?? {};
  const shipping = customer?.shipping ?? {};
  const firstName =
    textValue(customer?.firstName) ||
    textValue(customer?.first_name) ||
    textValue(billing.first_name) ||
    metaValue(customer, "first_name") ||
    textValue(fallback.firstName);
  const lastName =
    textValue(customer?.lastName) ||
    textValue(customer?.last_name) ||
    textValue(billing.last_name) ||
    metaValue(customer, "last_name") ||
    textValue(fallback.lastName);
  const phone =
    textValue(billing.phone) ||
    metaValue(customer, "billing_phone") ||
    textValue(fallback.phone);
  const notificationDeviceId =
    metaValue(customer, notificationDeviceIdMetaKey) ||
    textValue(fallback.notificationDeviceId);

  return {
    id: numericValue(customer?.id) || numericValue(fallback.id),
    email:
      emailValue(customer?.email) ||
      emailValue(billing.email) ||
      emailValue(fallback.email),
    firstName,
    lastName,
    phone,
    ...(notificationDeviceId ? { notificationDeviceId } : {}),
    emailVerified: true,
    billingAddress: appAddressPayload(billing),
    shippingAddress: appShippingAddressPayload(shipping),
  };
}

function wooAddressPayload(address = {}, customer = {}) {
  return {
    first_name: textValue(customer.firstName),
    last_name: textValue(customer.lastName),
    company: textValue(address.company),
    country: countryCode(address.country),
    address_1: textValue(address.address1),
    address_2: textValue(address.address2),
    city: textValue(address.city),
    state: textValue(address.state),
    postcode: textValue(address.postcode),
  };
}

export function buildWooCustomerUpdatePayload(customer) {
  const email = textValue(customer.email);
  const billingAddress = customer.billingAddress ?? {};
  const shippingAddress = customer.shippingAddress ?? {};
  const notificationDeviceId = textValue(customer.notificationDeviceId);
  const payload = {
    email,
    first_name: textValue(customer.firstName),
    last_name: textValue(customer.lastName),
    billing: {
      ...wooAddressPayload(billingAddress, customer),
      email,
      phone: textValue(customer.phone),
    },
  };

  if (addressHasContent(shippingAddress)) {
    payload.shipping = {
      ...wooAddressPayload(shippingAddress, {
        firstName: shippingAddress.firstName || customer.firstName,
        lastName: shippingAddress.lastName || customer.lastName,
      }),
    };
  }

  if (notificationDeviceId) {
    payload.meta_data = [
      {
        key: notificationDeviceIdMetaKey,
        value: notificationDeviceId,
      },
    ];
  }

  return payload;
}
