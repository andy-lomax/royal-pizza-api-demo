const notificationDeviceIdMetaKey = "royal_pizza_notification_device_id";
const expoPushUrl = "https://exp.host/--/api/v2/push/send";

function textValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === "string" ? value.trim() : "";
}

function normalizedStatus(value) {
  return textValue(value).replace(/^wc-/, "").toLowerCase();
}

function previousOrderStatus(order) {
  return (
    order?.previous_status ??
    order?.previousStatus ??
    order?.old_status ??
    order?.oldStatus ??
    order?.status_from ??
    order?.statusFrom
  );
}

export function shouldSendAcceptedOrderNotification(order = {}) {
  const status = normalizedStatus(order.status);

  if (status !== "accepted") {
    return false;
  }

  return normalizedStatus(previousOrderStatus(order)) !== "accepted";
}

export function notificationDeviceIdFromCustomer(customer = {}) {
  const entries = Array.isArray(customer?.meta_data) ? customer.meta_data : [];
  const match = entries.find(
    (entry) => textValue(entry?.key) === notificationDeviceIdMetaKey,
  );

  return textValue(match?.value);
}

export function acceptedOrderNotificationPayload(notificationDeviceId, order = {}) {
  return {
    to: notificationDeviceId,
    sound: "default",
    title: "Order accepted",
    body: "The restaurant has got your order and sent it to our kitchen.",
    data: {
      event: "order.accepted",
      orderId: Number(order?.id) || 0,
      orderNumber: textValue(order?.number) || textValue(order?.id),
    },
  };
}

export async function sendAcceptedOrderNotification({
  notificationDeviceId,
  order,
  fetcher = fetch,
}) {
  const response = await fetcher(expoPushUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      acceptedOrderNotificationPayload(notificationDeviceId, order),
    ),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      textValue(body?.errors?.[0]?.message) ||
        textValue(body?.message) ||
        `Expo push request failed with HTTP ${response.status}.`,
    );
  }

  return { sent: true };
}

function orderCustomerId(order = {}) {
  return Number(order?.customer_id ?? order?.customerId) || 0;
}

function orderBillingEmail(order = {}) {
  return textValue(order?.billing?.email);
}

export async function notifyAcceptedOrder({
  order,
  fetchCustomerById,
  fetchCustomerByEmail,
  sendNotification = sendAcceptedOrderNotification,
}) {
  if (!shouldSendAcceptedOrderNotification(order)) {
    return { sent: false, reason: "order-status-not-accepted" };
  }

  const customerId = orderCustomerId(order);
  const billingEmail = orderBillingEmail(order);
  const customer = customerId
    ? await fetchCustomerById(customerId)
    : billingEmail && fetchCustomerByEmail
      ? await fetchCustomerByEmail(billingEmail)
      : undefined;
  const notificationDeviceId = notificationDeviceIdFromCustomer(customer);

  if (!notificationDeviceId) {
    return { sent: false, reason: "missing-notification-device-id" };
  }

  await sendNotification({ notificationDeviceId, order });

  return { sent: true };
}
